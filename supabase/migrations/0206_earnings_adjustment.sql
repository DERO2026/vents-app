-- 0206: audited two-admin earnings adjustments (Batch D D3 / T2).
--
-- STATUS: NOT APPLIED to production. Apply only after 0201 -> 0202 -> 0203
-- -> 0205, in its own transaction, never with `supabase db push`. Applying
-- it changes no wallet, ledger row or request. Undo (only while no
-- adjustment has been executed): supabase/rollback/undo_0206.sql.
--
-- The only sanctioned way to correct an earnings wallet or its ledger. It
-- replaces the untracked direct writes behind the Batch D gaps (§9-§10).
-- It is built on the existing maker-checker:
--   request_admin_action('earnings_adjustment', 'user', <organizer>, ...)
--     -> approve_admin_action(<request>)   (super admin, not the requester)
--     -> execute_earnings_adjustment(<request>)   (this file; not client-callable)
-- exactly like 0203's authorize_withdrawal.
--
-- Kinds (payload.kind):
--   ledger_only           one adjustment_credit / adjustment_debit ledger row;
--                         NO wallet change. Explains or corrects history (e.g.
--                         reversing a spurious ledger credit).
--   wallet_credit         adjustment_credit row + balance_kobo and
--                         total_earned_kobo += amount.
--   wallet_debit          adjustment_debit row + balance_kobo and
--                         total_earned_kobo -= amount. Only from the AVAILABLE
--                         balance; never from pending or held money; never
--                         below zero.
--   late_recorded_payout  records a payout Paystack made that VENTS never
--                         recorded (the 2026-07 incident): one 'payout' row
--                         linked to the withdrawal request, total_withdrawn
--                         += amount, balance unchanged, request status
--                         unchanged, its payout_exceptions rows resolved.
--
-- Rules enforced at execution, inside the approval transaction:
--   * two distinct admins: the requester must still be an admin; the
--     approver a super admin (approve_admin_action) who is not the requester;
--     neither may be the wallet owner (also a table CHECK);
--   * the payload carries the wallet snapshot the requester reviewed
--     (balance, pending, on hold, ledger net). Execution is refused if any of
--     them changed since: no stale approvals;
--   * the request must be under 7 days old;
--   * amount > 0 and at most earnings_adjustment_cap_kobo() (NGN 50,000);
--   * mandatory reason (>= 20 characters) and evidence reference;
--   * idempotent: one adjustment per admin request (UNIQUE), and the request
--     is consumed by the approval;
--   * append-only: adjustments are never updated or deleted, and adjustment
--     ledger rows can only be inserted by the executor and never changed;
--     created_at is always now() (nothing is back-dated);
--   * every adjustment is audited (admin_logs + full details on the ledger
--     row and the adjustment record).

-- ---------------------------------------------------------------------------
-- Prerequisites (objects only; no body pinning)
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF to_regprocedure('public.execute_withdrawal_authorization(uuid)') IS NULL THEN
    RAISE EXCEPTION '0206: apply 0203 first (execute_withdrawal_authorization missing)';
  END IF;
  IF to_regprocedure('public.organizer_withdrawal_requests_guard()') IS NULL THEN
    RAISE EXCEPTION '0206: apply 0205 first (organizer_withdrawal_requests_guard missing)';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Ledger types
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizer_transactions DROP CONSTRAINT organizer_transactions_type_check;
ALTER TABLE public.organizer_transactions ADD CONSTRAINT organizer_transactions_type_check
  CHECK (type = ANY (ARRAY['credit'::text, 'debit'::text, 'payout'::text, 'cancelled_payout_refund'::text,
                           'refund'::text, 'representative_reward'::text, 'representative_reward_reversal'::text,
                           'payout_reversal'::text, 'recovery_deduction'::text,
                           'adjustment_credit'::text, 'adjustment_debit'::text]));

