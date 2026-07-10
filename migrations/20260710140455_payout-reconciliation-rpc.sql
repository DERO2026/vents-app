-- Reconciliation fallback for stuck 'processing' payouts.
--
-- transfer.success/transfer.failed webhooks are the primary way a
-- 'processing' request resolves, but a webhook can be missed, misconfigured
-- on Paystack's dashboard side, or fail silently — there's no reliable way
-- for us to know that happened. This RPC lists everything currently stuck
-- so a reconciliation job can actively poll Paystack's real transfer status
-- and resolve them via the existing complete_organizer_payout /
-- fail_organizer_payout RPCs (same functions the webhook already calls —
-- one source of truth for what "completion" means, not two).

CREATE OR REPLACE FUNCTION public.admin_list_processing_payouts()
RETURNS TABLE (
  request_id uuid, organizer_id uuid, amount_kobo bigint,
  transfer_code text, paystack_reference text, updated_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, r.transfer_code, r.paystack_reference, r.updated_at
  FROM public.organizer_withdrawal_requests r
  WHERE r.status = 'processing'
  ORDER BY r.updated_at ASC;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_list_processing_payouts TO authenticated;
