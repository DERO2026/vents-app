-- 0234: two-admin refund of payments captured without a ticket (AZ-10, D4/P4).
--
-- Owner decision D4 (2026-11-26, reconfirmed 2026-11-27 as policy P4): every
-- refund of a payment charged without an issued ticket needs two separate
-- authorized admin approvals; no automatic refunds.
--
-- Flow (separate from withdrawals, which stay VENTS-Super-Admin-only, 0213):
--   1. Admin A (any admin or sub-admin) requests the refund of an OPEN
--      payment exception: amount (> 0, <= the amount Paystack captured) and a
--      reason. admin_request_payment_exception_refund files it through the
--      existing maker-checker (request_admin_action 'refund_payment_exception')
--      and binds the exception to that request.
--   2. Admin B, a Super Admin who is not A, approves it in Admin Actions
--      (approve_admin_action). The executor re-checks everything against the
--      locked exception: same reference, same amount, same reason, still
--      open, amount within what was captured, request at most 7 days old.
--      The exception becomes 'approved' with both admins and times recorded.
--   3. Only then can a Super Admin send it to Paystack
--      (api/wallet/refund-ticket.ts, payment_exception_id mode):
--      start_payment_exception_refund claims it exactly once (approved ->
--      refund_pending); the route calls Paystack's refund API for exactly the
--      approved amount; attach_payment_exception_refund_id records the
--      refund id; a definitive Paystack rejection returns it to 'approved'
--      (retryable, same approvals); an uncertain answer stays refund_pending.
--   4. The refund.processed / refund.failed webhook finalizes it
--      (finalize_ / fail_payment_exception_refund, project_admin only). A
--      processed refund resolves the exception; a failed one stays open and
--      can be requested again (new approvals).
--
-- admin_resolve_payment_exception (single Super Admin, records only) keeps
-- working for exceptions that need no refund (for example a duplicate
-- reported in error), but refuses while a refund is requested, approved or
-- in flight, so it can't close money that is mid-refund.
--
-- Prerequisites: 0226, 0233, and the maker-checker as patched by
-- 0203/0206/0207 (anchored patch; refuses if the anchors are missing).
-- Refuses if 0234 is already applied or a replaced function has drifted.
-- Rollback: supabase/rollback/undo_0234.sql.

BEGIN;

DO $pre$
DECLARE
  v_pins jsonb := '{"admin_list_payment_exceptions": "9e7cb373db3327cd27443bba4b729987",
                    "admin_resolve_payment_exception": "87be17ca4555c4a1a53792aa991b1af1"}';
  v_name text;
  v_live text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'payment_exceptions' AND column_name = 'refund_status') THEN
    RAISE EXCEPTION '0234 already applied (payment_exceptions.refund_status exists); refusing to run twice';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'payment_exceptions' AND column_name = 'transfer_id') THEN
    RAISE EXCEPTION '0234 requires 0233 (payment_exceptions.transfer_id is missing)';
  END IF;
  IF to_regprocedure('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)') IS NULL
     OR to_regprocedure('public.approve_admin_action(uuid)') IS NULL THEN
    RAISE EXCEPTION '0234 requires the maker-checker (request_admin_action / approve_admin_action)';
  END IF;
  FOR v_name IN SELECT jsonb_object_keys(v_pins) LOOP
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name;
    IF v_live IS DISTINCT FROM v_pins->>v_name THEN
      RAISE EXCEPTION '0234 refused: public.% is not the expected version (live md5 %, expected %)',
        v_name, COALESCE(v_live, 'missing'), v_pins->>v_name;
    END IF;
  END LOOP;
END
$pre$;

