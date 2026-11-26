-- 0226: payment exceptions (H1 / OEL-02, docs/repair-tracker.md).
--
-- Problem: a Paystack payment that is captured but cannot become a ticket
-- (the tier sold out between paying and finalizing, the event ended or was
-- cancelled, an amount mismatch, an unknown reference) was only written to
-- a server log. The buyer saw "No matching order", nothing created a
-- refund, and no admin could see it.
--
-- This migration RECORDS every such payment and makes it visible to admins.
-- It does NOT refund anything, move money, or change a ticket, wallet,
-- earning or fee: how refunds for these are authorized is owner decision D4.
--
-- Objects:
--   payment_exceptions                    one row per Paystack reference
--   record_payment_exception(...)         server only (project_admin); idempotent
--   mark_payment_exception_ticketed(ref)  server only; closes the row if a
--                                         later retry did issue the ticket
--   admin_list_payment_exceptions(...)    admins (is_admin)
--   admin_resolve_payment_exception(...)  Admin/Root (is_super_admin), note
--                                         required, written to admin_logs
--
-- Additive only: no existing object is altered. Undo: supabase/rollback/undo_0226.sql.

BEGIN;

CREATE TABLE public.payment_exceptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL UNIQUE,      -- the reference Paystack charged
  payment_ref     text,                      -- resolved pending_purchases.payment_ref, if any
  kind            text NOT NULL DEFAULT 'ticket_purchase' CHECK (kind IN ('ticket_purchase')),
  reason          text NOT NULL CHECK (reason IN ('not_found', 'amount_mismatch')),
  detail          text,                      -- e.g. why finalize refused (sold out, ended)
  amount_kobo     bigint NOT NULL CHECK (amount_kobo >= 0),
  expected_kobo   bigint,
  user_id         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  event_id        uuid REFERENCES public.events(id) ON DELETE SET NULL,
  source          text NOT NULL CHECK (source IN ('verify', 'webhook')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ticket_issued', 'resolved')),
  resolution_note text,
  resolved_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  seen_count      integer NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_exceptions_resolution_ck CHECK (
    (status = 'open' AND resolved_at IS NULL)
    OR (status IN ('ticket_issued', 'resolved') AND resolved_at IS NOT NULL)
  )
);
CREATE INDEX payment_exceptions_open_idx ON public.payment_exceptions (first_seen_at DESC) WHERE status = 'open';

ALTER TABLE public.payment_exceptions ENABLE ROW LEVEL SECURITY;
-- No policies: clients never read or write this table directly.
REVOKE ALL ON public.payment_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.payment_exceptions TO project_admin;

