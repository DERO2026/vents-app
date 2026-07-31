-- complete_organizer_payout / fail_organizer_payout had EXECUTE granted to
-- anon and authenticated with ZERO internal auth check — unlike every
-- sibling payout verb (admin_claim_payout_for_processing,
-- admin_mark_payout_processing, admin_reject_organizer_payout), which all
-- gate on is_admin()/is_admin_or_root(). These two only match rows by
-- p_request_id, which equals the withdrawal request's own id/transfer_code/
-- paystack_reference — values the REQUESTING ORGANIZER already knows,
-- since request_organizer_payout() returns them.
--
-- Concretely exploitable: an organizer could call fail_organizer_payout on
-- their own 'processing' request directly over the InsForge REST RPC
-- surface the instant a real Paystack transfer is initiated, crediting
-- balance_kobo back to themselves before the real transfer.success webhook
-- lands. The later legitimate webhook then sees status NOT IN
-- ('pending','processing') and silently no-ops (by design, to stay
-- idempotent against retries) — so the organizer keeps both the real bank
-- transfer AND the restored wallet balance. A genuine double-spend.
--
-- These two RPCs are meant to be called only by the Paystack webhook
-- (HMAC-signature verified in api/webhook/paystack.ts) and the
-- admin-triggered reconciliation job (api/wallet/reconcile-payouts.ts) —
-- both now updated to authenticate with the admin-only API_KEY secret
-- instead of the client-exposed anon key. Revoking anon/authenticated
-- EXECUTE here closes the RPC-level hole those two code changes assume is
-- closed.
REVOKE EXECUTE ON FUNCTION public.complete_organizer_payout(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_organizer_payout(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_organizer_payout(text) TO project_admin;
GRANT EXECUTE ON FUNCTION public.fail_organizer_payout(text, text) TO project_admin;