-- ---------------------------------------------------------------------------
-- The adjustment record (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.earnings_adjustments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_request_id       uuid NOT NULL UNIQUE REFERENCES public.admin_action_requests(id) ON DELETE RESTRICT,
  organizer_id           uuid NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('ledger_only', 'wallet_credit', 'wallet_debit', 'late_recorded_payout')),
  direction              text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_kobo            bigint NOT NULL CHECK (amount_kobo > 0),
  reason                 text NOT NULL CHECK (length(btrim(reason)) >= 20),
  evidence_ref           text NOT NULL CHECK (length(btrim(evidence_ref)) > 0),
  withdrawal_request_id  uuid REFERENCES public.organizer_withdrawal_requests(id) ON DELETE RESTRICT,
  ledger_transaction_id  uuid NOT NULL,
  requested_by           uuid NOT NULL,
  approved_by            uuid NOT NULL,
  balance_before_kobo    bigint NOT NULL,
  balance_after_kobo     bigint NOT NULL,
  ledger_net_before_kobo bigint NOT NULL,
  ledger_net_after_kobo  bigint NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earnings_adjustments_two_admins
    CHECK (requested_by <> approved_by AND requested_by <> organizer_id AND approved_by <> organizer_id),
  CONSTRAINT earnings_adjustments_late_payout_link
    CHECK ((kind = 'late_recorded_payout') = (withdrawal_request_id IS NOT NULL))
);
ALTER TABLE public.earnings_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.earnings_adjustments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.earnings_adjustments_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'earnings_adjustments is append-only: % is not allowed', TG_OP;
END;
$function$;
REVOKE ALL ON FUNCTION public.earnings_adjustments_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS earnings_adjustments_append_only ON public.earnings_adjustments;
CREATE TRIGGER earnings_adjustments_append_only
  BEFORE UPDATE OR DELETE ON public.earnings_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.earnings_adjustments_append_only();

