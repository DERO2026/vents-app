-- Follow-up to 0113: the Dashboard hard-delete still failed for real
-- accounts. Root cause, confirmed live against the actual reported
-- account (jetdriveglobal@gmail.com): 0113 deliberately left
-- user_wallets/user_wallet_transactions/wallet_deposit_attempts/
-- vc_withdrawal_requests/organizer_withdrawal_requests as NO ACTION,
-- reasoning they were "real financial ledgers". That reasoning was too
-- broad: a user_wallets row is auto-provisioned the first time ANY user
-- opens the wallet screen (see e.g. get_my_wallet's INSERT ... ON
-- CONFLICT DO NOTHING pattern), at balance_kobo = 0 -- confirmed live for
-- this exact account: balance_kobo = 0, yet the row's mere EXISTENCE was
-- enough to block deletion under a plain NO ACTION FK, which has no way
-- to distinguish "an empty auto-created row" from "a real balance".
--
-- Fix: replace the blanket block with a value-aware one. Each of these
-- five tables' FK becomes CASCADE (so a deleted user's own rows go with
-- them, matching every other owned-record table in this schema), but a
-- BEFORE DELETE trigger on the table itself -- which fires for a direct
-- delete AND for a delete arriving via cascade -- raises and stops the
-- whole transaction if the row represents actual value still at stake:
--   - user_wallets: balance_kobo <> 0 (real naira sitting in the wallet)
--   - vc_withdrawal_requests / organizer_withdrawal_requests: status IN
--     ('pending','processing') (a live, unresolved payout request -- real
--     money already promised/in flight)
-- user_wallet_transactions and wallet_deposit_attempts get no guard and
-- simply CASCADE -- they are history/attempt logs, not money itself,
-- exactly mirroring the already-unguarded vc_transactions (CASCADE) and
-- pending_purchases (CASCADE, from 0113) precedents already in this
-- schema.
--
-- This does not weaken protection for a user who actually has money or a
-- live payout request: the delete now fails with an explicit, readable
-- error naming the reason, instead of a bare FK-violation code, and
-- still fails the whole transaction (no partial deletion). A genuinely
-- empty/settled account -- the overwhelming majority of real users, who
-- have never held a balance or have a fully resolved payout history --
-- can now be completely removed, which was the actual goal 0113 fell
-- short of.

CREATE OR REPLACE FUNCTION public.block_delete_nonzero_wallet_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.balance_kobo <> 0 THEN
    RAISE EXCEPTION 'Cannot delete user %: wallet balance is % kobo, not zero. Withdraw or transfer the balance first.', OLD.user_id, OLD.balance_kobo;
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.block_delete_live_withdrawal_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.status IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'Cannot delete this user: a % withdrawal request (id %) is still unresolved. Resolve or cancel it first.', OLD.status, OLD.id;
  END IF;
  RETURN OLD;
END;
$function$;

ALTER TABLE public.user_wallets DROP CONSTRAINT user_wallets_user_id_fkey;
ALTER TABLE public.user_wallets ADD CONSTRAINT user_wallets_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
CREATE TRIGGER trg_block_delete_nonzero_wallet_balance
  BEFORE DELETE ON public.user_wallets
  FOR EACH ROW EXECUTE FUNCTION public.block_delete_nonzero_wallet_balance();

ALTER TABLE public.user_wallet_transactions DROP CONSTRAINT user_wallet_transactions_user_id_fkey;
ALTER TABLE public.user_wallet_transactions ADD CONSTRAINT user_wallet_transactions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.wallet_deposit_attempts DROP CONSTRAINT wallet_deposit_attempts_user_id_fkey;
ALTER TABLE public.wallet_deposit_attempts ADD CONSTRAINT wallet_deposit_attempts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.vc_withdrawal_requests DROP CONSTRAINT vc_withdrawal_requests_user_id_fkey;
ALTER TABLE public.vc_withdrawal_requests ADD CONSTRAINT vc_withdrawal_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
CREATE TRIGGER trg_block_delete_live_vc_withdrawal
  BEFORE DELETE ON public.vc_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.block_delete_live_withdrawal_request();

ALTER TABLE public.organizer_withdrawal_requests DROP CONSTRAINT organizer_withdrawal_requests_organizer_id_public_users_fkey;
ALTER TABLE public.organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_organizer_id_public_users_fkey
  FOREIGN KEY (organizer_id) REFERENCES public.users(id) ON DELETE CASCADE;
CREATE TRIGGER trg_block_delete_live_organizer_withdrawal
  BEFORE DELETE ON public.organizer_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.block_delete_live_withdrawal_request();
