-- 0203: approved VENTS earnings policies (2026-10-30).
--
-- NOT applied to production. Requires 0201 and 0202. Ship together with
-- the matching frontend (checkout shows 4%; wallet shows held earnings).
--
-- 1. Refund shortfalls are recovered from future earnings.
--    A refund debits the sale's own held earnings first, then the available
--    balance. Anything still owed is an earnings_recoveries row (a
--    receivable, with an admin log entry). It is deducted from the
--    organizer's next released earnings, and from any later available
--    money, as ledger rows of type 'recovery_deduction'. Balances never go
--    negative and nothing is absorbed silently.
-- 2. Organizer and service-provider earnings are held for 7 days.
--    A ticket sale or booking credit goes to on_hold_kobo (one
--    earnings_holds row per order or booking) and moves to the withdrawable
--    balance 7 days after payment confirmation. It moves when
--    settle_earnings runs: on a withdrawal request, when the owner opens
--    their wallet, and in the daily cron. Balances that already exist
--    before this migration stay available.
--    Representative rewards keep their own 0201 hold. A reversed payout
--    returns to the available balance.
-- 3. Withdrawals need two admins.
--    Admin A calls request_admin_action('authorize_withdrawal', ...).
--    Admin B approves it with approve_admin_action. Self-approval is already
--    refused there. The organizer can be neither admin. The approval binds
--    the amount and the bank recipient. admin_claim_payout_for_processing
--    (the only path to Paystack) refuses an unauthorized request, and
--    refuses one whose bank recipient changed after approval.
-- 4. (Representative rewards: verified organizer and event; in 0201.)
-- 5. Tickets: the buyer pays face + 4% service fee, and the organizer is
--    settled face - 5% commission.
--    Every ticket and pending purchase records its fee_model. Rows that
--    exist before this migration are 'legacy_5' (the buyer paid face + 5%;
--    the organizer got face), and every amount on them is computed exactly
--    as before: confirmation, refund, organizer debit. New rows are
--    'v2_4_5'. No historical amount is rewritten.
--
-- Live functions are patched in place: anchored text replacements on the
-- current definition. Each patch is pinned to the md5 of the production body
-- it was written against (read-only, 2026-10-30), and the migration refuses
-- to run against a function that has drifted. Bodies, signatures and grants
-- are otherwise unchanged. Patched bodies carry a "[0203]" marker, so
-- re-running the migration is a no-op.

-- ---------------------------------------------------------------------------
-- Patch helper (session-local)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.vents_0203_patch(p_fn regprocedure, p_expect_md5 text, p_edits text[])
 RETURNS void
 LANGUAGE plpgsql