-- ── Refund state on each exception ───────────────────────────────────────────
ALTER TABLE public.payment_exceptions
  ADD COLUMN refund_status           text CHECK (refund_status IN ('requested', 'approved', 'refund_pending', 'refund_failed', 'refunded')),
  ADD COLUMN refund_amount_kobo      bigint,
  ADD COLUMN refund_reason           text,
  ADD COLUMN refund_admin_request_id uuid,
  ADD COLUMN refund_requested_by     uuid,
  ADD COLUMN refund_requested_at     timestamptz,
  ADD COLUMN refund_approved_by      uuid,
  ADD COLUMN refund_approved_at      timestamptz,
  ADD COLUMN refund_started_by       uuid,
  ADD COLUMN refund_started_at       timestamptz,
  ADD COLUMN refund_id               text,
  ADD COLUMN refund_completed_at     timestamptz,
  ADD COLUMN refund_error            text;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_refund_amount_ck
  CHECK (refund_amount_kobo IS NULL OR (refund_amount_kobo > 0 AND refund_amount_kobo <= amount_kobo));
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_refund_parties_ck
  CHECK (refund_approved_by IS NULL OR refund_approved_by IS DISTINCT FROM refund_requested_by);
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_refund_approved_ck
  CHECK (refund_status NOT IN ('approved', 'refund_pending', 'refunded')
         OR (refund_approved_by IS NOT NULL AND refund_requested_by IS NOT NULL AND refund_amount_kobo IS NOT NULL));
CREATE UNIQUE INDEX payment_exceptions_refund_id_idx ON public.payment_exceptions (refund_id) WHERE refund_id IS NOT NULL;

