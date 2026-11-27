-- Undo 0240 only (supabase/migrations/0240_transfer_fee_refund_outcome.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0240';
--   \i supabase/rollback/undo_0240.sql
-- Restores 0234's finalize_/fail_payment_exception_refund exactly (byte for
-- byte). Refunds, exceptions and transfer refund states already recorded are
-- kept; after the undo, a transfer-fee refund closes its payment exception
-- but no longer updates the transfer.
BEGIN;
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0240' THEN
    RAISE EXCEPTION 'undo_0240 refused: set vents.rollback_confirm = ''undo-0240'' to confirm';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.finalize_payment_exception_refund(text)')
                  AND md5(replace(prosrc, E'\r', '')) = '937f2aeb15224742f6fba86653cdbaa4') THEN
    RAISE EXCEPTION 'undo_0240 refused: finalize_payment_exception_refund is not 0240''s version';
  END IF;
END
$undo$;

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

COMMIT;