AS $f$
DECLARE
  v_src text;
  v_def text;
  v_n integer;
  i integer;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = p_fn;
  IF position('[0203]' IN v_src) > 0 THEN
    RETURN;  -- already patched
  END IF;
  IF p_expect_md5 IS NOT NULL AND md5(v_src) <> p_expect_md5 THEN
    RAISE EXCEPTION '0203: % differs from the definition this migration was written against (md5 %, expected %); refusing to patch',
      p_fn, md5(v_src), p_expect_md5;
  END IF;
  v_def := pg_get_functiondef(p_fn);
  FOR i IN 1 .. array_length(p_edits, 1) BY 2 LOOP
    v_n := (length(v_def) - length(replace(v_def, p_edits[i], ''))) / length(p_edits[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '0203: anchor % of % found % times (expected 1); refusing to patch', (i + 1) / 2, p_fn, v_n;
    END IF;
    v_def := replace(v_def, p_edits[i], p_edits[i + 1]);
  END LOOP;
  v_n := (length(v_def) - length(replace(v_def, E'AS $function$\n', ''))) / length(E'AS $function$\n');
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0203: body delimiter of % found % times', p_fn, v_n;
  END IF;
  EXECUTE replace(v_def, E'AS $function$\n', E'AS $function$\n-- [0203] patched by 0203_earnings_policies.sql\n');
END;
$f$;

-- ---------------------------------------------------------------------------
-- Rule 5: fee model per ticket
-- ---------------------------------------------------------------------------
-- Existing rows get 'legacy_5' through the column default at ADD time (no
-- UPDATE, so no row triggers fire); new rows default to 'v2_4_5'.
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS fee_model text NOT NULL DEFAULT 'legacy_5';
ALTER TABLE public.tickets ALTER COLUMN fee_model SET DEFAULT 'v2_4_5';
ALTER TABLE public.pending_purchases ADD COLUMN IF NOT EXISTS fee_model text NOT NULL DEFAULT 'legacy_5';
ALTER TABLE public.pending_purchases ALTER COLUMN fee_model SET DEFAULT 'v2_4_5';
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_fee_model_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_fee_model_check CHECK (fee_model IN ('legacy_5', 'v2_4_5'));
ALTER TABLE public.pending_purchases DROP CONSTRAINT IF EXISTS pending_purchases_fee_model_check;
ALTER TABLE public.pending_purchases ADD CONSTRAINT pending_purchases_fee_model_check CHECK (fee_model IN ('legacy_5', 'v2_4_5'));

-- Buyer pays face * multiplier (before any promo discount, as before).
CREATE OR REPLACE FUNCTION public.ticket_fee_buyer_multiplier(p_fee_model text)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  RETURN CASE p_fee_model WHEN 'v2_4_5' THEN 1.04 WHEN 'legacy_5' THEN 1.05
         ELSE NULL END;
END;
$function$;

-- VENTS organizer commission on a face value (kobo). legacy_5 had none.
CREATE OR REPLACE FUNCTION public.ticket_fee_commission_kobo(p_face_kobo bigint, p_fee_model text)
 RETURNS bigint
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_fee_model = 'v2_4_5' THEN
    RETURN round(GREATEST(COALESCE(p_face_kobo, 0), 0) * 5 / 100.0)::bigint;
  ELSIF p_fee_model = 'legacy_5' THEN
    RETURN 0;
  END IF;
  RAISE EXCEPTION 'Unknown ticket fee model: %', p_fee_model;
END;
$function$;

-- A ticket's fee model comes from the purchase it was bought through and
-- never changes afterwards (callers cannot choose it).
CREATE OR REPLACE FUNCTION public.tickets_fee_model_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'tickets' THEN
      NEW.fee_model := COALESCE(
        (SELECT pp.fee_model FROM public.pending_purchases pp WHERE pp.payment_ref = NEW.payment_ref),
        'v2_4_5');
    ELSE
      NEW.fee_model := 'v2_4_5';
    END IF;
  ELSIF NEW.fee_model IS DISTINCT FROM OLD.fee_model THEN
    RAISE EXCEPTION 'fee_model cannot be changed';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS tickets_fee_model_guard ON public.tickets;
CREATE TRIGGER tickets_fee_model_guard BEFORE INSERT OR UPDATE OF fee_model ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.tickets_fee_model_guard();
DROP TRIGGER IF EXISTS pending_purchases_fee_model_guard ON public.pending_purchases;
CREATE TRIGGER pending_purchases_fee_model_guard BEFORE INSERT OR UPDATE OF fee_model ON public.pending_purchases
  FOR EACH ROW EXECUTE FUNCTION public.tickets_fee_model_guard();

-- 0201's nominal-fee helper, per fee model: what VENTS gives up when a
-- ticket is refunded (legacy: 5% buyer fee; v2: 4% fee + 5% commission).
CREATE OR REPLACE FUNCTION public.earn_ticket_nominal_fee_kobo(p_amount numeric, p_fee_model text)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT GREATEST(0, ceil(COALESCE(p_amount, 0) * CASE WHEN p_fee_model = 'v2_4_5' THEN 9 ELSE 5 END))::bigint;
$function$;

-- ---------------------------------------------------------------------------
-- Rules 1 and 2: holds, recoveries, ledger
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizer_wallets ADD COLUMN IF NOT EXISTS on_hold_kobo bigint NOT NULL DEFAULT 0;
ALTER TABLE public.organizer_wallets DROP CONSTRAINT IF EXISTS organizer_wallets_on_hold_nonneg;
ALTER TABLE public.organizer_wallets ADD CONSTRAINT organizer_wallets_on_hold_nonneg CHECK (on_hold_kobo >= 0);

-- Keeps every type 0201/0202 allow, plus deductions that recover a refund
-- shortfall from later earnings.
ALTER TABLE public.organizer_transactions DROP CONSTRAINT organizer_transactions_type_check;
ALTER TABLE public.organizer_transactions ADD CONSTRAINT organizer_transactions_type_check
  CHECK (type = ANY (ARRAY['credit'::text, 'debit'::text, 'payout'::text, 'cancelled_payout_refund'::text,
                           'refund'::text, 'representative_reward'::text, 'representative_reward_reversal'::text,
                           'payout_reversal'::text, 'recovery_deduction'::text]));

-- One row per held credit (a ticket order or a service booking).
-- original = still held + refunded from the hold + released.
CREATE TABLE IF NOT EXISTS public.earnings_holds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  source_kind   text NOT NULL CHECK (source_kind IN ('ticket_sale', 'service_booking')),
  source_key    text NOT NULL,
  original_kobo bigint NOT NULL CHECK (original_kobo > 0),
  amount_kobo   bigint NOT NULL CHECK (amount_kobo >= 0),
  refunded_kobo bigint NOT NULL DEFAULT 0 CHECK (refunded_kobo >= 0),
  released_kobo bigint NOT NULL DEFAULT 0 CHECK (released_kobo >= 0),
  release_at    timestamptz NOT NULL,
  released_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earnings_holds_source_once UNIQUE (source_kind, source_key),
  CONSTRAINT earnings_holds_adds_up CHECK (amount_kobo + refunded_kobo + released_kobo = original_kobo),
  CONSTRAINT earnings_holds_released_empty CHECK (released_at IS NULL OR amount_kobo = 0)
);
CREATE INDEX IF NOT EXISTS earnings_holds_open_by_owner ON public.earnings_holds (owner_id, release_at) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS earnings_holds_open_by_release ON public.earnings_holds (release_at) WHERE released_at IS NULL;

-- Money an owner still owes VENTS (a refund or payout their wallet could not
-- cover at the time). Recovered from later earnings, never forgiven here.
CREATE TABLE IF NOT EXISTS public.earnings_recoveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  source_kind    text NOT NULL CHECK (source_kind IN ('ticket_refund', 'service_booking_refund', 'payout_after_cancel')),
  source_key     text NOT NULL,
  amount_kobo    bigint NOT NULL CHECK (amount_kobo > 0),
  recovered_kobo bigint NOT NULL DEFAULT 0 CHECK (recovered_kobo >= 0),
  reason         text NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz,
  CONSTRAINT earnings_recoveries_source_once UNIQUE (source_kind, source_key),
  CONSTRAINT earnings_recoveries_bounded CHECK (recovered_kobo <= amount_kobo),
  CONSTRAINT earnings_recoveries_settled CHECK ((settled_at IS NOT NULL) = (recovered_kobo = amount_kobo))
);
CREATE INDEX IF NOT EXISTS earnings_recoveries_open_by_owner ON public.earnings_recoveries (owner_id, created_at) WHERE settled_at IS NULL;

