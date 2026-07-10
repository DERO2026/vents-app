-- Admin "Cancel" action for withdrawal requests stuck in 'processing' that
-- don't actually exist on Paystack (a transfer_code that was never really
-- created, or references a stale/wrong reference) — the reconciliation
-- fallback (admin_list_processing_payouts / reconcile-payouts) can only
-- resolve requests Paystack still recognizes; this is the manual override
-- for the ones it can't.
--
-- No generic "transactions" table exists in this schema — organizer_transactions
-- is the real audit-trail table already used by complete_organizer_payout,
-- so the audit row goes there, with a new nullable withdrawal_request_id FK
-- so the refund is genuinely traceable back to the original request rather
-- than just embedding the UUID as text in a description string.

ALTER TABLE public.organizer_withdrawal_requests
  DROP CONSTRAINT organizer_withdrawal_requests_status_check;
ALTER TABLE public.organizer_withdrawal_requests
  ADD CONSTRAINT organizer_withdrawal_requests_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'rejected', 'cancelled'));

ALTER TABLE public.organizer_transactions
  DROP CONSTRAINT organizer_transactions_type_check;
ALTER TABLE public.organizer_transactions
  ADD CONSTRAINT organizer_transactions_type_check
  CHECK (type IN ('credit', 'debit', 'payout', 'cancelled_payout_refund'));

ALTER TABLE public.organizer_transactions
  ADD COLUMN IF NOT EXISTS withdrawal_request_id uuid REFERENCES public.organizer_withdrawal_requests(id);

CREATE OR REPLACE FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text)
RETURNS TABLE (status text, organizer_email text, organizer_name text, amount_kobo bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id = p_request_id;

  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_status; END IF;

  -- Single function body = single transaction: status flip, wallet refund,
  -- and audit row all commit together or not at all.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, updated_at = now()
  WHERE id = p_request_id;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id)
  VALUES (v_organizer_id, 'cancelled_payout_refund', v_amount_kobo,
          'Payout request cancelled by admin, funds returned — ' || p_reason, p_request_id);

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_cancel_processing_payout TO authenticated;
