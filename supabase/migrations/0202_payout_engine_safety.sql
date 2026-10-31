-- 0202: payout engine safety (earnings withdrawals).
--
-- NOT applied to production. Fixes the confirmed defects from the
-- 2026-10-30 money-flow audit (docs/money-flow-audit.md). Bodies start from
-- the LIVE production definitions (pg_get_functiondef, 2026-10-30); only the
-- marked behaviour changes. Signatures and grants are unchanged.
--
-- P0-1  Cancelling a payout whose Paystack transfer may exist returned the
--       money to the balance while the transfer could still succeed (paid
--       twice). Cancel now refuses once a transfer reference or code exists;
--       such a request is settled only by Paystack (webhook / Reconcile).
--       A transfer.success for a request that was cancelled anyway (legacy
--       rows) now takes the returned money back instead of being ignored.
-- P0-2  transfer.reversed after transfer.success was ignored, so the
--       organizer silently lost the money. reverse_organizer_payout returns
--       it to the available balance (status 'reversed').
-- P0-3  Each approval used a new random reference, so a retry after a
--       timeout could send a second transfer. The reference is now fixed per
--       request ('payout_<request id>'), set when the request is claimed and
--       never changed, so Paystack itself refuses a duplicate. Marking a
--       transfer as sent now fails loudly instead of silently doing nothing.
-- P1-6  The ledger must explain balance + pending. Cancelling a payout no
--       longer writes a 'cancelled_payout_refund' credit (balance + pending
--       does not change when pending money returns to the balance); the
--       admin log keeps the record. admin_earnings_reconciliation() reports
--       any wallet whose ledger, balance, pending or open requests disagree.
--
-- Not changed here (business decisions, see the audit): refund shortfalls
-- after a withdrawal, a settlement hold for organizer/provider earnings, and
-- second-admin approval of payouts.

-- ---------------------------------------------------------------------------
-- Drift guard (added 2026-10-31, Batch C). 0202 replaces five existing
-- payout functions outright, so it must only run on the definitions it was
-- written against: each must still have the md5(prosrc) production reported
-- on 2026-10-30 (read-only), or already be 0202's own body (a re-run is a
-- no-op). Anything else -- including the 0203-patched bodies, so 0202 can
-- never be re-run over 0203 -- refuses before any change, and the whole
-- file rolls back. The only relaxation is for the local test databases
-- (scripts/local-pg-test), which hold stubs instead of production bodies:
-- it needs BOTH the session setting vents.migration_local_test = 'on' AND a
-- database named vents_local_pg_*; production's database is 'postgres'.
-- ---------------------------------------------------------------------------
DO $guard0202$
DECLARE
  r record;
  v_md5 text;
  v_local boolean := current_setting('vents.migration_local_test', true) = 'on'
                     AND current_database() LIKE 'vents\_local\_pg\_%';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.admin_claim_payout_for_processing(uuid)',        '89675182b62750b8631eb2de1d71211e', 'f39bf3baa40ed70f5826f6ce5196ff54'),
    ('public.admin_mark_payout_processing(uuid,text,text)',    'bf84ac786144b3ea3796fbc09f4bbec6', 'fa6637f7cc5ed915834a7e385f0d01c1'),
    ('public.admin_release_payout_claim(uuid,text)',           '33dd4783b1bb7c4333b70bf32c671e02', 'f3f4b91c009ae18e065a4b80c16453ed'),
    ('public.admin_cancel_processing_payout(uuid,text)',       'cea18083231d281ba2fee58e7610a774', '6428a9bc9912b18ffebeca5f214251f8'),
    ('public.complete_organizer_payout(text)',                 '563304a9394f6fb5148b2d458ce945f6', 'ca6b015abbe0c1a4cdb66470d5a4ad29')
  ) AS v(fn, live_md5, own_md5) LOOP
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_local THEN
      CONTINUE;
    ELSIF v_md5 IS NULL THEN
      RAISE EXCEPTION '0202: % does not exist; this is not the database 0202 was written against. Refusing', r.fn;
    ELSIF v_md5 <> r.live_md5 AND v_md5 <> r.own_md5 THEN
      RAISE EXCEPTION '0202: % differs from the definition this migration was written against (md5 %, expected % or 0202''s own %). Refusing; re-read the live function and regenerate 0202',
        r.fn, v_md5, r.live_md5, r.own_md5;
    END IF;
  END LOOP;