ALTER TABLE public.earnings_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earnings_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.earnings_holds, public.earnings_recoveries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.earnings_holds, public.earnings_recoveries TO authenticated;
DROP POLICY IF EXISTS earnings_holds_owner_or_admin_read ON public.earnings_holds;
CREATE POLICY earnings_holds_owner_or_admin_read ON public.earnings_holds
  FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()) OR public.is_admin());
DROP POLICY IF EXISTS earnings_recoveries_owner_or_admin_read ON public.earnings_recoveries;
CREATE POLICY earnings_recoveries_owner_or_admin_read ON public.earnings_recoveries
  FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()) OR public.is_admin());

CREATE OR REPLACE FUNCTION public.earnings_hold_interval()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT interval '7 days';
$function$;

-- Called by the credit functions while they hold the wallet row lock.
CREATE OR REPLACE FUNCTION public.earnings_place_hold(p_owner uuid, p_kind text, p_key text, p_amount_kobo bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.earnings_holds (owner_id, source_kind, source_key, original_kobo, amount_kobo, release_at)
  VALUES (p_owner, p_kind, p_key, p_amount_kobo, p_amount_kobo, now() + public.earnings_hold_interval());
END;
$function$;

-- Takes what an owner owes for a refund: first from the refunded sale's own
-- held earnings, then from the available balance. The rest becomes a
-- recovery (receivable). Returns the amount actually debited, which is what
-- the 'refund' ledger row records. Callers already lock the ticket/booking,
-- so a refund runs once; the unique recovery source is a second guard.
CREATE OR REPLACE FUNCTION public.earnings_debit_for_refund(
  p_owner uuid, p_owed_kobo bigint, p_hold_kind text, p_hold_key text,
  p_recovery_kind text, p_recovery_key text, p_description text, p_ticket_sale_id uuid,
  p_metadata jsonb, p_actor uuid, p_actor_role text, p_shortfall_action text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance   bigint;
  v_hold      public.earnings_holds;
  v_from_hold bigint := 0;
  v_from_bal  bigint := 0;
  v_debit     bigint;
  v_short     bigint;
  v_recovery  uuid;
BEGIN
  IF p_owner IS NULL OR COALESCE(p_owed_kobo, 0) <= 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.organizer_wallets (organizer_id) VALUES (p_owner) ON CONFLICT (organizer_id) DO NOTHING;
  SELECT balance_kobo INTO v_balance FROM public.organizer_wallets WHERE organizer_id = p_owner FOR UPDATE;

  SELECT * INTO v_hold FROM public.earnings_holds
   WHERE source_kind = p_hold_kind AND source_key = p_hold_key AND owner_id = p_owner AND released_at IS NULL
   FOR UPDATE;
  IF FOUND THEN
    v_from_hold := LEAST(v_hold.amount_kobo, p_owed_kobo);
  END IF;
  v_from_bal := LEAST(GREATEST(v_balance, 0), p_owed_kobo - v_from_hold);
  v_debit := v_from_hold + v_from_bal;
  v_short := p_owed_kobo - v_debit;

  IF v_from_hold > 0 THEN
    UPDATE public.earnings_holds
       SET amount_kobo = amount_kobo - v_from_hold, refunded_kobo = refunded_kobo + v_from_hold
     WHERE id = v_hold.id;
  END IF;
  IF v_debit > 0 THEN
    UPDATE public.organizer_wallets
       SET on_hold_kobo = on_hold_kobo - v_from_hold,
           balance_kobo = balance_kobo - v_from_bal,
           updated_at = now()
     WHERE organizer_id = p_owner;
    INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id, metadata)
    VALUES (p_owner, 'refund', v_debit,
            p_description || CASE WHEN v_short > 0
              THEN ' (covered ' || v_debit || ' of ' || p_owed_kobo || ' kobo owed; ' || v_short || ' kobo to be recovered from future earnings)'
              ELSE '' END,
            p_ticket_sale_id,
            COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
              'owed_kobo', p_owed_kobo, 'from_hold_kobo', v_from_hold, 'from_available_kobo', v_from_bal,
              'to_recover_kobo', v_short));
  END IF;

  IF v_short > 0 THEN
    INSERT INTO public.earnings_recoveries (owner_id, source_kind, source_key, amount_kobo, reason, metadata)
    VALUES (p_owner, p_recovery_kind, p_recovery_key, v_short, p_description,
            COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('owed_kobo', p_owed_kobo, 'debited_kobo', v_debit))
    RETURNING id INTO v_recovery;
    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (p_actor, p_shortfall_action, p_owner,
            COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
              'owed_kobo', p_owed_kobo, 'recovered_kobo', v_debit, 'shortfall_kobo', v_short,
              'recovery_id', v_recovery, 'recovery_recorded', true),
            p_actor_role);
  END IF;

  RETURN v_debit;
