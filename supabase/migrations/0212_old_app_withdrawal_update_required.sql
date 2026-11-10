-- 0212: old app builds get "update the app" instead of "permission denied".
--
-- Since 0211 the only way to request a withdrawal is request_withdrawal
-- (PIN-checked). Store builds from before b5efac7 still call the old entry
-- point request_organizer_payout directly; 0211 revoked it from clients, so
-- those users see the raw Postgres text "permission denied for function
-- request_organizer_payout". This migration gives them a message they can
-- act on, without reopening any withdrawal path:
--
--   1. The real function is renamed request_organizer_payout_core. Its body,
--      SECURITY DEFINER and grants (none for anon/authenticated) are kept as
--      they are: clients still cannot call it.
--   2. request_withdrawal (0211) is patched to call the core by its new name
--      (exactly one call site, checked).
--   3. A new request_organizer_payout with the old signature is granted to
--      authenticated. It touches no table and always raises a plain-language
--      "please update the app" error (SQLSTATE VU426, DETAIL
--      APP_UPDATE_REQUIRED), which old builds show as the withdrawal error.
--
-- No money, wallet, ledger, request, approval or PIN row is touched. No
-- financial rule changes: the PIN, minimum, duplicate rule and two-admin
-- approval are exactly 0211's.
--
-- Prerequisite: 0211. One transaction; idempotent. Safe to re-run after an
-- accidental re-run of 0211 (which would point request_withdrawal back at the
-- old name): it re-patches request_withdrawal and re-grants the stub.
-- Rollback: supabase/rollback/undo_0212.sql (undo 0212 before undoing 0211).

DO $pre$
DECLARE
  v_stub boolean;
BEGIN
  IF to_regprocedure('public.request_withdrawal(bigint,uuid,text,text)') IS NULL
     OR to_regprocedure('public.request_organizer_payout(bigint,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '0212 requires 0211 (request_withdrawal / request_organizer_payout missing)';
  END IF;
  SELECT position('APP_UPDATE_REQUIRED' IN prosrc) > 0 INTO v_stub
    FROM pg_proc WHERE oid = 'public.request_organizer_payout(bigint,uuid,text)'::regprocedure;
  IF NOT v_stub AND to_regprocedure('public.request_organizer_payout_core(bigint,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '0212: both a real request_organizer_payout and request_organizer_payout_core exist; stop and investigate';
  END IF;
END
$pre$;

-- 1. Rename the real function (only while it is still the real one).
DO $rename$
BEGIN
  IF to_regprocedure('public.request_organizer_payout_core(bigint,uuid,text)') IS NULL THEN
    IF NOT (SELECT prosecdef AND position('organizer_withdrawal_requests' IN prosrc) > 0
              FROM pg_proc WHERE oid = 'public.request_organizer_payout(bigint,uuid,text)'::regprocedure) THEN
      RAISE EXCEPTION '0212: request_organizer_payout is not the expected withdrawal-creating function';
    END IF;
    ALTER FUNCTION public.request_organizer_payout(bigint, uuid, text) RENAME TO request_organizer_payout_core;
  END IF;
END
$rename$;
REVOKE ALL ON FUNCTION public.request_organizer_payout_core(bigint, uuid, text) FROM PUBLIC, anon, authenticated;

-- 2. request_withdrawal calls the core (exactly one call site).
DO $patch$
DECLARE
  v_def text;
  v_old constant text := 'public.request_organizer_payout(p_amount_kobo, p_bank_account_id, v_key)';
  v_new constant text := 'public.request_organizer_payout_core(p_amount_kobo, p_bank_account_id, v_key)';
  v_n integer;
BEGIN
  v_def := pg_get_functiondef('public.request_withdrawal(bigint,uuid,text,text)'::regprocedure);
  IF position(v_new IN v_def) > 0 THEN
    RETURN;  -- already patched
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0212: request_withdrawal has % call(s) of the old entry point, expected exactly 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$patch$;

-- 3. The old name now only tells old apps to update.
CREATE OR REPLACE FUNCTION public.request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  -- [0212] APP_UPDATE_REQUIRED. Never creates a withdrawal.
  RAISE EXCEPTION USING
    ERRCODE = 'VU426',
    MESSAGE = 'Please update VENTS to withdraw. Withdrawals now need a 4-digit withdrawal PIN, which this version of the app does not support. Update the app from the App Store or Google Play, or withdraw on getvents.com.',
    DETAIL  = 'APP_UPDATE_REQUIRED',
    HINT    = 'Update the VENTS app or use getvents.com';
END;
$function$;
REVOKE ALL ON FUNCTION public.request_organizer_payout(bigint, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_organizer_payout(bigint, uuid, text) TO authenticated;

DO $post$
BEGIN
  IF position('request_organizer_payout_core(' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.request_withdrawal(bigint,uuid,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0212: request_withdrawal does not call the core';
  END IF;
  IF has_function_privilege('authenticated', 'public.request_organizer_payout_core(bigint,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.request_organizer_payout_core(bigint,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0212: clients can execute request_organizer_payout_core';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.request_organizer_payout(bigint,uuid,text)'::regprocedure
              AND (prosecdef OR prosrc ~* '(insert\s+into|update\s+public\.|delete\s+from|perform|select)')) THEN
    RAISE EXCEPTION '0212: the old entry point must be a plain message, with no privileges and no writes';
  END IF;
END
$post$;