-- Server only. Called by api/webhook/paystack.ts (verify and signed webhook)
-- whenever a captured ticket payment could not be confirmed. Idempotent per
-- reference: a repeat (webhook retry, verify + webhook) only bumps
-- last_seen_at / seen_count and keeps the first detail. Never reopens a row
-- an admin already resolved.
CREATE OR REPLACE FUNCTION public.record_payment_exception(
  p_reference text, p_payment_ref text, p_reason text, p_detail text,
  p_amount_kobo bigint, p_expected_kobo bigint, p_source text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_user uuid;
  v_event uuid;
BEGIN
  IF p_reference IS NULL OR btrim(p_reference) = '' THEN
    RAISE EXCEPTION 'reference required';
  END IF;
  SELECT pp.user_id, pp.event_id INTO v_user, v_event
    FROM public.pending_purchases pp
   WHERE pp.payment_ref = COALESCE(NULLIF(p_payment_ref, ''), p_reference)
   LIMIT 1;

  INSERT INTO public.payment_exceptions
    (reference, payment_ref, reason, detail, amount_kobo, expected_kobo, user_id, event_id, source)
  VALUES
    (p_reference, NULLIF(p_payment_ref, ''), p_reason, left(p_detail, 500), GREATEST(COALESCE(p_amount_kobo, 0), 0),
     p_expected_kobo, v_user, v_event, p_source)
  ON CONFLICT (reference) DO UPDATE
     SET last_seen_at = now(),
         seen_count   = public.payment_exceptions.seen_count + 1,
         detail       = COALESCE(public.payment_exceptions.detail, EXCLUDED.detail)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- Server only. A later verify/webhook retry that DID issue the ticket closes
-- the open row (status ticket_issued), so admins aren't chasing a payment
-- that resolved itself. No-op when there is no open row.
CREATE OR REPLACE FUNCTION public.mark_payment_exception_ticketed(p_reference text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.payment_exceptions
     SET status = 'ticket_issued', resolved_at = now(),
         resolution_note = 'Ticket issued on a later verification or webhook retry'
   WHERE reference = p_reference AND status = 'open';
  RETURN FOUND;
END;
$function$;

-- Admins: list, newest first, with the buyer and event for follow-up.
CREATE OR REPLACE FUNCTION public.admin_list_payment_exceptions(
  p_status text DEFAULT 'open', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS TABLE (
  id uuid, reference text, payment_ref text, reason text, detail text,
  amount_kobo bigint, expected_kobo bigint, source text, status text,
  resolution_note text, resolved_at timestamptz, seen_count integer,
  first_seen_at timestamptz, last_seen_at timestamptz,
  user_id uuid, buyer_username text, buyer_email text,
  event_id uuid, event_title text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'ticket_issued', 'resolved') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  RETURN QUERY
  SELECT x.id, x.reference, x.payment_ref, x.reason, x.detail,
         x.amount_kobo, x.expected_kobo, x.source, x.status,
         x.resolution_note, x.resolved_at, x.seen_count,
         x.first_seen_at, x.last_seen_at,
         x.user_id, u.username, u.email,
         x.event_id, e.title
    FROM public.payment_exceptions x
    LEFT JOIN public.users u ON u.id = x.user_id
    LEFT JOIN public.events e ON e.id = x.event_id
   WHERE p_status IS NULL OR x.status = p_status
   ORDER BY x.first_seen_at DESC, x.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$function$;

-- Admin/Root: record how an open exception was resolved (for example
-- "refunded in the Paystack dashboard, ref …"). Records only: it does not
-- refund or move money. Note required; written to admin_logs.
CREATE OR REPLACE FUNCTION public.admin_resolve_payment_exception(p_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  r public.payment_exceptions%ROWTYPE;
BEGIN
  IF NOT COALESCE(public.is_super_admin(), false) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 5 THEN
    RAISE EXCEPTION 'A resolution note is required';
  END IF;
  SELECT * INTO r FROM public.payment_exceptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment exception not found';
  END IF;
  IF r.status <> 'open' THEN
    RAISE EXCEPTION 'This payment exception is already closed';
  END IF;
  UPDATE public.payment_exceptions
     SET status = 'resolved', resolution_note = left(btrim(p_note), 1000),
         resolved_by = v_uid, resolved_at = now()
   WHERE id = p_id;
  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (v_uid, 'payment_exception_resolved',
          jsonb_build_object('payment_exception_id', p_id, 'reference', r.reference,
                             'amount_kobo', r.amount_kobo, 'note', left(btrim(p_note), 1000)),
          public.actor_role());
  RETURN jsonb_build_object('id', p_id, 'status', 'resolved');
END;
$function$;

REVOKE ALL ON FUNCTION public.record_payment_exception(text, text, text, text, bigint, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_exception(text, text, text, text, bigint, bigint, text) TO project_admin;
REVOKE ALL ON FUNCTION public.mark_payment_exception_ticketed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payment_exception_ticketed(text) TO project_admin;
REVOKE ALL ON FUNCTION public.admin_list_payment_exceptions(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_payment_exceptions(text, integer, integer) TO authenticated, project_admin;
REVOKE ALL ON FUNCTION public.admin_resolve_payment_exception(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_payment_exception(uuid, text) TO authenticated, project_admin;

COMMIT;