END;
$function$;

-- Moves matured holds to the available balance, then deducts outstanding
-- recoveries (oldest first) from the available balance. Runs under the
-- wallet row lock, so concurrent calls serialize; a second call finds
-- nothing left to do. Returns what it moved.
CREATE OR REPLACE FUNCTION public.settle_earnings(p_owner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance  bigint;
  v_released bigint := 0;
  v_recovered bigint := 0;
  v_take     bigint;
  h public.earnings_holds;
  r public.earnings_recoveries;
BEGIN
  SELECT balance_kobo INTO v_balance FROM public.organizer_wallets WHERE organizer_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('released_kobo', 0, 'recovered_kobo', 0);
  END IF;

  FOR h IN SELECT * FROM public.earnings_holds
            WHERE owner_id = p_owner AND released_at IS NULL AND release_at <= now()
            ORDER BY release_at, id FOR UPDATE
  LOOP
    UPDATE public.earnings_holds
       SET released_at = now(), released_kobo = released_kobo + h.amount_kobo, amount_kobo = 0
     WHERE id = h.id;
    v_released := v_released + h.amount_kobo;
  END LOOP;
  v_balance := v_balance + v_released;

  FOR r IN SELECT * FROM public.earnings_recoveries
            WHERE owner_id = p_owner AND settled_at IS NULL
            ORDER BY created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_balance <= 0;
    v_take := LEAST(v_balance, r.amount_kobo - r.recovered_kobo);
    UPDATE public.earnings_recoveries
       SET recovered_kobo = recovered_kobo + v_take,
           settled_at = CASE WHEN recovered_kobo + v_take = amount_kobo THEN now() END
     WHERE id = r.id;
    INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
    VALUES (p_owner, 'recovery_deduction', v_take, 'Recovered from your earnings: ' || r.reason,
            jsonb_build_object('recovery_id', r.id, 'source_kind', r.source_kind, 'source_key', r.source_key,
                               'outstanding_before_kobo', r.amount_kobo - r.recovered_kobo));
    v_balance := v_balance - v_take;
    v_recovered := v_recovered + v_take;
  END LOOP;

  IF v_released > 0 OR v_recovered > 0 THEN
    UPDATE public.organizer_wallets
       SET on_hold_kobo = on_hold_kobo - v_released,
           balance_kobo = balance_kobo + v_released - v_recovered,
           updated_at = now()
     WHERE organizer_id = p_owner;
  END IF;

  RETURN jsonb_build_object('released_kobo', v_released, 'recovered_kobo', v_recovered);
END;
$function$;

-- Client entry point: settle the caller's own wallet.
CREATE OR REPLACE FUNCTION public.settle_my_earnings()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.check_rate_limit('settle_earnings:' || auth.uid()::text, 120, 3600);
  RETURN public.settle_earnings(auth.uid());
END;
$function$;

-- Cron entry point (server only): settles every wallet with a matured hold.
-- SKIP LOCKED leaves a wallet that is busy right now to the next run (or to
-- its owner's next withdrawal request, which settles first anyway).
CREATE OR REPLACE FUNCTION public.release_matured_earnings(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_owner uuid;
  v_res jsonb;
  v_wallets integer := 0;
  v_released bigint := 0;
  v_recovered bigint := 0;
BEGIN
  FOR v_owner IN
    SELECT w.organizer_id FROM public.organizer_wallets w
     WHERE EXISTS (SELECT 1 FROM public.earnings_holds h
                    WHERE h.owner_id = w.organizer_id AND h.released_at IS NULL AND h.release_at <= now())
     ORDER BY w.organizer_id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 5000))
     FOR UPDATE OF w SKIP LOCKED
  LOOP
    v_res := public.settle_earnings(v_owner);
    v_wallets := v_wallets + 1;
    v_released := v_released + (v_res->>'released_kobo')::bigint;
    v_recovered := v_recovered + (v_res->>'recovered_kobo')::bigint;
  END LOOP;
  RETURN jsonb_build_object('wallets', v_wallets, 'released_kobo', v_released, 'recovered_kobo', v_recovered);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Rule 5 and rules 1/2: patches to the live money functions
-- ---------------------------------------------------------------------------
--@@LIVE_PATCHES@@

--@@OWN_PATCHES@@

-- ---------------------------------------------------------------------------
-- Rule 3: two-admin authorization of every withdrawal
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizer_withdrawal_requests
  ADD COLUMN IF NOT EXISTS approval_request_id uuid REFERENCES public.admin_action_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approval_requested_by uuid,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_recipient_code text;
ALTER TABLE public.organizer_withdrawal_requests DROP CONSTRAINT IF EXISTS organizer_withdrawal_requests_two_admins;
ALTER TABLE public.organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_two_admins
  CHECK (approved_by IS NULL OR (approval_requested_by IS NOT NULL AND approved_by <> approval_requested_by
                                 AND approved_by <> organizer_id AND approval_requested_by <> organizer_id));

-- Runs only inside approve_admin_action (which already requires a super
-- admin who is not the requester, and locks the admin request row).
CREATE OR REPLACE FUNCTION public.execute_withdrawal_authorization(p_admin_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
  w public.organizer_withdrawal_requests;
  v_approver uuid := auth.uid();
  v_recipient text;
BEGIN
  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_admin_request_id;
  IF NOT FOUND OR r.action_type <> 'authorize_withdrawal' THEN
    RAISE EXCEPTION 'Not a withdrawal authorization request';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF v_approver IS NULL OR r.requested_by = v_approver THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;
  IF r.target_id IS NULL OR (r.payload ? 'request_id' AND r.payload->>'request_id' IS DISTINCT FROM r.target_id::text) THEN
    RAISE EXCEPTION 'The authorization must name exactly one withdrawal request';
  END IF;
  IF jsonb_typeof(r.payload->'amount_kobo') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'payload.amount_kobo (the amount the requesting admin reviewed) is required';
  END IF;

  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = r.target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.status <> 'pending' THEN RAISE EXCEPTION 'Withdrawal request is %, not pending', w.status; END IF;
  IF w.approved_by IS NOT NULL THEN RAISE EXCEPTION 'Withdrawal request is already authorized'; END IF;
  IF w.organizer_id IN (r.requested_by, v_approver) THEN
    RAISE EXCEPTION 'An admin cannot request or approve their own withdrawal';
  END IF;
  IF (r.payload->>'amount_kobo')::numeric <> w.amount_kobo THEN
    RAISE EXCEPTION 'The amount reviewed (%) does not match the request (%)', r.payload->>'amount_kobo', w.amount_kobo;
  END IF;

  SELECT b.recipient_code INTO v_recipient FROM public.organizer_bank_accounts b WHERE b.id = w.bank_account_id;
  IF v_recipient IS NULL THEN RAISE EXCEPTION 'The withdrawal has no verified bank recipient'; END IF;

  UPDATE public.organizer_withdrawal_requests
     SET approval_request_id = r.id, approval_requested_by = r.requested_by,
         approved_by = v_approver, approved_at = now(), approved_recipient_code = v_recipient,
         updated_at = now()
   WHERE id = w.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_approver, 'withdrawal_authorized', w.organizer_id,
          jsonb_build_object('request_id', w.id, 'admin_request_id', r.id, 'requested_by', r.requested_by,
                             'approved_by', v_approver, 'amount_kobo', w.amount_kobo),
          public.actor_role());
END;
$function$;

-- Wire the new action into the live maker-checker functions (anchored, as
-- 0201 does; a no-op when already wired).
DO $patch$
DECLARE
  v_def text;
  v_anchor text;
  v_count integer;
BEGIN
  v_def := pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);
  IF position('execute_withdrawal_authorization' IN v_def) = 0 THEN
    v_anchor := E'      IF r.action_type LIKE ''earn\\_%'' THEN\n';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'approve_admin_action anchor found % times (expected 1; is 0201 applied?)', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor,
      E'      IF r.action_type = ''authorize_withdrawal'' THEN\n' ||
      E'        PERFORM public.execute_withdrawal_authorization(r.id);\n' ||
      E'      ELSIF r.action_type LIKE ''earn\\_%'' THEN\n');
  END IF;

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position('authorize_withdrawal' IN v_def) = 0 THEN
    v_anchor := E'''earn_decide_expense'', ''earn_update_settings''';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'request_admin_action anchor found % times (expected 1; is 0201 applied?)', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor, v_anchor || E',\n    ''authorize_withdrawal''');
  END IF;