END
$guard0202$;

-- ---------------------------------------------------------------------------
-- Statuses and ledger types
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizer_withdrawal_requests DROP CONSTRAINT IF EXISTS organizer_withdrawal_requests_status_check;
ALTER TABLE public.organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text,
                             'rejected'::text, 'cancelled'::text, 'reversed'::text]));

-- Keeps every type 0201 allows, plus the reversal of a completed payout.
ALTER TABLE public.organizer_transactions DROP CONSTRAINT organizer_transactions_type_check;
ALTER TABLE public.organizer_transactions ADD CONSTRAINT organizer_transactions_type_check
  CHECK (type = ANY (ARRAY['credit'::text, 'debit'::text, 'payout'::text, 'cancelled_payout_refund'::text,
                           'refund'::text, 'representative_reward'::text, 'representative_reward_reversal'::text,
                           'payout_reversal'::text]));

-- At most one payout ledger row and one reversal row per request.
CREATE UNIQUE INDEX IF NOT EXISTS organizer_transactions_payout_once
  ON public.organizer_transactions (withdrawal_request_id) WHERE type = 'payout';
CREATE UNIQUE INDEX IF NOT EXISTS organizer_transactions_payout_reversal_once
  ON public.organizer_transactions (withdrawal_request_id) WHERE type = 'payout_reversal';
-- A transfer reference names exactly one request.
CREATE UNIQUE INDEX IF NOT EXISTS organizer_withdrawal_requests_reference_once
  ON public.organizer_withdrawal_requests (paystack_reference) WHERE paystack_reference IS NOT NULL;

-- The fixed Paystack reference for a request.
CREATE OR REPLACE FUNCTION public.payout_transfer_reference(p_request_id uuid)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO ''
AS $$ SELECT 'payout_' || replace(p_request_id::text, '-', '') $$;

-- ---------------------------------------------------------------------------
-- Claim: attaches the fixed reference (P0-3)
-- ---------------------------------------------------------------------------
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
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing', resolved_by = auth.uid(), updated_at = now(),
      paystack_reference = COALESCE(public.organizer_withdrawal_requests.paystack_reference,
                                    public.payout_transfer_reference(p_request_id))
  WHERE id = p_request_id AND public.organizer_withdrawal_requests.status = 'pending'
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

-- ---------------------------------------------------------------------------
-- Mark sent: must match the claimed request and its reference (P0-3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_rows int;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_paystack_reference IS DISTINCT FROM public.payout_transfer_reference(p_request_id) THEN
    RAISE EXCEPTION 'Transfer reference does not belong to this payout request';
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET paystack_reference = p_paystack_reference,
      transfer_code = COALESCE(p_transfer_code, transfer_code),
      updated_at = now()
  WHERE id = p_request_id AND status = 'processing'
    AND (transfer_code IS NULL OR p_transfer_code IS NULL OR transfer_code = p_transfer_code);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Payout request is not processing or already has a different transfer';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'approve_payout_request',
          jsonb_build_object('request_id', p_request_id, 'transfer_code', p_transfer_code, 'reference', p_paystack_reference),
          public.actor_role());
END;
$function$;