-- ── 1. Request (admin or sub-admin) ──────────────────────────────────────────
CREATE FUNCTION public.admin_request_payment_exception_refund(p_id uuid, p_amount_kobo bigint, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  x public.payment_exceptions%ROWTYPE;
  v_req jsonb;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;
  IF length(v_reason) < 5 THEN
    RAISE EXCEPTION 'A refund reason of at least 5 characters is required';
  END IF;
  SELECT * INTO x FROM public.payment_exceptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment exception not found'; END IF;
  IF x.status <> 'open' THEN RAISE EXCEPTION 'This payment exception is already closed'; END IF;
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN RAISE EXCEPTION 'The refund amount must be greater than zero'; END IF;
  IF p_amount_kobo > x.amount_kobo THEN
    RAISE EXCEPTION 'The refund cannot exceed the amount Paystack captured (% kobo)', x.amount_kobo;
  END IF;
  -- One refund at a time. A request the second admin rejected, or a refund
  -- Paystack failed, can be requested again.
  IF x.refund_status IN ('approved', 'refund_pending', 'refunded') THEN
    RAISE EXCEPTION 'A refund for this payment is already %', replace(x.refund_status, '_', ' ');
  END IF;
  IF x.refund_status = 'requested' AND EXISTS (
       SELECT 1 FROM public.admin_action_requests q WHERE q.id = x.refund_admin_request_id AND q.status = 'pending') THEN
    RAISE EXCEPTION 'A refund request for this payment is already waiting for a second admin';
  END IF;

  v_req := public.request_admin_action('refund_payment_exception', 'payment_exception', p_id,
    'refund ' || x.reference || ' (₦' || to_char(p_amount_kobo / 100.0, 'FM999,999,999,990.00') || ')',
    jsonb_build_object('payment_exception_id', p_id, 'reference', x.reference,
                       'amount_kobo', p_amount_kobo, 'captured_kobo', x.amount_kobo, 'reason', v_reason),
    NULL, NULL, NULL);

  UPDATE public.payment_exceptions
     SET refund_status = 'requested', refund_amount_kobo = p_amount_kobo, refund_reason = v_reason,
         refund_admin_request_id = (v_req->>'id')::uuid,
         refund_requested_by = auth.uid(), refund_requested_at = now(),
         refund_approved_by = NULL, refund_approved_at = NULL, refund_error = NULL
   WHERE id = p_id;
  RETURN v_req;
END;
$function$;

-- ── 2. Executor: runs only inside approve_admin_action ───────────────────────
CREATE FUNCTION public.execute_payment_exception_refund_approval(p_admin_request_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
  x public.payment_exceptions%ROWTYPE;
  v_approver uuid := auth.uid();
BEGIN
  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_admin_request_id;
  IF NOT FOUND OR r.action_type <> 'refund_payment_exception' THEN
    RAISE EXCEPTION 'Not a payment-exception refund request';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF v_approver IS NULL OR r.requested_by = v_approver THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;
  IF r.requested_at < now() - interval '7 days' THEN
    RAISE EXCEPTION 'This refund request is older than 7 days; file a new one';
  END IF;

  SELECT * INTO x FROM public.payment_exceptions WHERE id = r.target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment exception not found'; END IF;
  IF x.status <> 'open' THEN RAISE EXCEPTION 'This payment exception is already closed'; END IF;
  IF x.refund_status IS DISTINCT FROM 'requested' OR x.refund_admin_request_id IS DISTINCT FROM r.id THEN
    RAISE EXCEPTION 'This refund request is no longer the current one for this payment';
  END IF;
  IF x.refund_requested_by IS DISTINCT FROM r.requested_by THEN
    RAISE EXCEPTION 'Refund request does not match its requester';
  END IF;
  -- Both approvals are bound to the same reference, amount and reason.
  IF r.payload->>'reference' IS DISTINCT FROM x.reference
     OR (r.payload->>'amount_kobo')::bigint IS DISTINCT FROM x.refund_amount_kobo
     OR r.payload->>'reason' IS DISTINCT FROM x.refund_reason THEN
    RAISE EXCEPTION 'The refund details changed after the request; file a new one';
  END IF;
  IF x.refund_amount_kobo <= 0 OR x.refund_amount_kobo > x.amount_kobo THEN
    RAISE EXCEPTION 'The refund cannot exceed the amount Paystack captured';
  END IF;

  UPDATE public.payment_exceptions
     SET refund_status = 'approved', refund_approved_by = v_approver, refund_approved_at = now()
   WHERE id = x.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_approver, 'payment_exception_refund_approved', x.user_id,
          jsonb_build_object('payment_exception_id', x.id, 'reference', x.reference,
                             'amount_kobo', x.refund_amount_kobo, 'reason', x.refund_reason,
                             'requested_by', x.refund_requested_by, 'requested_at', x.refund_requested_at,
                             'approved_by', v_approver, 'admin_request_id', r.id),
          public.actor_role());
END;
$function$;

-- ── 3. Execution: claim exactly once, then Paystack (server route) ───────────
CREATE FUNCTION public.start_payment_exception_refund(p_payment_exception_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  x public.payment_exceptions%ROWTYPE;
BEGIN
  IF NOT COALESCE(public.is_super_admin(), false) THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  SELECT * INTO x FROM public.payment_exceptions WHERE id = p_payment_exception_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment exception not found'; END IF;
  IF x.refund_status = 'refunded' THEN
    RETURN jsonb_build_object('status', 'already_refunded');
  END IF;
  IF x.refund_status = 'refund_pending' THEN
    RAISE EXCEPTION 'This refund was already sent to Paystack';
  END IF;
  IF x.refund_status IS DISTINCT FROM 'approved' OR x.refund_approved_by IS NULL THEN
    RAISE EXCEPTION 'This refund has not been approved by two admins';
  END IF;
  IF x.status <> 'open' THEN RAISE EXCEPTION 'This payment exception is already closed'; END IF;

  UPDATE public.payment_exceptions
     SET refund_status = 'refund_pending', refund_started_by = auth.uid(), refund_started_at = now(), refund_error = NULL
   WHERE id = x.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'payment_exception_refund_started', x.user_id,
          jsonb_build_object('payment_exception_id', x.id, 'reference', x.reference, 'amount_kobo', x.refund_amount_kobo),
          public.actor_role());
  RETURN jsonb_build_object('status', 'refund_pending', 'payment_ref', x.reference, 'amount_kobo', x.refund_amount_kobo);
END;
$function$;

CREATE FUNCTION public.attach_payment_exception_refund_id(p_payment_exception_id uuid, p_refund_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NOT COALESCE(public.is_super_admin(), false) THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  IF p_refund_id IS NULL OR btrim(p_refund_id) = '' THEN RAISE EXCEPTION 'refund id required'; END IF;
  UPDATE public.payment_exceptions
     SET refund_id = p_refund_id
   WHERE id = p_payment_exception_id AND refund_status = 'refund_pending' AND refund_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No refund in flight without an id for this payment exception';
  END IF;
END;
$function$;

-- A definitive Paystack rejection (no refund was created): back to
-- 'approved', retryable with the same two approvals.
CREATE FUNCTION public.admin_revert_payment_exception_refund(p_payment_exception_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NOT COALESCE(public.is_super_admin(), false) THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  UPDATE public.payment_exceptions
     SET refund_status = 'approved', refund_error = left(p_reason, 500)
   WHERE id = p_payment_exception_id AND refund_status = 'refund_pending' AND refund_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a refund in flight without a Paystack refund id can be reverted';
  END IF;
  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'payment_exception_refund_reverted',
          jsonb_build_object('payment_exception_id', p_payment_exception_id, 'reason', left(p_reason, 500)),
          public.actor_role());
END;
$function$;

-- ── 4. Webhook completion (project_admin only) ───────────────────────────────
CREATE FUNCTION public.finalize_payment_exception_refund(p_refund_id text)
RETURNS TABLE(status text, buyer_email text, buyer_name text, amount_kobo bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  x public.payment_exceptions%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.payment_exceptions e WHERE e.refund_id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint; RETURN;
  END IF;
  IF x.refund_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint; RETURN;
  END IF;
  UPDATE public.payment_exceptions e
     SET refund_status = 'refunded', refund_completed_at = now(),
         status = 'resolved', resolved_at = now(), resolved_by = x.refund_approved_by,
         resolution_note = left('Refunded ₦' || to_char(x.refund_amount_kobo / 100.0, 'FM999,999,999,990.00')
                                || ' (Paystack refund ' || p_refund_id || '); requested by ' || x.refund_requested_by
                                || ', approved by ' || x.refund_approved_by || '. Reason: ' || x.refund_reason, 1000)
   WHERE e.id = x.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'payment_exception_refunded', x.user_id,
          jsonb_build_object('payment_exception_id', x.id, 'reference', x.reference, 'refund_id', p_refund_id,
                             'amount_kobo', x.refund_amount_kobo),
          'webhook');
  RETURN QUERY SELECT 'finalized'::text, u.email, u.full_name, x.refund_amount_kobo
    FROM (SELECT 1) one LEFT JOIN public.users u ON u.id = x.user_id;
END;
$function$;

CREATE FUNCTION public.fail_payment_exception_refund(p_refund_id text, p_reason text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  x public.payment_exceptions%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.payment_exceptions e WHERE e.refund_id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF x.refund_status = 'refunded' THEN RETURN 'already_finalized'; END IF;
  IF x.refund_status = 'refund_failed' THEN RETURN 'already_failed'; END IF;
  -- The exception stays open; the money is still owed. A new two-admin
  -- request is needed to try again. refund_id is cleared so a new attempt
  -- can record its own id; the failed id stays in admin_logs.
  UPDATE public.payment_exceptions e
     SET refund_status = 'refund_failed', refund_error = left(COALESCE(p_reason, 'refund failed'), 500), refund_id = NULL
   WHERE e.id = x.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'payment_exception_refund_failed', x.user_id,
          jsonb_build_object('payment_exception_id', x.id, 'reference', x.reference, 'refund_id', p_refund_id,
                             'reason', p_reason),
          'webhook');
  RETURN 'failed_recorded';
END;
$function$;

-- ── 5. List (adds kind, transfer and refund state) ───────────────────────────
DROP FUNCTION public.admin_list_payment_exceptions(text, integer, integer);
CREATE FUNCTION public.admin_list_payment_exceptions(
  p_status text DEFAULT 'open', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS TABLE (
  id uuid, reference text, payment_ref text, reason text, detail text,
  amount_kobo bigint, expected_kobo bigint, source text, status text,
  resolution_note text, resolved_at timestamptz, seen_count integer,
  first_seen_at timestamptz, last_seen_at timestamptz,
  user_id uuid, buyer_username text, buyer_email text,
  event_id uuid, event_title text,
  kind text, transfer_id uuid,
  refund_status text, refund_amount_kobo bigint, refund_reason text,
  refund_requested_by uuid, refund_requested_by_name text, refund_requested_at timestamptz,
  refund_approved_by uuid, refund_approved_by_name text, refund_approved_at timestamptz,
  refund_admin_request_id uuid, refund_id text, refund_error text,
  refund_request_status text
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
         x.event_id, e.title,
         x.kind, x.transfer_id,
         x.refund_status, x.refund_amount_kobo, x.refund_reason,
         x.refund_requested_by, COALESCE(ra.username, ra.full_name), x.refund_requested_at,
         x.refund_approved_by, COALESCE(rb.username, rb.full_name), x.refund_approved_at,
         x.refund_admin_request_id, x.refund_id, x.refund_error,
         q.status
    FROM public.payment_exceptions x
    LEFT JOIN public.users u ON u.id = x.user_id
    LEFT JOIN public.events e ON e.id = x.event_id
    LEFT JOIN public.users ra ON ra.id = x.refund_requested_by
    LEFT JOIN public.users rb ON rb.id = x.refund_approved_by
    LEFT JOIN public.admin_action_requests q ON q.id = x.refund_admin_request_id
   WHERE p_status IS NULL OR x.status = p_status
   ORDER BY x.first_seen_at DESC, x.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$function$;

-- ── 6. Single-admin resolve can't close money that is mid-refund ─────────────
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
  -- [0234] A refund that is approved or in flight is finished by Paystack's
  -- webhook, not by hand; a pending request must be decided first.
  IF r.refund_status IN ('approved', 'refund_pending')
     OR (r.refund_status = 'requested' AND EXISTS (
           SELECT 1 FROM public.admin_action_requests q WHERE q.id = r.refund_admin_request_id AND q.status = 'pending')) THEN
    RAISE EXCEPTION 'A refund for this payment is in progress; it cannot be closed by hand';
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

-- ── 7. Wire into the maker-checker (anchored, exactly once) ──────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text;
  v_count integer;
BEGIN
  v_def := pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);
  v_anchor := E'      ELSIF r.action_type = ''reassign_withdrawal_bank_account'' THEN\n';
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0234: approve_admin_action anchor found % times (expected 1; are 0203 and 0207 applied?)', v_count;
  END IF;
  EXECUTE replace(v_def, v_anchor,
    E'      ELSIF r.action_type = ''refund_payment_exception'' THEN\n' ||
    E'        PERFORM public.execute_payment_exception_refund_approval(r.id);\n' || v_anchor);

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  v_anchor := E'''reassign_withdrawal_bank_account''';
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0234: request_admin_action anchor found % times (expected 1; is 0207 applied?)', v_count;
  END IF;
  EXECUTE replace(v_def, v_anchor, v_anchor || E', ''refund_payment_exception''');
END
$patch$;

-- ── Grants ───────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.admin_request_payment_exception_refund(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_request_payment_exception_refund(uuid, bigint, text) TO authenticated;
REVOKE ALL ON FUNCTION public.execute_payment_exception_refund_approval(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_payment_exception_refund(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_payment_exception_refund(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.attach_payment_exception_refund_id(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_payment_exception_refund_id(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_revert_payment_exception_refund(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revert_payment_exception_refund(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.finalize_payment_exception_refund(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_payment_exception_refund(text) TO project_admin;
REVOKE ALL ON FUNCTION public.fail_payment_exception_refund(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_payment_exception_refund(text, text) TO project_admin;
REVOKE ALL ON FUNCTION public.admin_list_payment_exceptions(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_payment_exceptions(text, integer, integer) TO authenticated, project_admin;

COMMIT;
