-- Undo 0234 (two-admin refund of payment exceptions, AZ-10). Gated: run with
--   SET vents.rollback_confirm = 'undo-0234';
-- Restores 0226's admin_list_payment_exceptions and
-- admin_resolve_payment_exception verbatim, removes the refund functions, the
-- maker-checker wiring and the refund columns. Refuses while any refund is
-- requested (waiting for a second admin), approved or in flight: undo must
-- never strand money mid-refund. Refunded rows keep their resolution note and
-- admin_logs history; only the per-column refund state is removed.
-- WARNING: after undo, refunds of payments without a ticket are back to the
-- manual "refund in Paystack, then record it" process.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0234' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0234'' first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'payment_exceptions' AND column_name = 'refund_status') THEN
    RAISE EXCEPTION 'undo_0234: 0234 is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.confirm_transfer_fee_payment(text,bigint)')
              AND position('[0238]' IN prosrc) > 0) THEN
    RAISE EXCEPTION 'undo_0234: 0238 is still applied; undo in reverse order (0238 first)';
  END IF;
  -- 0240 (production path) patches 0234's refund-outcome functions with 0238's text.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.finalize_payment_exception_refund(text)')
              AND position('[0238]' IN prosrc) > 0) THEN
    RAISE EXCEPTION 'undo_0234: 0240 (or 0238) is still applied; undo in reverse order (0240 first)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_exceptions WHERE refund_status IN ('approved', 'refund_pending')) THEN
    RAISE EXCEPTION 'undo_0234: a refund is approved or in flight; finish it before undoing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_action_requests WHERE action_type = 'refund_payment_exception' AND status = 'pending') THEN
    RAISE EXCEPTION 'undo_0234: a refund request is waiting for a second admin; decide it before undoing';
  END IF;
END $$;

DO $patch$
DECLARE
  v_def text;
  v_patch text;
BEGIN
  v_def := pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);
  v_patch := E'      ELSIF r.action_type = ''refund_payment_exception'' THEN\n' ||
             E'        PERFORM public.execute_payment_exception_refund_approval(r.id);\n';
  IF (length(v_def) - length(replace(v_def, v_patch, ''))) / length(v_patch) <> 1 THEN
    RAISE EXCEPTION 'undo_0234: approve_admin_action does not carry the 0234 patch exactly once; refusing';
  END IF;
  EXECUTE replace(v_def, v_patch, '');

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  v_patch := E', ''refund_payment_exception''';
  IF (length(v_def) - length(replace(v_def, v_patch, ''))) / length(v_patch) <> 1 THEN
    RAISE EXCEPTION 'undo_0234: request_admin_action does not carry the 0234 patch exactly once; refusing';
  END IF;
  EXECUTE replace(v_def, v_patch, '');
END
$patch$;

DROP FUNCTION public.admin_request_payment_exception_refund(uuid, bigint, text);
DROP FUNCTION public.execute_payment_exception_refund_approval(uuid);
DROP FUNCTION public.start_payment_exception_refund(uuid, text);
DROP FUNCTION public.attach_payment_exception_refund_id(uuid, text);
DROP FUNCTION public.admin_revert_payment_exception_refund(uuid, text);
DROP FUNCTION public.finalize_payment_exception_refund(text);
DROP FUNCTION public.fail_payment_exception_refund(text, text);
DROP FUNCTION public.admin_list_payment_exceptions(text, integer, integer);

-- 0226, verbatim.
CREATE FUNCTION public.admin_list_payment_exceptions(
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

-- 0226, verbatim.
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

REVOKE ALL ON FUNCTION public.admin_list_payment_exceptions(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_payment_exceptions(text, integer, integer) TO authenticated, project_admin;

DROP INDEX public.payment_exceptions_refund_id_idx;
ALTER TABLE public.payment_exceptions
  DROP CONSTRAINT payment_exceptions_refund_amount_ck,
  DROP CONSTRAINT payment_exceptions_refund_parties_ck,
  DROP CONSTRAINT payment_exceptions_refund_approved_ck,
  DROP COLUMN refund_status, DROP COLUMN refund_amount_kobo, DROP COLUMN refund_reason,
  DROP COLUMN refund_admin_request_id, DROP COLUMN refund_requested_by, DROP COLUMN refund_requested_at,
  DROP COLUMN refund_approved_by, DROP COLUMN refund_approved_at, DROP COLUMN refund_started_by,
  DROP COLUMN refund_started_at, DROP COLUMN refund_id, DROP COLUMN refund_completed_at, DROP COLUMN refund_error;

COMMIT;