END
$patch$;

-- 0202's claim, plus: only an authorized request can be claimed, never by
-- its own organizer, and only to the bank recipient that was authorized.
CREATE OR REPLACE FUNCTION public.admin_claim_payout_for_processing(p_request_id uuid)
 RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, recipient_code text, status text, claimed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed_id uuid;
  w public.organizer_withdrawal_requests;
  v_recipient text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  SELECT * INTO w FROM public.organizer_withdrawal_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF FOUND AND w.status = 'pending' THEN
    IF w.organizer_id = auth.uid() THEN
      RAISE EXCEPTION 'An admin cannot pay out their own withdrawal';
    END IF;
    IF w.approved_by IS NULL THEN
      RAISE EXCEPTION 'This withdrawal needs a second admin''s authorization before it can be paid';
    END IF;
    SELECT b.recipient_code INTO v_recipient FROM public.organizer_bank_accounts b WHERE b.id = w.bank_account_id;
    IF v_recipient IS DISTINCT FROM w.approved_recipient_code THEN
      RAISE EXCEPTION 'The bank account changed after this withdrawal was authorized; authorize it again';
    END IF;
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing', resolved_by = auth.uid(), updated_at = now(),
      paystack_reference = COALESCE(public.organizer_withdrawal_requests.paystack_reference,
                                    public.payout_transfer_reference(p_request_id))
  WHERE id = p_request_id AND public.organizer_withdrawal_requests.status = 'pending'
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NOT NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
    VALUES (auth.uid(), 'claim_payout_for_processing',
            jsonb_build_object('request_id', p_request_id, 'approved_by', w.approved_by,
                               'approval_requested_by', w.approval_requested_by),
            public.actor_role());
  END IF;

  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, b.recipient_code, r.status, (v_claimed_id IS NOT NULL)
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Reconciliation: credits - debits = available + pending + on hold
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_earnings_reconciliation();
CREATE FUNCTION public.admin_earnings_reconciliation()
 RETURNS TABLE(organizer_id uuid, balance_kobo bigint, pending_kobo bigint, on_hold_kobo bigint,
               ledger_net_kobo bigint, ledger_gap_kobo bigint, open_requests_kobo bigint, pending_gap_kobo bigint,
               open_holds_kobo bigint, hold_gap_kobo bigint, outstanding_recovery_kobo bigint,
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
         - SUM(CASE WHEN t.type IN ('payout', 'refund', 'debit', 'representative_reward_reversal', 'recovery_deduction')
                    THEN t.amount_kobo ELSE 0 END) AS net
      FROM public.organizer_transactions t GROUP BY t.organizer_id
  ), req AS (
    SELECT r.organizer_id,
           COALESCE(SUM(r.amount_kobo) FILTER (WHERE r.status IN ('pending', 'processing')), 0) AS open_kobo,
           COUNT(*) FILTER (WHERE r.status = 'processing' AND r.updated_at < now() - interval '1 day')::int AS stale
      FROM public.organizer_withdrawal_requests r GROUP BY r.organizer_id
  ), hold AS (
    SELECT h.owner_id,
           COALESCE(SUM(h.amount_kobo) FILTER (WHERE h.released_at IS NULL), 0) AS open_kobo,
           COUNT(*) FILTER (WHERE h.released_at IS NULL AND h.release_at < now() - interval '2 days')::int AS overdue
      FROM public.earnings_holds h GROUP BY h.owner_id
  ), rec AS (
    SELECT x.owner_id, COALESCE(SUM(x.amount_kobo - x.recovered_kobo), 0) AS outstanding
      FROM public.earnings_recoveries x WHERE x.settled_at IS NULL GROUP BY x.owner_id
  )
  SELECT w.organizer_id, w.balance_kobo, w.pending_kobo, w.on_hold_kobo, COALESCE(l.net, 0),
         COALESCE(l.net, 0) - (w.balance_kobo + w.pending_kobo + w.on_hold_kobo),
         COALESCE(q.open_kobo, 0), w.pending_kobo - COALESCE(q.open_kobo, 0),
         COALESCE(h.open_kobo, 0), w.on_hold_kobo - COALESCE(h.open_kobo, 0),
         COALESCE(x.outstanding, 0), COALESCE(q.stale, 0),
         array_remove(ARRAY[
           CASE WHEN COALESCE(l.net, 0) <> w.balance_kobo + w.pending_kobo + w.on_hold_kobo THEN 'ledger_does_not_match_balance' END,
           CASE WHEN w.pending_kobo <> COALESCE(q.open_kobo, 0) THEN 'pending_does_not_match_open_requests' END,
           CASE WHEN w.on_hold_kobo <> COALESCE(h.open_kobo, 0) THEN 'on_hold_does_not_match_holds' END,
           CASE WHEN w.balance_kobo < 0 OR w.pending_kobo < 0 THEN 'negative_balance' END,
           CASE WHEN COALESCE(q.stale, 0) > 0 THEN 'processing_over_a_day' END,
           CASE WHEN COALESCE(h.overdue, 0) > 0 THEN 'matured_hold_not_released' END,
           CASE WHEN COALESCE(x.outstanding, 0) > 0 THEN 'outstanding_recovery' END
         ], NULL)
    FROM public.organizer_wallets w
    LEFT JOIN led l ON l.organizer_id = w.organizer_id
    LEFT JOIN req q ON q.organizer_id = w.organizer_id
    LEFT JOIN hold h ON h.owner_id = w.organizer_id
    LEFT JOIN rec x ON x.owner_id = w.organizer_id
   WHERE public.is_admin()
$function$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE f text;
BEGIN
  -- Internal: reachable only from other SECURITY DEFINER functions.
  FOREACH f IN ARRAY ARRAY[
    'public.tickets_fee_model_guard()',
    'public.earnings_place_hold(uuid,text,text,bigint)',
    'public.earnings_debit_for_refund(uuid,bigint,text,text,text,text,text,uuid,jsonb,uuid,text,text)',
    'public.settle_earnings(uuid)',
    'public.execute_withdrawal_authorization(uuid)',
    'public.earn_ticket_nominal_fee_kobo(numeric,text)',
    'public.release_matured_earnings(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- Pure helpers, safe for anyone signed in.
  FOREACH f IN ARRAY ARRAY[
    'public.ticket_fee_buyer_multiplier(text)',
    'public.ticket_fee_commission_kobo(bigint,text)',
    'public.earnings_hold_interval()',
    'public.settle_my_earnings()',
    'public.admin_earnings_reconciliation()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin') THEN
    GRANT EXECUTE ON FUNCTION public.release_matured_earnings(integer) TO project_admin;
  END IF;
END
$grants$;

DROP FUNCTION pg_temp.vents_0203_patch(regprocedure, text, text[]);