-- ---------------------------------------------------------------------------
-- Release back to pending: only when no transfer code exists. The reference
-- is kept, so a later approval reuses it and Paystack refuses a duplicate.
-- ---------------------------------------------------------------------------
-- p_reason keeps its DEFAULT NULL: production's definition (0004) has it,
-- and CREATE OR REPLACE cannot remove a parameter default.
CREATE OR REPLACE FUNCTION public.admin_release_payout_claim(p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_rows int;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'pending', updated_at = now()
  WHERE id = p_request_id AND status = 'processing' AND transfer_code IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Only a processing request with no Paystack transfer can be released';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'release_payout_claim', jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END;
$function$;

-- ---------------------------------------------------------------------------
-- Cancel: never once a transfer may exist (P0-1); no ledger credit (P1-6)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_current public.organizer_withdrawal_requests;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT * INTO v_current FROM public.organizer_withdrawal_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF v_current.status <> 'processing' THEN
    RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_current.status;
  END IF;
  IF v_current.transfer_code IS NOT NULL OR v_current.paystack_reference IS NOT NULL THEN
    RAISE EXCEPTION 'A Paystack transfer may exist for this request. Use Reconcile: Paystack decides whether it was paid.';
  END IF;

  UPDATE public.organizer_withdrawal_requests r
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE r.id = p_request_id
  RETURNING r.organizer_id, r.amount_kobo INTO v_organizer_id, v_amount_kobo;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_wallets.organizer_id = v_organizer_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'cancel_processing_payout', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Complete: also settles a request cancelled while its transfer was live
-- (P0-1). Money that was returned to the balance is taken back from the
-- available balance; anything already re-withdrawn is logged as a shortfall.
-- ---------------------------------------------------------------------------
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
  v_balance bigint;
  v_debit bigint;
BEGIN
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status, b.bank_name, b.account_number, b.account_name
    INTO v_id, v_organizer_id, v_amount_kobo, v_status, v_bank_name, v_account_number, v_account_name
  FROM public.organizer_withdrawal_requests r
  LEFT JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE OF r;
  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  IF v_status IN ('completed', 'reversed') THEN
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_amount_kobo
    FROM public.users u WHERE u.id = v_organizer_id;
    RETURN;
  END IF;
  IF v_status IN ('failed', 'rejected') THEN
    -- Not expected from Paystack; record it for an admin, change nothing.
    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (auth.uid(), 'payout_success_after_final_state', v_organizer_id,
            jsonb_build_object('request_id', v_id, 'status', v_status, 'lookup_key', p_request_id),
            COALESCE(public.actor_role(), 'system:project_admin'));
    RETURN QUERY SELECT 'needs_review'::text, NULL::text, NULL::text, v_amount_kobo;
    RETURN;
  END IF;

  SELECT w.balance_kobo INTO v_balance FROM public.organizer_wallets w
   WHERE w.organizer_id = v_organizer_id FOR UPDATE;

  IF v_status = 'cancelled' THEN
    -- The cancel returned the money to the balance; the transfer went out anyway.
    v_debit := LEAST(COALESCE(v_balance, 0), v_amount_kobo);
    UPDATE public.organizer_wallets
    SET balance_kobo = balance_kobo - v_debit,
        total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo,
        updated_at = now()
    WHERE organizer_wallets.organizer_id = v_organizer_id;
    IF v_debit < v_amount_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (auth.uid(), 'payout_recovery_shortfall', v_organizer_id,
              jsonb_build_object('request_id', v_id, 'amount_kobo', v_amount_kobo, 'recovered_kobo', v_debit,
                                 'shortfall_kobo', v_amount_kobo - v_debit),
              COALESCE(public.actor_role(), 'system:project_admin'));
    END IF;
  ELSE
    v_debit := v_amount_kobo;
    UPDATE public.organizer_wallets
    SET pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
        total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo,
        updated_at = now()
    WHERE organizer_wallets.organizer_id = v_organizer_id;
  END IF;

  UPDATE public.organizer_withdrawal_requests SET status = 'completed', updated_at = now() WHERE id = v_id;

  INSERT INTO public.organizer_transactions
    (organizer_id, type, amount_kobo, description, withdrawal_request_id, metadata)
  VALUES (
    v_organizer_id, 'payout', v_debit,
    'Withdrawal to ' || COALESCE(v_bank_name, 'bank account') || ' — completed',
    v_id,
    jsonb_build_object('bank_name', v_bank_name, 'account_number', v_account_number, 'account_name', v_account_name,
                       'transfer_amount_kobo', v_amount_kobo, 'previous_status', v_status)
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'complete_payout', v_organizer_id,
          jsonb_build_object('request_id', v_id, 'lookup_key', p_request_id, 'previous_status', v_status,
                             'new_status', 'completed', 'amount_kobo', v_amount_kobo, 'ledger_debit_kobo', v_debit,
                             'bank_name', v_bank_name, 'account_number', v_account_number),
          COALESCE(public.actor_role(), 'system:project_admin'));

  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Reversal of a transfer (P0-2). Before completion it is a failure; after
-- completion the money returns to the available balance.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_organizer_payout(p_request_id text, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_req public.organizer_withdrawal_requests;
BEGIN
  SELECT * INTO v_req FROM public.organizer_withdrawal_requests r
   WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_req.status IN ('pending', 'processing') THEN
    RETURN QUERY SELECT * FROM public.fail_organizer_payout(p_request_id, p_reason);
    RETURN;
  END IF;
  IF v_req.status <> 'completed' THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.organizer_withdrawal_requests r
  SET status = 'reversed', admin_note = COALESCE(p_reason, r.admin_note), updated_at = now()
  WHERE r.id = v_req.id;

  UPDATE public.organizer_wallets w
  SET balance_kobo = w.balance_kobo + v_req.amount_kobo,
      total_withdrawn_kobo = GREATEST(0, COALESCE(w.total_withdrawn_kobo, 0) - v_req.amount_kobo),
      updated_at = now()
  WHERE w.organizer_id = v_req.organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id)
  VALUES (v_req.organizer_id, 'payout_reversal', v_req.amount_kobo,
          'Withdrawal reversed by the bank — returned to your available balance', v_req.id);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reverse_payout', v_req.organizer_id,
          jsonb_build_object('request_id', v_req.id, 'lookup_key', p_request_id, 'amount_kobo', v_req.amount_kobo, 'reason', p_reason),
          COALESCE(public.actor_role(), 'system:project_admin'));

  RETURN QUERY
  SELECT 'reversed'::text, u.email, u.full_name, v_req.amount_kobo
  FROM public.users u WHERE u.id = v_req.organizer_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Reconciliation report (P1-6): read-only, admins only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_earnings_reconciliation()
 RETURNS TABLE(organizer_id uuid, balance_kobo bigint, pending_kobo bigint, ledger_net_kobo bigint,
               ledger_gap_kobo bigint, open_requests_kobo bigint, pending_gap_kobo bigint,
               stale_processing integer, issues text[])
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH led AS (
    SELECT t.organizer_id,
           SUM(CASE WHEN t.type IN ('credit', 'representative_reward', 'payout_reversal', 'cancelled_payout_refund')
                    THEN t.amount_kobo ELSE 0 END)
         - SUM(CASE WHEN t.type IN ('payout', 'refund', 'debit', 'representative_reward_reversal')
                    THEN t.amount_kobo ELSE 0 END) AS net
      FROM public.organizer_transactions t GROUP BY t.organizer_id
  ), req AS (
    SELECT r.organizer_id,
           COALESCE(SUM(r.amount_kobo) FILTER (WHERE r.status IN ('pending', 'processing')), 0) AS open_kobo,
           COUNT(*) FILTER (WHERE r.status = 'processing' AND r.updated_at < now() - interval '1 day')::int AS stale
      FROM public.organizer_withdrawal_requests r GROUP BY r.organizer_id
  )
  SELECT w.organizer_id, w.balance_kobo, w.pending_kobo, COALESCE(l.net, 0),
         COALESCE(l.net, 0) - (w.balance_kobo + w.pending_kobo),
         COALESCE(q.open_kobo, 0), w.pending_kobo - COALESCE(q.open_kobo, 0), COALESCE(q.stale, 0),
         array_remove(ARRAY[
           CASE WHEN COALESCE(l.net, 0) <> w.balance_kobo + w.pending_kobo THEN 'ledger_does_not_match_balance' END,
           CASE WHEN w.pending_kobo <> COALESCE(q.open_kobo, 0) THEN 'pending_does_not_match_open_requests' END,
           CASE WHEN w.balance_kobo < 0 OR w.pending_kobo < 0 THEN 'negative_balance' END,
           CASE WHEN COALESCE(q.stale, 0) > 0 THEN 'processing_over_a_day' END
         ], NULL)
    FROM public.organizer_wallets w
    LEFT JOIN led l ON l.organizer_id = w.organizer_id
    LEFT JOIN req q ON q.organizer_id = w.organizer_id
   WHERE public.is_admin()
$function$;

-- ---------------------------------------------------------------------------
-- Grants: unchanged for replaced functions; new functions are server-only
-- except the admin report.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.reverse_organizer_payout(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payout_transfer_reference(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_earnings_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_earnings_reconciliation() TO authenticated;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin') THEN
    GRANT EXECUTE ON FUNCTION public.reverse_organizer_payout(text, text) TO project_admin;
    GRANT EXECUTE ON FUNCTION public.payout_transfer_reference(uuid) TO project_admin;
  END IF;
END
$grants$;
