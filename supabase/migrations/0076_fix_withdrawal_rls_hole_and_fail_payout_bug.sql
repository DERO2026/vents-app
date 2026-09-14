-- Two critical, empirically-confirmed defects found during a financial/
-- accounting audit of the organizer/provider earnings withdrawal path.
-- NOT APPLIED by this migration file's author -- written for review only,
-- per explicit instruction not to touch Production automatically.
--
-- ============================================================================
-- DEFECT 1 (CRITICAL, confirmed exploitable): organizer_withdrawal_requests
-- had a client-writable RLS INSERT policy (org_withdraw_own_insert,
-- 0011_grants.sql-era), allowing ANY authenticated user to INSERT a
-- withdrawal request row directly via the Data API, with a completely
-- arbitrary amount_kobo and ANY existing bank_account_id -- entirely
-- bypassing request_organizer_payout's balance lock/check (which is a
-- SECURITY DEFINER function and never needed this policy to do its own,
-- correct INSERT).
--
-- Confirmed empirically: as a real, non-superuser Postgres role granted
-- only `authenticated` (RLS actually enforced, not bypassed), an account
-- with a genuine earnings balance of NGN 10 successfully inserted a
-- 'pending' withdrawal request for NGN 1,000,000, targeting a bank account
-- belonging to a DIFFERENT organizer entirely. Nothing downstream
-- (admin_claim_payout_for_processing, api/wallet/admin-payout-action.ts,
-- complete_organizer_payout) independently re-verifies amount_kobo against
-- the organizer's actual balance before firing a real Paystack transfer --
-- admin-payout-action.ts trusts amount_kobo from the claimed row outright.
-- A malicious or compromised account could therefore request (and, absent
-- careful manual admin review, receive) a real bank transfer for far more
-- than they ever earned, or redirect a transfer to an account they don't
-- own.
--
-- Fix: drop the policy. Confirmed via grep that no legitimate frontend/
-- backend code ever does a direct `.from('organizer_withdrawal_requests')
-- .insert(...)` -- WalletScreen.tsx's withdrawal flow already calls
-- request_organizer_payout exclusively (line ~488). SECURITY DEFINER
-- functions execute with the function owner's privileges and are
-- unaffected by RLS on the tables they write to, so removing this policy
-- does not break the legitimate path -- confirmed empirically: the exploit
-- insert was rejected with "new row violates row-level security policy"
-- after this fix, while request_organizer_payout continued to succeed
-- normally in the same session.
DROP POLICY IF EXISTS org_withdraw_own_insert ON public.organizer_withdrawal_requests;

-- ============================================================================
-- DEFECT 2 (CRITICAL, confirmed live in Production, confirmed via
-- pg_get_functiondef against the deployed function -- not a hypothetical):
-- fail_organizer_payout unconditionally throws
-- "column reference \"amount_kobo\" is ambiguous" on its very first
-- statement, because RETURNS TABLE(status text, ..., amount_kobo bigint)
-- implicitly creates OUT parameters named `status` and `amount_kobo` that
-- collide with the identically-named columns on
-- organizer_withdrawal_requests when referenced unqualified inside the
-- function body. The function partially guards against this (the STATUS
-- reference is already qualified as
-- public.organizer_withdrawal_requests.status) but the AMOUNT_KOBO
-- reference in the same SELECT was left unqualified -- an oversight,
-- not a deliberate design; its sibling function complete_organizer_payout
-- has the identical RETURNS TABLE shape and avoids this entirely by using
-- a table alias (r.amount_kobo, r.status) throughout.
--
-- Effect: fail_organizer_payout can never successfully run, for any
-- request, for any reason -- every Paystack transfer failure, every admin
-- rejection-after-processing, every transfer.failed webhook, throws
-- instead of restoring the organizer's pending_kobo back to balance_kobo.
-- The error occurs on the function's first SELECT, before any write, so
-- this fails safe (no partial/corrupted state, no fund destruction) --
-- but it means every failed-payout recovery path in this codebase is
-- currently completely non-functional, and any pending_kobo already
-- moved out of an organizer's spendable balance for a payout that then
-- fails on Paystack's side has no working code path to give it back.
--
-- Fix: add the same table-alias pattern complete_organizer_payout already
-- uses. No other logic changed. Verified locally: after this fix,
-- fail_organizer_payout correctly restores balance_kobo from pending_kobo
-- exactly once, and a replayed/duplicate call against the same reference
-- correctly returns 'already_finalized' with no further balance change.
CREATE OR REPLACE FUNCTION public.fail_organizer_payout(p_request_id text, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
  v_rows int;
BEGIN
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status
    INTO v_id, v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests r
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status IN ('completed', 'failed', 'rejected') THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  -- Matched by the exact row id found above (same fix as complete_organizer_payout).
  UPDATE public.organizer_withdrawal_requests
  SET status = 'failed', admin_note = COALESCE(p_reason, admin_note), updated_at = now()
  WHERE id = v_id AND public.organizer_withdrawal_requests.status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  RETURN QUERY
  SELECT 'failed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$
;
