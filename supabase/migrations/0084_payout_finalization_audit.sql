-- P0-5 — Audit the final state transition of a real bank payout.
--
-- ROOT CAUSE. Every earlier step of the payout lifecycle writes admin_logs:
-- admin_claim_payout_for_processing ('claim_payout_for_processing', 0022),
-- admin_mark_payout_processing, admin_reject_organizer_payout
-- ('reject_payout_request', 0004), admin_cancel_processing_payout (0076).
-- The two functions that perform the FINAL, irreversible transition —
-- complete_organizer_payout (0023) and fail_organizer_payout (0076) — wrote
-- none. Verified by inspecting both bodies: neither contained the string
-- admin_logs.
--
-- So the audit trail covered every reversible step and went dark at exactly
-- the moment real money left (or failed to leave) the platform. For a
-- failure this was total: fail_organizer_payout restores balance_kobo to
-- the organizer's wallet and writes NO ledger row of any kind, so a failed
-- payout left no first-class record anywhere — only a mutated status column
-- and a silently larger wallet balance.
--
-- WHY NOT "the transaction row is already the audit record". For the
-- completion path that argument is half-true: complete_organizer_payout
-- does insert an organizer_transactions row, which is a durable record of
-- the money movement. But it records the movement, not the DECISION — no
-- actor, no previous status, no reconciliation context. And the failure
-- path has no such row at all. Both get an admin_logs entry here; the
-- shape matches admin_reject_organizer_payout's INSERT exactly (same column
-- list, same jsonb_build_object style, same public.actor_role() call).
--
-- ACTOR SENTINEL. Both functions are reachable only by project_admin
-- (0011:174-175, 201-202 — EXECUTE revoked from PUBLIC/anon/authenticated,
-- granted to project_admin alone), and are called by
-- api/webhook/paystack.ts and the reconcile-payouts route — both
-- over a direct project_admin Postgres connection with no user JWT, so
-- auth.uid() is NULL and actor_role() returns NULL. admin_logs.admin_id is
-- nullable, so a NULL admin_id is itself the signal "not a human admin";
-- actor_role is set to the 'system:project_admin' sentinel to make that
-- explicit and greppable. There is no pre-existing sentinel convention in
-- this schema to match — this establishes one.
--
-- KNOWN LIMITATION, deliberately not worked around: webhook-triggered and
-- reconcile-triggered calls are indistinguishable from inside these
-- functions. Both arrive on the same project_admin connection with no
-- caller identity. Separating them requires a source parameter, and adding
-- one is NOT backward-compatible here — CREATE OR REPLACE cannot change a
-- signature, so a defaulted extra parameter would create a SECOND function
-- and make every existing 1-arg / 2-arg call site ambiguous. Distinguishing
-- them therefore needs a coordinated DROP + recreate + caller update, which
-- is out of scope for an audit-only change. Flagged in the report.
--
-- Both bodies below are otherwise byte-for-byte their current definitions
-- (0023 and 0076 respectively). The ONLY addition is the admin_logs INSERT
-- immediately before the success RETURN QUERY. Placement is deliberate: it
-- sits after the guarded UPDATE and its ROW_COUNT check, so it can only run
-- on a real state transition. The not_found / already_completed /
-- already_finalized early-returns stay unlogged — those are idempotent
-- no-ops (webhook retries hit them constantly) and logging them would bury
-- real transitions in retry noise.

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
  WHERE id = v_id AND public.organizer_withdrawal_requests.status IN ('pending', 'processing');

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

  -- P0-5: audit the final transition. Same column list and style as
  -- admin_reject_organizer_payout's INSERT.
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'complete_payout',
    v_organizer_id,
    jsonb_build_object(
      'request_id', v_id,
      'lookup_key', p_request_id,
      'previous_status', v_status,
      'new_status', 'completed',
      'amount_kobo', v_amount_kobo,
      'bank_name', v_bank_name,
      'account_number', v_account_number
    ),
    COALESCE(public.actor_role(), 'system:project_admin')
  );

  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$
;

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

  -- P0-5: this path previously left NO record anywhere — no ledger row, no
  -- audit row — despite restoring real spendable balance to the organizer.
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'fail_payout',
    v_organizer_id,
    jsonb_build_object(
      'request_id', v_id,
      'lookup_key', p_request_id,
      'previous_status', v_status,
      'new_status', 'failed',
      'amount_kobo', v_amount_kobo,
      'amount_restored_to_balance_kobo', v_amount_kobo,
      'reason', p_reason
    ),
    COALESCE(public.actor_role(), 'system:project_admin')
  );

  RETURN QUERY
  SELECT 'failed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$
;

-- Grants deliberately restated to match the existing lockdown: these two
-- remain unreachable from any client session.
REVOKE EXECUTE ON FUNCTION public.complete_organizer_payout(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_organizer_payout(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_organizer_payout(text) TO project_admin;
GRANT EXECUTE ON FUNCTION public.fail_organizer_payout(text, text) TO project_admin;
