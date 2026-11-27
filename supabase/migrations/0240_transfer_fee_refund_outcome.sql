-- 0240: a two-admin refund of a transfer fee also updates the transfer
-- (owner decisions 2026-11-27). Runs after 0234 (two-admin refunds) and 0239
-- (transfer-fee payments on the live baseline). Order: 0226 -> 0239 -> 0234
-- -> 0240.
--
-- 0234's finalize_/fail_payment_exception_refund close a payment exception
-- when Paystack reports the refund. For a transfer fee whose transfer could
-- not complete (reason 'transfer_not_completed', recorded by 0239) they now
-- also mark the transfer's own refund state ('refunded' / 'failed') and tell
-- the recipient once when it is refunded. These are 0238's reviewed bodies,
-- byte for byte (md5 937f2aeb... / 4057b995...); 0238 itself is never
-- applied in production.
--
-- Unchanged: who may request, approve and send a refund (0234), amounts,
-- the single Paystack send, every other refund kind.
-- Refuses unless both functions are exactly 0234's and 0239 is applied.
-- Rollback: supabase/rollback/undo_0240.sql.

BEGIN;

DO $pre$
DECLARE
  v_pins jsonb := '{"finalize_payment_exception_refund": "5054801cd73750349ed99310519aaf8e",
                    "fail_payment_exception_refund": "099e94c90aacac4e70bb6bc925cf94e2"}';
  v_name text;
  v_live text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.confirm_transfer_fee_payment(text,bigint)')
                  AND position('[0239]' IN prosrc) > 0) THEN
    RAISE EXCEPTION '0240 requires 0239';
  END IF;
  FOR v_name IN SELECT jsonb_object_keys(v_pins) LOOP
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name;
    IF v_live IS DISTINCT FROM v_pins->>v_name THEN
      RAISE EXCEPTION '0240 refused: public.% is not 0234''s version (live md5 %, expected %; is 0234 applied, and 0240 not yet?)',
        v_name, COALESCE(v_live, 'missing'), v_pins->>v_name;
    END IF;
  END LOOP;
END
$pre$;

CREATE OR REPLACE FUNCTION public.finalize_payment_exception_refund(p_refund_id text)
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
  -- [0238] A transfer that could not complete: the transfer shows the refund
  -- as done and the recipient is told, as the automatic refund (0064) did.
  IF x.reason = 'transfer_not_completed' AND x.transfer_id IS NOT NULL THEN
    UPDATE public.ticket_transfers t
       SET fee_refund_status = 'refunded', fee_refund_completed_at = now()
     WHERE t.id = x.transfer_id;
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    SELECT t.to_user_id, 'event_update', 'Transfer fee refunded',
           'Your ticket transfer could not be completed, so your transfer fee was refunded.',
           false, '💸', jsonb_build_object('transferId', t.id)
      FROM public.ticket_transfers t WHERE t.id = x.transfer_id;
  END IF;
  RETURN QUERY SELECT 'finalized'::text, u.email, u.full_name, x.refund_amount_kobo
    FROM (SELECT 1) one LEFT JOIN public.users u ON u.id = x.user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fail_payment_exception_refund(p_refund_id text, p_reason text)
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
  UPDATE public.payment_exceptions e
     SET refund_status = 'refund_failed', refund_error = left(COALESCE(p_reason, 'refund failed'), 500), refund_id = NULL
   WHERE e.id = x.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'payment_exception_refund_failed', x.user_id,
          jsonb_build_object('payment_exception_id', x.id, 'reference', x.reference, 'refund_id', p_refund_id,
                             'reason', p_reason),
          'webhook');
  -- [0238] Keep the transfer's own refund state traceable.
  IF x.reason = 'transfer_not_completed' AND x.transfer_id IS NOT NULL THEN
    UPDATE public.ticket_transfers t SET fee_refund_status = 'failed' WHERE t.id = x.transfer_id;
  END IF;
  RETURN 'failed_recorded';
END;
$function$;

COMMIT;