-- Adjustment ledger rows: only the executor inserts them; nobody changes them.
CREATE OR REPLACE FUNCTION public.organizer_transactions_adjustment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.type IN ('adjustment_credit', 'adjustment_debit')
       AND current_setting('vents.earnings_adjustment_executor', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Adjustment ledger rows can only be written by an approved earnings_adjustment';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.type IN ('adjustment_credit', 'adjustment_debit')
     OR (OLD.metadata ? 'earnings_adjustment_id') THEN
    RAISE EXCEPTION 'Ledger row % was written by an earnings adjustment and cannot be % (append-only)', OLD.id, lower(TG_OP);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
REVOKE ALL ON FUNCTION public.organizer_transactions_adjustment_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS organizer_transactions_adjustment_guard ON public.organizer_transactions;
CREATE TRIGGER organizer_transactions_adjustment_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.organizer_transactions
  FOR EACH ROW EXECUTE FUNCTION public.organizer_transactions_adjustment_guard();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.earnings_adjustment_cap_kobo()
 RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path TO ''
AS $$ SELECT 5000000::bigint $$;   -- NGN 50,000 per adjustment; larger needs a migration

-- The ledger net exactly as admin_earnings_reconciliation() counts it.
CREATE OR REPLACE FUNCTION public.earnings_ledger_net_kobo(p_organizer_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(SUM(CASE WHEN t.type IN ('credit', 'representative_reward', 'payout_reversal', 'cancelled_payout_refund', 'adjustment_credit')
                           THEN t.amount_kobo ELSE 0 END)
                - SUM(CASE WHEN t.type IN ('payout', 'refund', 'debit', 'representative_reward_reversal', 'recovery_deduction', 'adjustment_debit')
                           THEN t.amount_kobo ELSE 0 END), 0)::bigint
    FROM public.organizer_transactions t WHERE t.organizer_id = p_organizer_id
$function$;

-- ---------------------------------------------------------------------------
-- Requester helper: validates and snapshots server-side, then files the
-- request through the normal maker-checker. (A request filed directly with
-- request_admin_action is re-validated in full at execution.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_request_earnings_adjustment(
  p_organizer_id uuid, p_kind text, p_direction text, p_amount_kobo bigint,
  p_reason text, p_evidence_ref text, p_withdrawal_request_id uuid DEFAULT NULL,
  p_paid_at timestamptz DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  w public.organizer_wallets;
  v_payload jsonb;
  v_tc text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_organizer_id = auth.uid() THEN
    RAISE EXCEPTION 'An admin cannot request an adjustment to their own wallet';
  END IF;
  SELECT * INTO w FROM public.organizer_wallets WHERE organizer_id = p_organizer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No earnings wallet for %', p_organizer_id; END IF;
  IF p_kind = 'late_recorded_payout' THEN
    SELECT transfer_code INTO v_tc FROM public.organizer_withdrawal_requests WHERE id = p_withdrawal_request_id;
  END IF;

  v_payload := jsonb_build_object(
    'kind', p_kind, 'direction', p_direction, 'amount_kobo', p_amount_kobo,
    'reason', p_reason, 'evidence_ref', p_evidence_ref,
    'expected_balance_kobo', w.balance_kobo, 'expected_pending_kobo', w.pending_kobo,
    'expected_on_hold_kobo', w.on_hold_kobo,
    'expected_ledger_net_kobo', public.earnings_ledger_net_kobo(p_organizer_id))
    || CASE WHEN p_kind = 'late_recorded_payout' THEN jsonb_build_object(
         'withdrawal_request_id', p_withdrawal_request_id, 'transfer_code', v_tc, 'paid_at', p_paid_at)
       ELSE '{}'::jsonb END;

  -- Validate everything the executor checks that does not depend on time.
  PERFORM public.earnings_adjustment_validate(p_organizer_id, v_payload);

  RETURN public.request_admin_action('earnings_adjustment', 'user', p_organizer_id,
    p_kind || ' ' || p_direction || ' ' || p_amount_kobo || ' kobo', v_payload, NULL, NULL, NULL);
END;
$function$;

-- Shared validation (payload shape and the late-payout evidence).
CREATE OR REPLACE FUNCTION public.earnings_adjustment_validate(p_organizer_id uuid, p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  q public.organizer_withdrawal_requests;
  v_amount bigint;
BEGIN
  IF p->>'kind' IS NULL OR p->>'kind' NOT IN ('ledger_only', 'wallet_credit', 'wallet_debit', 'late_recorded_payout') THEN
    RAISE EXCEPTION 'payload.kind must be ledger_only, wallet_credit, wallet_debit or late_recorded_payout';
  END IF;
  IF p->>'direction' IS NULL OR p->>'direction' NOT IN ('credit', 'debit') THEN
    RAISE EXCEPTION 'payload.direction must be credit or debit';
  END IF;
  IF (p->>'kind' = 'wallet_credit' AND p->>'direction' <> 'credit')
     OR (p->>'kind' IN ('wallet_debit', 'late_recorded_payout') AND p->>'direction' <> 'debit') THEN
    RAISE EXCEPTION 'payload.direction % does not match kind %', p->>'direction', p->>'kind';
  END IF;
  IF jsonb_typeof(p->'amount_kobo') IS DISTINCT FROM 'number'
     OR (p->>'amount_kobo')::numeric <> trunc((p->>'amount_kobo')::numeric) THEN
    RAISE EXCEPTION 'payload.amount_kobo must be a whole number of kobo';
  END IF;
  v_amount := (p->>'amount_kobo')::bigint;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'The amount must be positive'; END IF;
  IF v_amount > public.earnings_adjustment_cap_kobo() THEN
    RAISE EXCEPTION 'The amount (%) is above the per-adjustment cap (%)', v_amount, public.earnings_adjustment_cap_kobo();
  END IF;
  IF length(btrim(COALESCE(p->>'reason', ''))) < 20 THEN
    RAISE EXCEPTION 'A reason of at least 20 characters is required';
  END IF;
  IF length(btrim(COALESCE(p->>'evidence_ref', ''))) = 0 THEN
    RAISE EXCEPTION 'An evidence reference is required';
  END IF;
  IF jsonb_typeof(p->'expected_balance_kobo') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p->'expected_pending_kobo') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p->'expected_on_hold_kobo') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p->'expected_ledger_net_kobo') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'The wallet snapshot (expected_balance/pending/on_hold/ledger_net_kobo) is required';
  END IF;

  IF p->>'kind' = 'late_recorded_payout' THEN
    SELECT * INTO q FROM public.organizer_withdrawal_requests WHERE id = (p->>'withdrawal_request_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'late_recorded_payout: withdrawal request not found'; END IF;
    IF q.organizer_id <> p_organizer_id THEN
      RAISE EXCEPTION 'late_recorded_payout: the withdrawal belongs to another organizer';
    END IF;
    IF q.status NOT IN ('cancelled', 'failed', 'rejected') THEN
      RAISE EXCEPTION 'late_recorded_payout: only a cancelled, failed or rejected request can be recorded as paid (it is %)', q.status;
    END IF;
    IF q.transfer_code IS NULL OR p->>'transfer_code' IS DISTINCT FROM q.transfer_code THEN
      RAISE EXCEPTION 'late_recorded_payout: the Paystack transfer code must match the request''s';
    END IF;
    IF v_amount <> q.amount_kobo THEN
      RAISE EXCEPTION 'late_recorded_payout: the amount must equal the request (%)', q.amount_kobo;
    END IF;
    IF p->>'paid_at' IS NULL THEN
      RAISE EXCEPTION 'late_recorded_payout: paid_at (from the Paystack record) is required';
    END IF;
    PERFORM (p->>'paid_at')::timestamptz;
    IF public.payout_cancel_returned_funds(q.id) THEN
      RAISE EXCEPTION 'late_recorded_payout: this request''s money was returned to the balance; record it as a wallet_debit instead';
    END IF;
    IF EXISTS (SELECT 1 FROM public.organizer_transactions t WHERE t.withdrawal_request_id = q.id AND t.type = 'payout') THEN
      RAISE EXCEPTION 'late_recorded_payout: a payout is already recorded for this request';
    END IF;
  ELSIF p ? 'withdrawal_request_id' THEN
    RAISE EXCEPTION 'withdrawal_request_id is only for late_recorded_payout';
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Executor: runs only inside approve_admin_action
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.execute_earnings_adjustment(p_admin_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
  w public.organizer_wallets;
  p jsonb;
  v_approver uuid := auth.uid();
  v_kind text;
  v_amount bigint;
  v_net_before bigint;
  v_type text;
  v_txn uuid;
  v_adj uuid := gen_random_uuid();
  v_balance_after bigint;
BEGIN
  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_admin_request_id;
  IF NOT FOUND OR r.action_type <> 'earnings_adjustment' THEN
    RAISE EXCEPTION 'Not an earnings adjustment request';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF v_approver IS NULL OR r.requested_by = v_approver THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;
  IF r.target_type IS DISTINCT FROM 'user' OR r.target_id IS NULL THEN
    RAISE EXCEPTION 'An earnings adjustment must target exactly one organizer (target_type user)';
  END IF;
  IF r.target_id IN (r.requested_by, v_approver) THEN
    RAISE EXCEPTION 'An admin cannot request or approve an adjustment to their own wallet';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = r.requested_by AND u.role IN ('admin', 'sub-admin'))
     AND r.requested_by <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RAISE EXCEPTION 'The requesting admin is no longer an admin';
  END IF;
  IF r.requested_at < now() - interval '7 days' THEN
    RAISE EXCEPTION 'This adjustment request is older than 7 days; file a new one';
  END IF;
  IF EXISTS (SELECT 1 FROM public.earnings_adjustments a WHERE a.admin_request_id = r.id) THEN
    RAISE EXCEPTION 'This adjustment has already been executed';
  END IF;

  p := r.payload;
  PERFORM public.earnings_adjustment_validate(r.target_id, p);
  v_kind := p->>'kind';
  v_amount := (p->>'amount_kobo')::bigint;

  SELECT * INTO w FROM public.organizer_wallets WHERE organizer_id = r.target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No earnings wallet for %', r.target_id; END IF;
  v_net_before := public.earnings_ledger_net_kobo(r.target_id);
  IF w.balance_kobo <> (p->>'expected_balance_kobo')::bigint
     OR w.pending_kobo <> (p->>'expected_pending_kobo')::bigint
     OR w.on_hold_kobo <> (p->>'expected_on_hold_kobo')::bigint
     OR v_net_before <> (p->>'expected_ledger_net_kobo')::bigint THEN
    RAISE EXCEPTION 'The wallet changed since this adjustment was requested (balance % / pending % / on hold % / ledger net %; reviewed % / % / % / %); file a new request',
      w.balance_kobo, w.pending_kobo, w.on_hold_kobo, v_net_before,
      p->>'expected_balance_kobo', p->>'expected_pending_kobo', p->>'expected_on_hold_kobo', p->>'expected_ledger_net_kobo';
  END IF;

  v_balance_after := w.balance_kobo;
  IF v_kind = 'wallet_credit' THEN
    v_balance_after := w.balance_kobo + v_amount;
    UPDATE public.organizer_wallets
       SET balance_kobo = balance_kobo + v_amount, total_earned_kobo = total_earned_kobo + v_amount, updated_at = now()
     WHERE organizer_id = r.target_id;
  ELSIF v_kind = 'wallet_debit' THEN
    IF w.balance_kobo < v_amount THEN
      RAISE EXCEPTION 'The available balance (%) is below the debit (%); pending and held money cannot be debited', w.balance_kobo, v_amount;
    END IF;
    IF w.total_earned_kobo < v_amount THEN
      RAISE EXCEPTION 'The earned total (%) is below the debit (%)', w.total_earned_kobo, v_amount;
    END IF;
    v_balance_after := w.balance_kobo - v_amount;
    UPDATE public.organizer_wallets
       SET balance_kobo = balance_kobo - v_amount, total_earned_kobo = total_earned_kobo - v_amount, updated_at = now()
     WHERE organizer_id = r.target_id;
  ELSIF v_kind = 'late_recorded_payout' THEN
    UPDATE public.organizer_wallets
       SET total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount, updated_at = now()
     WHERE organizer_id = r.target_id;
  END IF;

  v_type := CASE WHEN v_kind = 'late_recorded_payout' THEN 'payout'
                 WHEN p->>'direction' = 'credit' THEN 'adjustment_credit'
                 ELSE 'adjustment_debit' END;
  PERFORM set_config('vents.earnings_adjustment_executor', 'on', true);
  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id, metadata)
  VALUES (r.target_id, v_type, v_amount,
          CASE v_kind
            WHEN 'late_recorded_payout' THEN 'Payout recorded late (paid by Paystack ' || (p->>'paid_at') || ')'
            ELSE 'Earnings adjustment (' || v_kind || '): ' || (p->>'reason') END,
          CASE WHEN v_kind = 'late_recorded_payout' THEN (p->>'withdrawal_request_id')::uuid END,
          jsonb_build_object('earnings_adjustment_id', v_adj, 'admin_request_id', r.id, 'kind', v_kind,
                             'requested_by', r.requested_by, 'approved_by', v_approver,
                             'reason', p->>'reason', 'evidence_ref', p->>'evidence_ref')
          || CASE WHEN v_kind = 'late_recorded_payout'
                  THEN jsonb_build_object('recorded_late', true, 'paid_at', p->>'paid_at', 'transfer_code', p->>'transfer_code')
                  ELSE '{}'::jsonb END)
  RETURNING id INTO v_txn;
  PERFORM set_config('vents.earnings_adjustment_executor', 'off', true);

  INSERT INTO public.earnings_adjustments (id, admin_request_id, organizer_id, kind, direction, amount_kobo, reason, evidence_ref,
    withdrawal_request_id, ledger_transaction_id, requested_by, approved_by,
    balance_before_kobo, balance_after_kobo, ledger_net_before_kobo, ledger_net_after_kobo)
  VALUES (v_adj, r.id, r.target_id, v_kind, p->>'direction', v_amount, p->>'reason', p->>'evidence_ref',
    CASE WHEN v_kind = 'late_recorded_payout' THEN (p->>'withdrawal_request_id')::uuid END, v_txn,
    r.requested_by, v_approver, w.balance_kobo, v_balance_after, v_net_before, public.earnings_ledger_net_kobo(r.target_id));

  IF v_kind = 'late_recorded_payout' THEN
    UPDATE public.payout_exceptions
       SET resolved_at = now(), resolved_by = v_approver,
           resolution = 'Recorded as a late payout by earnings adjustment ' || v_adj
     WHERE request_id = (p->>'withdrawal_request_id')::uuid AND resolved_at IS NULL;
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_approver, 'earnings_adjustment_applied', r.target_id,
          jsonb_build_object('earnings_adjustment_id', v_adj, 'admin_request_id', r.id, 'kind', v_kind,
                             'direction', p->>'direction', 'amount_kobo', v_amount,
                             'requested_by', r.requested_by, 'approved_by', v_approver,
                             'balance_before_kobo', w.balance_kobo, 'balance_after_kobo', v_balance_after,
                             'ledger_net_before_kobo', v_net_before, 'ledger_transaction_id', v_txn,
                             'reason', p->>'reason', 'evidence_ref', p->>'evidence_ref',
                             'withdrawal_request_id', p->>'withdrawal_request_id'),
          public.actor_role());
END;
$function$;

-- ---------------------------------------------------------------------------
-- Wire into the maker-checker and the reconciliation (anchored, idempotent)
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_anchor text;
  v_count integer;
BEGIN
  v_def := pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);
  IF position('execute_earnings_adjustment' IN v_def) = 0 THEN
    v_anchor := E'      ELSIF r.action_type = ''resolve_booking_dispute'' THEN\n';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION '0206: approve_admin_action anchor found % times (expected 1; is 0203 applied?)', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor,
      E'      ELSIF r.action_type = ''earnings_adjustment'' THEN\n' ||
      E'        PERFORM public.execute_earnings_adjustment(r.id);\n' || v_anchor);
  END IF;

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position('earnings_adjustment' IN v_def) = 0 THEN
    v_anchor := E'''authorize_withdrawal'', ''resolve_booking_dispute''';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION '0206: request_admin_action anchor found % times (expected 1; is 0203 applied?)', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor, v_anchor || E', ''earnings_adjustment''');
  END IF;

  v_def := pg_get_functiondef('public.admin_earnings_reconciliation()'::regprocedure);
  IF position('adjustment_credit' IN v_def) = 0 THEN
    v_anchor := E'''payout_reversal'', ''cancelled_payout_refund'')';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN RAISE EXCEPTION '0206: reconciliation credit anchor found % times', v_count; END IF;
    v_def := replace(v_def, v_anchor, E'''payout_reversal'', ''cancelled_payout_refund'', ''adjustment_credit'')');
    v_anchor := E'''representative_reward_reversal'', ''recovery_deduction'')';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN RAISE EXCEPTION '0206: reconciliation debit anchor found % times', v_count; END IF;
    v_def := replace(v_def, v_anchor, E'''representative_reward_reversal'', ''recovery_deduction'', ''adjustment_debit'')');
    EXECUTE v_def;
  END IF;
END
$patch$;

-- ---------------------------------------------------------------------------
-- Grants: only the requester helper is client-callable (admins, checked inside).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.execute_earnings_adjustment(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.earnings_adjustment_validate(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.earnings_ledger_net_kobo(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.earnings_adjustment_cap_kobo() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_request_earnings_adjustment(uuid, text, text, bigint, text, text, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_request_earnings_adjustment(uuid, text, text, bigint, text, text, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.earnings_adjustment_cap_kobo() TO authenticated;
