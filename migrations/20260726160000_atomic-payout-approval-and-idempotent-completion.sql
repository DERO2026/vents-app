-- ── CRITICAL FIX: payout approval TOCTOU race + payout completion double-processing ──
-- Audit findings:
--   (a) api/wallet/admin-approve-payout.ts read payout status via a plain
--       SELECT (admin_get_payout_for_processing), called Paystack's
--       /transfer endpoint, and only THEN flipped status to 'processing'
--       (admin_mark_payout_processing). Two concurrent approvals for the same
--       request both pass the "is it pending?" check before either commits,
--       so both fire a real Paystack transfer -- a genuine double-payout.
--   (b) complete_organizer_payout / fail_organizer_payout read status with a
--       plain SELECT (no lock) and, after the compare-and-swap UPDATE ...
--       WHERE status IN (...), never checked whether that UPDATE actually
--       matched a row before going on to mutate organizer_wallets and insert
--       an organizer_transactions row. A duplicate webhook delivery or a
--       reconciliation-job race could double-credit total_withdrawn_kobo and
--       write a duplicate ledger row for one real transfer.
--
-- Fix (a): move the pending -> processing transition to happen ATOMICALLY,
-- BEFORE any Paystack call, via a single UPDATE ... WHERE status = 'pending'
-- (a compare-and-swap on the row itself -- Postgres guarantees only one
-- concurrent UPDATE can match). Only the caller that actually flips the row
-- proceeds to call Paystack; a caller that loses the race gets told the
-- current (already-claimed) status and does nothing further. If the Paystack
-- call then fails, the claim is released back to 'pending' so the admin can
-- safely retry -- but ONLY if no transfer_code was ever attached, so a claim
-- can never be released out from under a transfer that actually went through.
--
-- Fix (b): add `FOR UPDATE` row locking on the initial read (so a concurrent
-- caller blocks until the first transaction commits or rolls back, rather
-- than reading a not-yet-committed 'pending'/'processing' status) AND check
-- `GET DIAGNOSTICS ... ROW_COUNT` after the status-flip UPDATE, returning the
-- "already processed" result instead of falling through to the wallet/ledger
-- mutations whenever the UPDATE didn't actually change anything.

-- ── (a) Atomic claim-before-call for payout approval ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_claim_payout_for_processing(p_request_id uuid)
 RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, recipient_code text, status text, claimed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed_id uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  -- The atomic claim: exactly one concurrent caller can win this UPDATE for
  -- a given request_id, because Postgres serializes UPDATEs to the same row.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing', resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NOT NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
    VALUES (auth.uid(), 'claim_payout_for_processing', jsonb_build_object('request_id', p_request_id), public.actor_role());
  END IF;

  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, b.recipient_code, r.status, (v_claimed_id IS NOT NULL)
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) TO authenticated;

-- Superseded by the claim RPC above -- nothing else in the repo calls this
-- (grepped), safe to drop rather than leave as unused dead surface.
DROP FUNCTION IF EXISTS public.admin_get_payout_for_processing(uuid);

-- Releases a claim that couldn't complete (Paystack rejected the transfer
-- outright). Guarded so it can NEVER undo a claim that already has a real
-- transfer_code attached -- only a claim that never got that far can be
-- released back to 'pending' for retry.
CREATE OR REPLACE FUNCTION public.admin_release_payout_claim(p_request_id uuid, p_reason text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'pending', updated_at = now()
  WHERE id = p_request_id AND status = 'processing' AND transfer_code IS NULL;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'release_payout_claim', jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END;
$function$;
GRANT EXECUTE ON FUNCTION public.admin_release_payout_claim(uuid, text) TO authenticated;

-- Now only ATTACHES the Paystack reference to an already-'processing' row
-- (the status flip already happened atomically in the claim step above) --
-- no longer the thing that transitions pending -> processing.
CREATE OR REPLACE FUNCTION public.admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET paystack_reference = p_paystack_reference, transfer_code = p_transfer_code, updated_at = now()
  WHERE id = p_request_id AND status = 'processing';

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'approve_payout_request',
          jsonb_build_object('request_id', p_request_id, 'transfer_code', p_transfer_code),
          public.actor_role());
END;
$function$;
GRANT EXECUTE ON FUNCTION public.admin_mark_payout_processing(uuid, text, text) TO authenticated;

-- ── (b) Idempotent payout completion / failure ────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_organizer_payout(p_request_id text)
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
  v_bank_name text;
  v_account_number text;
  v_account_name text;
  v_rows int;
BEGIN
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status, b.bank_name, b.account_number, b.account_name
    INTO v_id, v_organizer_id, v_amount_kobo, v_status, v_bank_name, v_account_number, v_account_name
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE OF r;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status = 'completed' THEN
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_amount_kobo
    FROM public.users u WHERE u.id = v_organizer_id;
    RETURN;
  END IF;

  -- Matched by the exact row id found above — not by amount/status, which
  -- could otherwise also match a sibling request for the same amount.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'completed', updated_at = now()
  WHERE id = v_id AND status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Lost the race to a concurrent call (or webhook retry) between our
    -- initial locked read and here -- someone else already finalized this
    -- request. Do NOT touch the wallet/ledger a second time.
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_amount_kobo
    FROM public.users u WHERE u.id = v_organizer_id;
    RETURN;
  END IF;

  UPDATE public.organizer_wallets
  SET pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions
    (organizer_id, type, amount_kobo, description, withdrawal_request_id, metadata)
  VALUES (
    v_organizer_id, 'payout', v_amount_kobo,
    'Withdrawal to ' || COALESCE(v_bank_name, 'bank account') || ' — completed',
    v_id,
    jsonb_build_object('bank_name', v_bank_name, 'account_number', v_account_number, 'account_name', v_account_name)
  );

  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$;

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
  SELECT id, organizer_id, amount_kobo, status INTO v_id, v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id
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
  WHERE id = v_id AND status IN ('pending', 'processing');

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
$function$;
