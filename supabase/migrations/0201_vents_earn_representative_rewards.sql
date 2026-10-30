-- 0201: VENTS Earn -- representative rewards (₦50,000 per qualifying
-- organizer), realized-profit pool with reservations, expenses and an
-- append-only audit trail.
--
-- NOT APPLIED TO PRODUCTION. Verified only against a local throwaway
-- Postgres (scripts/local-pg-test/run-representative-rewards-verification.sh).
--
-- Rules implemented (from the product owner's written brief, 2026-10-30):
--   * One representative per organizer (first accepted partnership wins);
--     self-referral and duplicate attribution are blocked and audited.
--     Attribution survives a later revoke of the partnership, so referral
--     history is never lost.
--   * Reward: ₦50,000 per qualifying organizer, at most once per organizer.
--   * Qualifying: the organizer hosted an event (created after attribution)
--     that is over, not cancelled/deleted/hidden, with no pending payment,
--     pending purchase or pending refund. A free event qualifies only if an
--     admin explicitly verifies it as genuine. The organizer must confirm
--     the referral, then VENTS admin must approve (maker-checker: two
--     different admins, neither of whom is the representative or the
--     organizer).
--   * Funding: a reward can only be claimed (reserved) when the pooled
--     realized-profit balance covers it. Reservation locks the single pool
--     row, so two claims can never spend the same profit. Each claim
--     carries an idempotency key.
--   * Credit: funded rewards are credited to the representative's VENTS
--     Wallet (user_wallets), once, with a unique reference -- and only
--     while earn_settings.payouts_enabled is true. It ships false.
--   * Monthly counts by calendar month (Africa/Lagos). At 9+ qualifying
--     organizers in a month, management MAY approve a higher rate for the
--     next month through dual control. Nothing increases automatically.
--   * Transport/support expenses: separate table, approval via dual
--     control, never paid from or mixed into rewards.
--   * The legacy 10% "commission" model: audited at migration time (no
--     commission ledger exists, nothing was ever accrued or paid). Reward
--     approval and claiming stay blocked until management records the
--     reconciliation (earn_update_settings: legacy_commission_reconciled).
--
-- Realized profit. Production has no per-ticket fee ledger (0192 is not
-- applied) and no record of payment-processor costs or VENTS Cents reward
-- costs. So profit is NEVER computed live from sales. Instead:
--   1. earn_event_eligibility() computes, for a finished and fully settled
--      event, a fee CANDIDATE: the buyer fees recorded on its finalized
--      orders, minus the nominal 5% fee on every refunded / refund-pending
--      ticket, minus any recorded organizer-wallet refund shortfall.
--      Gross sales, pending payments and pending refunds never count.
--   2. Recognizing it as profit is a dual-control admin action that must
--      state the costs to deduct (processor fees, VC rewards, etc.).
--      recognized = candidate - costs, never more than the candidate,
--      once per event.
--   3. A refund on a recognized event after recognition debits the pool
--      (trigger), so later refunds can never leave reserved profit
--      silently overstated.
--
-- Dual control: approve_admin_action / request_admin_action are patched
-- IN PLACE from their live definitions (anchor replace, asserted to match
-- exactly once), so executors added to production since the repo copy
-- are never clobbered. All earn_* actions dispatch to
-- earn_execute_admin_action(), which nobody can call directly.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
CREATE TABLE public.earn_settings (
  id                             boolean PRIMARY KEY DEFAULT true CHECK (id),
  base_reward_kobo               bigint  NOT NULL DEFAULT 5000000 CHECK (base_reward_kobo = 5000000),
  rate_review_threshold          integer NOT NULL DEFAULT 9 CHECK (rate_review_threshold = 9),
  payouts_enabled                boolean NOT NULL DEFAULT false,
  legacy_commission_reconciled   boolean NOT NULL DEFAULT false,
  settlement_hold_days           integer NOT NULL DEFAULT 7 CHECK (settlement_hold_days BETWEEN 0 AND 120),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  updated_by                     uuid
);
INSERT INTO public.earn_settings (id) VALUES (true);

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE public.earn_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL,
  entity_id       uuid,
  action          text NOT NULL,
  actor_id        uuid,
  subject_user_id uuid,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX earn_audit_log_entity_idx  ON public.earn_audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX earn_audit_log_subject_idx ON public.earn_audit_log (subject_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.earn_audit_log_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'earn_audit_log is append-only';
END;
$function$;

CREATE TRIGGER earn_audit_log_no_update BEFORE UPDATE OR DELETE ON public.earn_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.earn_audit_log_append_only();
CREATE TRIGGER earn_audit_log_no_truncate BEFORE TRUNCATE ON public.earn_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.earn_audit_log_append_only();

CREATE OR REPLACE FUNCTION public.earn_audit(
  p_entity_type text, p_entity_id uuid, p_action text, p_subject uuid, p_details jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  INSERT INTO public.earn_audit_log (entity_type, entity_id, action, actor_id, subject_user_id, details)
  VALUES (p_entity_type, p_entity_id, p_action, auth.uid(), p_subject, COALESCE(p_details, '{}'::jsonb));
$function$;

-- ---------------------------------------------------------------------------
-- Attribution: which representative referred each organizer
-- ---------------------------------------------------------------------------
CREATE TABLE public.representative_attributions (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  representative_id                uuid NOT NULL REFERENCES public.recruiters(id),
  organizer_id                     uuid NOT NULL UNIQUE REFERENCES public.users(id),
  partnership_id                   uuid NOT NULL REFERENCES public.recruiter_partnerships(id),
  attributed_at                    timestamptz NOT NULL DEFAULT now(),
  organizer_had_events_before      boolean NOT NULL DEFAULT false,
  CONSTRAINT representative_attributions_no_self CHECK (representative_id <> organizer_id)
);
CREATE INDEX representative_attributions_rep_idx ON public.representative_attributions (representative_id);

-- Shared by the trigger and the one-off backfill below.
CREATE OR REPLACE FUNCTION public.earn_attribute_partnership(p_partnership_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  p public.recruiter_partnerships;
  v_existing public.representative_attributions;
  v_id uuid;
BEGIN
  SELECT * INTO p FROM public.recruiter_partnerships WHERE id = p_partnership_id;
  IF NOT FOUND OR p.status <> 'accepted' OR p.organizer_id IS NULL THEN
    RETURN;
  END IF;

  IF p.recruiter_id = p.organizer_id THEN
    PERFORM public.earn_audit('attribution', NULL, 'self_referral_blocked', p.organizer_id,
      jsonb_build_object('partnership_id', p.id, 'representative_id', p.recruiter_id));
    RETURN;
  END IF;

  INSERT INTO public.representative_attributions
    (representative_id, organizer_id, partnership_id, attributed_at, organizer_had_events_before)
  VALUES (
    p.recruiter_id, p.organizer_id, p.id, COALESCE(p.responded_at, now()),
    EXISTS (SELECT 1 FROM public.events e
             WHERE e.organizer_id = p.organizer_id
               AND e.created_at < COALESCE(p.responded_at, now()))
  )
  ON CONFLICT (organizer_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    PERFORM public.earn_audit('attribution', v_id, 'attributed', p.organizer_id,
      jsonb_build_object('partnership_id', p.id, 'representative_id', p.recruiter_id));
  ELSE
    SELECT * INTO v_existing FROM public.representative_attributions WHERE organizer_id = p.organizer_id;
    IF v_existing.representative_id IS DISTINCT FROM p.recruiter_id THEN
      PERFORM public.earn_audit('attribution', v_existing.id, 'duplicate_attribution_blocked', p.organizer_id,
        jsonb_build_object('partnership_id', p.id, 'attempted_representative_id', p.recruiter_id,
                           'kept_representative_id', v_existing.representative_id));
    END IF;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.earn_partnership_accepted_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' AND NEW.organizer_id IS NOT NULL THEN
    PERFORM public.earn_attribute_partnership(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER earn_attribute_on_partnership_accept
  AFTER UPDATE OF status ON public.recruiter_partnerships
  FOR EACH ROW EXECUTE FUNCTION public.earn_partnership_accepted_trigger();

-- Backfill: existing accepted organizer partnerships, earliest first.
DO $backfill$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.recruiter_partnerships
            WHERE status = 'accepted' AND organizer_id IS NOT NULL
            ORDER BY responded_at, created_at, id
  LOOP
    PERFORM public.earn_attribute_partnership(r.id);
  END LOOP;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- Realized-profit pool and ledger
-- ---------------------------------------------------------------------------
CREATE TABLE public.earn_profit_pool (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  available_kobo  bigint NOT NULL DEFAULT 0,  -- may go negative after post-recognition refunds
  reserved_kobo   bigint NOT NULL DEFAULT 0 CHECK (reserved_kobo >= 0),
  credited_kobo   bigint NOT NULL DEFAULT 0 CHECK (credited_kobo >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.earn_profit_pool (id) VALUES (true);

CREATE TABLE public.earn_profit_recognitions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL UNIQUE REFERENCES public.events(id),
  candidate_fee_kobo    bigint NOT NULL CHECK (candidate_fee_kobo >= 0),
  cost_deductions_kobo  bigint NOT NULL CHECK (cost_deductions_kobo >= 0),
  recognized_kobo       bigint NOT NULL CHECK (recognized_kobo >= 0),
  note                  text NOT NULL CHECK (length(trim(note)) > 0),
  requested_by          uuid NOT NULL,
  approved_by           uuid NOT NULL,
  admin_request_id      uuid NOT NULL UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earn_profit_recognitions_math CHECK (recognized_kobo = candidate_fee_kobo - cost_deductions_kobo),
  CONSTRAINT earn_profit_recognitions_two_people CHECK (requested_by <> approved_by)
);

CREATE TABLE public.earn_profit_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type         text NOT NULL CHECK (entry_type IN
                       ('recognition', 'refund_adjustment', 'reservation', 'release', 'credit', 'reversal_return')),
  amount_kobo        bigint NOT NULL CHECK (amount_kobo > 0),
  recognition_id     uuid REFERENCES public.earn_profit_recognitions(id),
  claim_id           uuid,
  ticket_id          uuid,
  available_after    bigint NOT NULL,
  reserved_after     bigint NOT NULL,
  credited_after     bigint NOT NULL,
  actor_id           uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX earn_profit_ledger_one_refund_adjustment ON public.earn_profit_ledger (ticket_id)
  WHERE entry_type = 'refund_adjustment';
CREATE UNIQUE INDEX earn_profit_ledger_one_entry_per_claim_step ON public.earn_profit_ledger (claim_id, entry_type)
  WHERE claim_id IS NOT NULL;

CREATE TRIGGER earn_profit_ledger_no_update BEFORE UPDATE OR DELETE ON public.earn_profit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.earn_audit_log_append_only();

-- Moves money inside the pool and writes the matching ledger row. Caller
-- must already hold the pool row lock (SELECT ... FOR UPDATE).
CREATE OR REPLACE FUNCTION public.earn_pool_move(
  p_entry_type text, p_amount_kobo bigint, p_recognition_id uuid, p_claim_id uuid, p_ticket_id uuid)
 RETURNS public.earn_profit_pool
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_pool public.earn_profit_pool;
BEGIN
  UPDATE public.earn_profit_pool SET
    available_kobo = available_kobo + CASE p_entry_type
        WHEN 'recognition'       THEN  p_amount_kobo
        WHEN 'refund_adjustment' THEN -p_amount_kobo
        WHEN 'reservation'       THEN -p_amount_kobo
        WHEN 'release'           THEN  p_amount_kobo
        WHEN 'reversal_return'   THEN  p_amount_kobo
        ELSE 0 END,
    reserved_kobo = reserved_kobo + CASE p_entry_type
        WHEN 'reservation' THEN  p_amount_kobo
        WHEN 'release'     THEN -p_amount_kobo
        WHEN 'credit'      THEN -p_amount_kobo
        ELSE 0 END,
    credited_kobo = credited_kobo + CASE p_entry_type
        WHEN 'credit'          THEN  p_amount_kobo
        WHEN 'reversal_return' THEN -p_amount_kobo
        ELSE 0 END,
    updated_at = now()
  WHERE id RETURNING * INTO v_pool;

  INSERT INTO public.earn_profit_ledger
    (entry_type, amount_kobo, recognition_id, claim_id, ticket_id,
     available_after, reserved_after, credited_after, actor_id)
  VALUES (p_entry_type, p_amount_kobo, p_recognition_id, p_claim_id, p_ticket_id,
          v_pool.available_kobo, v_pool.reserved_kobo, v_pool.credited_kobo, auth.uid());
  RETURN v_pool;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Event eligibility and fee candidate
-- ---------------------------------------------------------------------------
-- Nominal VENTS fee on a ticket (5% of its face amount), used to take back
-- the fee on refunded tickets. Overstates the loss for discounted tickets,
-- which only ever makes the candidate smaller.
CREATE OR REPLACE FUNCTION public.earn_ticket_nominal_fee_kobo(p_amount numeric)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT GREATEST(0, ceil(COALESCE(p_amount, 0) * 5))::bigint;  -- amount (₦) * 100 kobo * 5%
$function$;

CREATE OR REPLACE FUNCTION public.earn_event_eligibility(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  e public.events;
  v_hold integer;
  v_ended_at timestamptz;
  v_reasons text[] := ARRAY[]::text[];
  v_paid integer;
  v_pending integer;
  v_refund_pending integer;
  v_pending_purchases integer;
  v_fees bigint;
  v_refunded_fees bigint;
  v_shortfall bigint;
  v_candidate bigint;
BEGIN
  SELECT * INTO e FROM public.events WHERE id = p_event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reasons', jsonb_build_array('event_not_found'));
  END IF;

  SELECT settlement_hold_days INTO v_hold FROM public.earn_settings;
  v_ended_at := COALESCE(e.end_date, e.event_date);

  IF e.deleted_at IS NOT NULL THEN v_reasons := array_append(v_reasons, 'event_deleted'); END IF;
  IF COALESCE(e.hidden_by_admin, false) THEN v_reasons := array_append(v_reasons, 'event_hidden_by_admin'); END IF;
  IF e.status IS DISTINCT FROM 'live' THEN v_reasons := array_append(v_reasons, 'event_not_live'); END IF;
  IF v_ended_at IS NULL OR v_ended_at > now() THEN
    v_reasons := array_append(v_reasons, 'event_not_over');
  ELSIF v_ended_at + make_interval(days => v_hold) > now() THEN
    v_reasons := array_append(v_reasons, 'settlement_hold');
  END IF;

  SELECT count(*) FILTER (WHERE payment_status = 'paid'),
         count(*) FILTER (WHERE payment_status = 'pending'),
         count(*) FILTER (WHERE payment_status = 'refund_pending')
    INTO v_paid, v_pending, v_refund_pending
    FROM public.tickets WHERE event_id = p_event_id;
  SELECT count(*) INTO v_pending_purchases
    FROM public.pending_purchases WHERE event_id = p_event_id AND status = 'pending';

  IF v_pending > 0 THEN v_reasons := array_append(v_reasons, 'pending_payments'); END IF;
  IF v_pending_purchases > 0 THEN v_reasons := array_append(v_reasons, 'pending_purchases'); END IF;
  IF v_refund_pending > 0 THEN v_reasons := array_append(v_reasons, 'pending_refunds'); END IF;

  SELECT COALESCE(sum(GREATEST(0, COALESCE((ot.metadata->>'buyer_fee_kobo')::bigint, 0))), 0)
    INTO v_fees
    FROM public.organizer_transactions ot
    JOIN public.tickets t ON t.id = ot.ticket_sale_id
   WHERE t.event_id = p_event_id AND ot.type = 'credit';

  SELECT COALESCE(sum(public.earn_ticket_nominal_fee_kobo(t.amount)), 0)
    INTO v_refunded_fees
    FROM public.tickets t
   WHERE t.event_id = p_event_id AND t.payment_status IN ('refunded', 'refund_pending');

  SELECT COALESCE(sum(GREATEST(0, COALESCE((l.details->>'shortfall_kobo')::bigint, 0))), 0)
    INTO v_shortfall
    FROM public.admin_logs l
   WHERE l.action = 'refund_wallet_shortfall'
     AND (l.details->>'ticket_id') IN (SELECT t.id::text FROM public.tickets t WHERE t.event_id = p_event_id);

  v_candidate := GREATEST(0, v_fees - v_refunded_fees - v_shortfall);

  RETURN jsonb_build_object(
    'eligible',             cardinality(v_reasons) = 0,
    'reasons',              to_jsonb(v_reasons),
    'event_id',             e.id,
    'organizer_id',         e.organizer_id,
    'title',                e.title,
    'created_at',           e.created_at,
    'ended_at',             v_ended_at,
    'reward_month',         to_char(date_trunc('month', v_ended_at AT TIME ZONE 'Africa/Lagos'), 'YYYY-MM-DD'),
    'paid_tickets',         v_paid,
    'is_free_event',        (v_paid = 0 AND v_fees = 0),
    'fee_recorded_kobo',    v_fees,
    'fee_refunded_kobo',    v_refunded_fees,
    'refund_shortfall_kobo', v_shortfall,
    'fee_candidate_kobo',   v_candidate
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Reward claims
-- ---------------------------------------------------------------------------
CREATE TABLE public.representative_monthly_rates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  representative_id  uuid NOT NULL REFERENCES public.recruiters(id),
  month              date NOT NULL CHECK (month = date_trunc('month', month)::date),
  reward_kobo        bigint NOT NULL CHECK (reward_kobo > 5000000),
  basis_month_count  integer NOT NULL CHECK (basis_month_count >= 9),
  reason             text NOT NULL CHECK (length(trim(reason)) > 0),
  requested_by       uuid NOT NULL,
  approved_by        uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (representative_id, month),
  CONSTRAINT representative_monthly_rates_two_people CHECK (requested_by <> approved_by)
);

CREATE TABLE public.representative_reward_claims (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id         uuid NOT NULL REFERENCES public.representative_attributions(id),
  representative_id      uuid NOT NULL REFERENCES public.recruiters(id),
  organizer_id           uuid NOT NULL REFERENCES public.users(id),
  event_id               uuid NOT NULL REFERENCES public.events(id),
  reward_month           date NOT NULL,
  amount_kobo            bigint NOT NULL CHECK (amount_kobo >= 5000000),
  status                 text NOT NULL DEFAULT 'pending_organizer' CHECK (status IN
                           ('pending_organizer', 'pending_review', 'approved', 'funded', 'credited', 'rejected', 'reversed')),
  is_free_event          boolean NOT NULL,
  free_event_verified    boolean NOT NULL DEFAULT false,
  organizer_confirmed_at timestamptz,
  approved_at            timestamptz,
  approved_by            uuid,
  approval_requested_by  uuid,
  funded_at              timestamptz,
  funding_idempotency_key uuid,
  credited_at            timestamptz,
  wallet_transaction_id  uuid,
  rejected_at            timestamptz,
  reversed_at            timestamptz,
  decision_reason        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT representative_reward_claims_no_self CHECK (representative_id <> organizer_id),
  CONSTRAINT representative_reward_claims_free_needs_verification CHECK (
    status NOT IN ('approved', 'funded', 'credited') OR NOT is_free_event OR free_event_verified),
  CONSTRAINT representative_reward_claims_approver_not_party CHECK (
    approved_by IS NULL OR (approved_by <> representative_id AND approved_by <> organizer_id)),
  CONSTRAINT representative_reward_claims_requester_not_party CHECK (
    approval_requested_by IS NULL OR (approval_requested_by <> representative_id AND approval_requested_by <> organizer_id))
);
-- One reward per organizer, ever (a rejected claim can be resubmitted).
CREATE UNIQUE INDEX representative_reward_claims_one_per_organizer
  ON public.representative_reward_claims (organizer_id) WHERE status <> 'rejected';
CREATE UNIQUE INDEX representative_reward_claims_one_per_event
  ON public.representative_reward_claims (event_id) WHERE status <> 'rejected';
CREATE UNIQUE INDEX representative_reward_claims_funding_key
  ON public.representative_reward_claims (funding_idempotency_key) WHERE funding_idempotency_key IS NOT NULL;
CREATE INDEX representative_reward_claims_rep_idx ON public.representative_reward_claims (representative_id, reward_month);

CREATE OR REPLACE FUNCTION public.representative_qualifying_count(p_representative_id uuid, p_month date)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT count(*)::integer FROM public.representative_reward_claims
   WHERE representative_id = p_representative_id
     AND reward_month = date_trunc('month', p_month)::date
     AND status IN ('approved', 'funded', 'credited');
$function$;

CREATE OR REPLACE FUNCTION public.representative_reward_rate_kobo(p_representative_id uuid, p_month date)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    (SELECT reward_kobo FROM public.representative_monthly_rates
      WHERE representative_id = p_representative_id AND month = date_trunc('month', p_month)::date),
    (SELECT base_reward_kobo FROM public.earn_settings));
$function$;

-- Representative: submit a qualifying organizer + event for review.
CREATE OR REPLACE FUNCTION public.submit_representative_reward_claim(p_organizer_id uuid, p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  a public.representative_attributions;
  v_elig jsonb;
  v_claim public.representative_reward_claims;
  v_month date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.check_rate_limit('rep_reward_claim:' || v_uid::text, 20, 3600);

  IF NOT EXISTS (SELECT 1 FROM public.recruiters WHERE id = v_uid AND status = 'active') THEN
    RAISE EXCEPTION 'Only an active representative can submit a reward claim';
  END IF;
  IF p_organizer_id = v_uid THEN
    RAISE EXCEPTION 'You cannot claim a reward for yourself';
  END IF;

  SELECT * INTO a FROM public.representative_attributions WHERE organizer_id = p_organizer_id;
  IF NOT FOUND OR a.representative_id <> v_uid THEN
    RAISE EXCEPTION 'This organizer is not attributed to you';
  END IF;

  SELECT * INTO v_claim FROM public.representative_reward_claims
   WHERE organizer_id = p_organizer_id AND status <> 'rejected';
  IF FOUND THEN
    IF v_claim.event_id = p_event_id THEN
      RETURN jsonb_build_object('status', v_claim.status, 'claim_id', v_claim.id, 'duplicate', true);
    END IF;
    RAISE EXCEPTION 'A reward for this organizer already exists (status: %)', v_claim.status;
  END IF;

  v_elig := public.earn_event_eligibility(p_event_id);
  IF (v_elig->>'organizer_id')::uuid IS DISTINCT FROM p_organizer_id THEN
    RAISE EXCEPTION 'That event does not belong to this organizer';
  END IF;
  IF (v_elig->>'created_at')::timestamptz < a.attributed_at THEN
    RAISE EXCEPTION 'The event was created before you referred this organizer';
  END IF;
  IF NOT (v_elig->>'eligible')::boolean THEN
    RAISE EXCEPTION 'Event is not eligible yet: %', v_elig->'reasons';
  END IF;

  v_month := (v_elig->>'reward_month')::date;
  INSERT INTO public.representative_reward_claims
    (attribution_id, representative_id, organizer_id, event_id, reward_month, amount_kobo, is_free_event)
  VALUES (a.id, v_uid, p_organizer_id, p_event_id, v_month,
          public.representative_reward_rate_kobo(v_uid, v_month), (v_elig->>'is_free_event')::boolean)
  RETURNING * INTO v_claim;

  PERFORM public.earn_audit('reward_claim', v_claim.id, 'submitted', v_uid,
    jsonb_build_object('organizer_id', p_organizer_id, 'event_id', p_event_id, 'eligibility', v_elig,
                       'amount_kobo', v_claim.amount_kobo));

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (p_organizer_id, 'social', 'Confirm your VENTS representative',
          'A VENTS representative says they helped you start hosting on VENTS. Please confirm or decline.',
          false, '🤝', jsonb_build_object('rewardClaimId', v_claim.id));

  RETURN jsonb_build_object('status', v_claim.status, 'claim_id', v_claim.id, 'duplicate', false);
END;
$function$;

-- Organizer: confirm (or decline) that this representative referred them.
CREATE OR REPLACE FUNCTION public.respond_to_representative_reward_claim(p_claim_id uuid, p_confirm boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  c public.representative_reward_claims;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO c FROM public.representative_reward_claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND OR c.organizer_id <> v_uid THEN
    RAISE EXCEPTION 'Not authorized to respond to this claim';
  END IF;
  IF c.status <> 'pending_organizer' THEN
    RAISE EXCEPTION 'Claim is not waiting for your confirmation (status: %)', c.status;
  END IF;

  UPDATE public.representative_reward_claims
     SET status = CASE WHEN p_confirm THEN 'pending_review' ELSE 'rejected' END,
         organizer_confirmed_at = CASE WHEN p_confirm THEN now() END,
         rejected_at = CASE WHEN p_confirm THEN NULL ELSE now() END,
         decision_reason = CASE WHEN p_confirm THEN NULL ELSE 'organizer_declined' END,
         updated_at = now()
   WHERE id = p_claim_id RETURNING * INTO c;

  PERFORM public.earn_audit('reward_claim', c.id,
    CASE WHEN p_confirm THEN 'organizer_confirmed' ELSE 'organizer_declined' END, c.representative_id, '{}'::jsonb);

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (c.representative_id, 'social',
          CASE WHEN p_confirm THEN 'Organizer confirmed your referral' ELSE 'Organizer declined your referral' END,
          CASE WHEN p_confirm THEN 'Your reward is now waiting for VENTS review.'
               ELSE 'The organizer did not confirm the referral, so this reward was not submitted.' END,
          false, CASE WHEN p_confirm THEN '✅' ELSE '❌' END,
          jsonb_build_object('rewardClaimId', c.id));

  RETURN jsonb_build_object('status', c.status, 'claim_id', c.id);
END;
$function$;

-- Representative: claim an approved reward. Reserves realized profit
-- (pool row locked) and, if payouts are enabled, credits the VENTS Wallet.
-- Idempotent per claim: the same key returns the existing result.
CREATE OR REPLACE FUNCTION public.claim_representative_reward(p_claim_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  c public.representative_reward_claims;
  s public.earn_settings;
  v_pool public.earn_profit_pool;
  v_tx uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'An idempotency key is required'; END IF;
  PERFORM public.check_rate_limit('rep_reward_fund:' || v_uid::text, 30, 3600);

  SELECT * INTO c FROM public.representative_reward_claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND OR c.representative_id <> v_uid THEN
    RAISE EXCEPTION 'Not authorized to claim this reward';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruiters WHERE id = v_uid AND status = 'active') THEN
    RAISE EXCEPTION 'Your representative account is not active';
  END IF;

  SELECT * INTO s FROM public.earn_settings;
  IF NOT s.legacy_commission_reconciled THEN
    RAISE EXCEPTION 'Rewards are not open yet: the legacy commission programme has not been reconciled';
  END IF;

  IF c.status = 'credited' THEN
    RETURN jsonb_build_object('status', 'credited', 'claim_id', c.id, 'duplicate', true);
  END IF;

  IF c.status = 'approved' THEN
    -- Lock the single pool row: concurrent claims serialize here.
    SELECT * INTO v_pool FROM public.earn_profit_pool WHERE id FOR UPDATE;
    IF v_pool.available_kobo < c.amount_kobo THEN
      PERFORM public.earn_audit('reward_claim', c.id, 'funding_blocked_insufficient_profit', v_uid,
        jsonb_build_object('amount_kobo', c.amount_kobo));
      RETURN jsonb_build_object('status', 'awaiting_profit', 'claim_id', c.id);
    END IF;
    PERFORM public.earn_pool_move('reservation', c.amount_kobo, NULL, c.id, NULL);
    UPDATE public.representative_reward_claims
       SET status = 'funded', funded_at = now(), funding_idempotency_key = p_idempotency_key, updated_at = now()
     WHERE id = c.id RETURNING * INTO c;
    PERFORM public.earn_audit('reward_claim', c.id, 'funded_profit_reserved', v_uid,
      jsonb_build_object('amount_kobo', c.amount_kobo, 'idempotency_key', p_idempotency_key));
  ELSIF c.status = 'funded' THEN
    NULL;  -- already reserved; fall through to the credit step
  ELSE
    RAISE EXCEPTION 'This reward cannot be claimed (status: %)', c.status;
  END IF;

  IF NOT s.payouts_enabled THEN
    RETURN jsonb_build_object('status', 'funded', 'claim_id', c.id, 'payouts_enabled', false);
  END IF;

  -- Credit the VENTS Wallet exactly once (unique reference per claim).
  INSERT INTO public.user_wallets (user_id) VALUES (v_uid) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
  VALUES (v_uid, 'earn_reward', c.amount_kobo, 'VENTS representative reward', 'rep_reward:' || c.id::text,
          jsonb_build_object('claim_id', c.id, 'organizer_id', c.organizer_id, 'event_id', c.event_id))
  ON CONFLICT (reference_id) WHERE (type = 'earn_reward' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx;

  IF v_tx IS NOT NULL THEN
    UPDATE public.user_wallets SET balance_kobo = balance_kobo + c.amount_kobo, updated_at = now()
     WHERE user_id = v_uid;
    SELECT * INTO v_pool FROM public.earn_profit_pool WHERE id FOR UPDATE;
    PERFORM public.earn_pool_move('credit', c.amount_kobo, NULL, c.id, NULL);
  END IF;

  UPDATE public.representative_reward_claims
     SET status = 'credited', credited_at = now(), wallet_transaction_id = COALESCE(v_tx, wallet_transaction_id),
         updated_at = now()
   WHERE id = c.id RETURNING * INTO c;
  PERFORM public.earn_audit('reward_claim', c.id, 'wallet_credited', v_uid,
    jsonb_build_object('amount_kobo', c.amount_kobo, 'wallet_transaction_id', v_tx));

  RETURN jsonb_build_object('status', 'credited', 'claim_id', c.id, 'payouts_enabled', true);
END;
$function$;

-- VENTS Wallet: allow the new transaction types, each reference unique.
ALTER TABLE public.user_wallet_transactions DROP CONSTRAINT user_wallet_transactions_type_check;
ALTER TABLE public.user_wallet_transactions ADD CONSTRAINT user_wallet_transactions_type_check
  CHECK (type = ANY (ARRAY['deposit'::text, 'spend'::text, 'refund'::text, 'vc_conversion'::text,
                           'earn_reward'::text, 'earn_reversal'::text]));
CREATE UNIQUE INDEX user_wallet_transactions_earn_reward_ref_idx
  ON public.user_wallet_transactions (reference_id) WHERE (type = 'earn_reward' AND reference_id IS NOT NULL);
CREATE UNIQUE INDEX user_wallet_transactions_earn_reversal_ref_idx
  ON public.user_wallet_transactions (reference_id) WHERE (type = 'earn_reversal' AND reference_id IS NOT NULL);

-- A refund on an event whose profit was already recognized takes the
-- ticket's nominal fee back out of the pool, once per ticket.
CREATE OR REPLACE FUNCTION public.earn_ticket_refund_adjust_profit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_rec uuid;
  v_fee bigint;
BEGIN
  SELECT id INTO v_rec FROM public.earn_profit_recognitions WHERE event_id = NEW.event_id;
  IF v_rec IS NULL THEN RETURN NEW; END IF;
  v_fee := public.earn_ticket_nominal_fee_kobo(NEW.amount);
  IF v_fee <= 0 OR EXISTS (SELECT 1 FROM public.earn_profit_ledger
                            WHERE entry_type = 'refund_adjustment' AND ticket_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.earn_profit_pool WHERE id FOR UPDATE;
  PERFORM public.earn_pool_move('refund_adjustment', v_fee, v_rec, NULL, NEW.id);
  PERFORM public.earn_audit('profit', v_rec, 'post_recognition_refund', NULL,
    jsonb_build_object('ticket_id', NEW.id, 'event_id', NEW.event_id, 'fee_kobo', v_fee));
  RETURN NEW;
END;
$function$;

CREATE TRIGGER earn_adjust_profit_on_refund
  AFTER UPDATE OF payment_status ON public.tickets
  FOR EACH ROW
  WHEN (OLD.payment_status = 'paid' AND NEW.payment_status IN ('refund_pending', 'refunded'))
  EXECUTE FUNCTION public.earn_ticket_refund_adjust_profit();

-- ---------------------------------------------------------------------------
-- Expenses (tracked separately from rewards)
-- ---------------------------------------------------------------------------
CREATE TABLE public.representative_expenses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  representative_id  uuid NOT NULL REFERENCES public.recruiters(id),
  organizer_id       uuid REFERENCES public.users(id),
  category           text NOT NULL CHECK (category IN ('transport', 'support')),
  amount_kobo        bigint NOT NULL CHECK (amount_kobo > 0),
  description        text NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 500),
  incurred_on        date NOT NULL,
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  idempotency_key    uuid NOT NULL,
  decided_by         uuid,
  decision_requested_by uuid,
  decided_at         timestamptz,
  decision_reason    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (representative_id, idempotency_key),
  CONSTRAINT representative_expenses_not_self_decided CHECK (
    (decided_by IS NULL OR decided_by <> representative_id) AND
    (decision_requested_by IS NULL OR decision_requested_by <> representative_id))
);
CREATE INDEX representative_expenses_rep_idx ON public.representative_expenses (representative_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.submit_representative_expense(
  p_category text, p_amount_kobo bigint, p_description text, p_incurred_on date,
  p_organizer_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.representative_expenses;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'An idempotency key is required'; END IF;
  PERFORM public.check_rate_limit('rep_expense:' || v_uid::text, 20, 3600);
  IF NOT EXISTS (SELECT 1 FROM public.recruiters WHERE id = v_uid AND status = 'active') THEN
    RAISE EXCEPTION 'Only an active representative can submit expenses';
  END IF;
  IF p_incurred_on IS NULL OR p_incurred_on > (now() AT TIME ZONE 'Africa/Lagos')::date THEN
    RAISE EXCEPTION 'Expense date must be today or earlier';
  END IF;
  IF p_organizer_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.representative_attributions
        WHERE organizer_id = p_organizer_id AND representative_id = v_uid) THEN
    RAISE EXCEPTION 'That organizer is not attributed to you';
  END IF;

  INSERT INTO public.representative_expenses
    (representative_id, organizer_id, category, amount_kobo, description, incurred_on, idempotency_key)
  VALUES (v_uid, p_organizer_id, p_category, p_amount_kobo, trim(p_description), p_incurred_on, p_idempotency_key)
  ON CONFLICT (representative_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.representative_expenses
     WHERE representative_id = v_uid AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('status', v_row.status, 'expense_id', v_row.id, 'duplicate', true);
  END IF;

  PERFORM public.earn_audit('expense', v_row.id, 'submitted', v_uid,
    jsonb_build_object('category', p_category, 'amount_kobo', p_amount_kobo));
  RETURN jsonb_build_object('status', v_row.status, 'expense_id', v_row.id, 'duplicate', false);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Dual-control executor (runs only inside approve_admin_action)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.earn_execute_admin_action(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
  v_approver uuid := auth.uid();
  c public.representative_reward_claims;
  x public.representative_expenses;
  s public.earn_settings;
  v_elig jsonb;
  v_pool public.earn_profit_pool;
  v_amount bigint;
  v_cost bigint;
  v_rec public.earn_profit_recognitions;
  v_month date;
  v_count integer;
  v_wallet bigint;
  v_tx uuid;
  v_hold integer;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN
    RAISE EXCEPTION 'Admin request is not pending';
  END IF;
  IF r.requested_by = v_approver THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;
  SELECT * INTO s FROM public.earn_settings;

  IF r.action_type IN ('earn_approve_reward', 'earn_reject_reward', 'earn_reverse_reward') THEN
    SELECT * INTO c FROM public.representative_reward_claims WHERE id = (r.payload->>'claim_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reward claim not found'; END IF;
    IF v_approver IN (c.representative_id, c.organizer_id) OR r.requested_by IN (c.representative_id, c.organizer_id) THEN
      RAISE EXCEPTION 'The representative or organizer cannot request or approve their own reward';
    END IF;
  END IF;

  CASE r.action_type
  WHEN 'earn_approve_reward' THEN
    IF NOT s.legacy_commission_reconciled THEN
      RAISE EXCEPTION 'Reconcile the legacy commission programme before approving rewards';
    END IF;
    IF c.status <> 'pending_review' THEN
      RAISE EXCEPTION 'Only a claim the organizer confirmed can be approved (status: %)', c.status;
    END IF;
    v_elig := public.earn_event_eligibility(c.event_id);
    IF NOT (v_elig->>'eligible')::boolean THEN
      RAISE EXCEPTION 'Event is no longer eligible: %', v_elig->'reasons';
    END IF;
    IF (v_elig->>'is_free_event')::boolean AND COALESCE((r.payload->>'free_event_verified')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'A free event must be explicitly verified as genuine (payload.free_event_verified = true)';
    END IF;
    UPDATE public.representative_reward_claims
       SET status = 'approved', approved_at = now(), approved_by = v_approver,
           approval_requested_by = r.requested_by,
           is_free_event = (v_elig->>'is_free_event')::boolean,
           free_event_verified = COALESCE((r.payload->>'free_event_verified')::boolean, false),
           amount_kobo = public.representative_reward_rate_kobo(c.representative_id, c.reward_month),
           updated_at = now()
     WHERE id = c.id RETURNING * INTO c;
    PERFORM public.earn_audit('reward_claim', c.id, 'admin_approved', c.representative_id,
      jsonb_build_object('admin_request_id', r.id, 'requested_by', r.requested_by, 'eligibility', v_elig,
                         'amount_kobo', c.amount_kobo, 'free_event_verified', c.free_event_verified));
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (c.representative_id, 'social', 'Reward approved',
            'VENTS approved your representative reward. You can claim it once VENTS profit covers it.',
            false, '✅', jsonb_build_object('rewardClaimId', c.id));

  WHEN 'earn_reject_reward' THEN
    IF c.status NOT IN ('pending_organizer', 'pending_review', 'approved') THEN
      RAISE EXCEPTION 'This claim cannot be rejected (status: %)', c.status;
    END IF;
    IF COALESCE(trim(r.payload->>'reason'), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
    UPDATE public.representative_reward_claims
       SET status = 'rejected', rejected_at = now(), decision_reason = r.payload->>'reason', updated_at = now()
     WHERE id = c.id;
    PERFORM public.earn_audit('reward_claim', c.id, 'admin_rejected', c.representative_id,
      jsonb_build_object('admin_request_id', r.id, 'requested_by', r.requested_by, 'reason', r.payload->>'reason'));

  WHEN 'earn_reverse_reward' THEN
    IF COALESCE(trim(r.payload->>'reason'), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
    SELECT * INTO v_pool FROM public.earn_profit_pool WHERE id FOR UPDATE;
    IF c.status = 'funded' THEN
      PERFORM public.earn_pool_move('release', c.amount_kobo, NULL, c.id, NULL);
    ELSIF c.status = 'credited' THEN
      SELECT balance_kobo INTO v_wallet FROM public.user_wallets WHERE user_id = c.representative_id FOR UPDATE;
      IF COALESCE(v_wallet, 0) < c.amount_kobo THEN
        RAISE EXCEPTION 'VENTS Wallet balance (% kobo) does not cover the reversal; recover it manually first', COALESCE(v_wallet, 0);
      END IF;
      INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
      VALUES (c.representative_id, 'earn_reversal', c.amount_kobo, 'VENTS representative reward reversed',
              'rep_reward:' || c.id::text, jsonb_build_object('claim_id', c.id, 'reason', r.payload->>'reason'))
      RETURNING id INTO v_tx;
      UPDATE public.user_wallets SET balance_kobo = balance_kobo - c.amount_kobo, updated_at = now()
       WHERE user_id = c.representative_id;
      PERFORM public.earn_pool_move('reversal_return', c.amount_kobo, NULL, c.id, NULL);
    ELSIF c.status <> 'approved' THEN
      RAISE EXCEPTION 'This claim cannot be reversed (status: %)', c.status;
    END IF;
    UPDATE public.representative_reward_claims
       SET status = 'reversed', reversed_at = now(), decision_reason = r.payload->>'reason', updated_at = now()
     WHERE id = c.id;
    PERFORM public.earn_audit('reward_claim', c.id, 'admin_reversed', c.representative_id,
      jsonb_build_object('admin_request_id', r.id, 'requested_by', r.requested_by, 'previous_status', c.status,
                         'reason', r.payload->>'reason', 'wallet_transaction_id', v_tx));

  WHEN 'earn_recognize_event_profit' THEN
    v_elig := public.earn_event_eligibility((r.payload->>'event_id')::uuid);
    IF NOT (v_elig->>'eligible')::boolean THEN
      RAISE EXCEPTION 'Event is not settled: %', v_elig->'reasons';
    END IF;
    v_cost := (r.payload->>'cost_deductions_kobo')::bigint;
    IF v_cost IS NULL OR v_cost < 0 THEN RAISE EXCEPTION 'cost_deductions_kobo must be stated (0 or more)'; END IF;
    IF COALESCE(trim(r.payload->>'note'), '') = '' THEN RAISE EXCEPTION 'A note explaining the costs is required'; END IF;
    v_amount := (v_elig->>'fee_candidate_kobo')::bigint - v_cost;
    IF v_amount < 0 THEN RAISE EXCEPTION 'Costs exceed the fee candidate'; END IF;
    INSERT INTO public.earn_profit_recognitions
      (event_id, candidate_fee_kobo, cost_deductions_kobo, recognized_kobo, note, requested_by, approved_by, admin_request_id)
    VALUES ((v_elig->>'event_id')::uuid, (v_elig->>'fee_candidate_kobo')::bigint, v_cost, v_amount,
            r.payload->>'note', r.requested_by, v_approver, r.id)
    RETURNING * INTO v_rec;
    IF v_amount > 0 THEN
      SELECT * INTO v_pool FROM public.earn_profit_pool WHERE id FOR UPDATE;
      PERFORM public.earn_pool_move('recognition', v_amount, v_rec.id, NULL, NULL);
    END IF;
    PERFORM public.earn_audit('profit', v_rec.id, 'recognized', NULL,
      jsonb_build_object('admin_request_id', r.id, 'requested_by', r.requested_by, 'eligibility', v_elig,
                         'cost_deductions_kobo', v_cost, 'recognized_kobo', v_amount));

  WHEN 'earn_set_monthly_rate' THEN
    v_month := (r.payload->>'month')::date;
    v_amount := (r.payload->>'reward_kobo')::bigint;
    IF v_month IS NULL OR v_month <> date_trunc('month', v_month)::date THEN
      RAISE EXCEPTION 'month must be the first day of a month';
    END IF;
    IF v_month < date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')::date THEN
      RAISE EXCEPTION 'A rate cannot be set for a past month';
    END IF;
    IF v_approver = r.target_id OR r.requested_by = r.target_id THEN
      RAISE EXCEPTION 'A representative cannot request or approve their own rate';
    END IF;
    v_count := public.representative_qualifying_count(r.target_id, (v_month - interval '1 month')::date);
    IF v_count < s.rate_review_threshold THEN
      RAISE EXCEPTION 'Only % qualifying organizers in the previous month; % are required', v_count, s.rate_review_threshold;
    END IF;
    IF COALESCE(trim(r.payload->>'reason'), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
    INSERT INTO public.representative_monthly_rates
      (representative_id, month, reward_kobo, basis_month_count, reason, requested_by, approved_by)
    VALUES (r.target_id, v_month, v_amount, v_count, r.payload->>'reason', r.requested_by, v_approver);
    PERFORM public.earn_audit('monthly_rate', r.target_id, 'rate_approved', r.target_id,
      jsonb_build_object('admin_request_id', r.id, 'month', v_month, 'reward_kobo', v_amount,
                         'basis_month_count', v_count, 'requested_by', r.requested_by));

  WHEN 'earn_decide_expense' THEN
    SELECT * INTO x FROM public.representative_expenses WHERE id = (r.payload->>'expense_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    IF x.status <> 'submitted' THEN RAISE EXCEPTION 'Expense already %', x.status; END IF;
    IF v_approver = x.representative_id OR r.requested_by = x.representative_id THEN
      RAISE EXCEPTION 'A representative cannot request or approve their own expense';
    END IF;
    UPDATE public.representative_expenses
       SET status = CASE WHEN (r.payload->>'approve')::boolean THEN 'approved' ELSE 'rejected' END,
           decided_by = v_approver, decision_requested_by = r.requested_by, decided_at = now(),
           decision_reason = r.payload->>'reason'
     WHERE id = x.id RETURNING * INTO x;
    PERFORM public.earn_audit('expense', x.id, 'expense_' || x.status, x.representative_id,
      jsonb_build_object('admin_request_id', r.id, 'requested_by', r.requested_by, 'reason', r.payload->>'reason'));

  WHEN 'earn_update_settings' THEN
    IF COALESCE(trim(r.payload->>'note'), '') = '' THEN RAISE EXCEPTION 'A note is required'; END IF;
    v_hold := COALESCE((r.payload->>'settlement_hold_days')::integer, s.settlement_hold_days);
    UPDATE public.earn_settings SET
      payouts_enabled = COALESCE((r.payload->>'payouts_enabled')::boolean, payouts_enabled),
      legacy_commission_reconciled = COALESCE((r.payload->>'legacy_commission_reconciled')::boolean, legacy_commission_reconciled),
      settlement_hold_days = v_hold,
      updated_at = now(), updated_by = v_approver
    WHERE id;
    PERFORM public.earn_audit('settings', NULL, 'settings_updated', NULL,
      jsonb_build_object('admin_request_id', r.id, 'requested_by', r.requested_by,
                         'previous', to_jsonb(s), 'changes', r.payload));

  ELSE
    RAISE EXCEPTION 'No VENTS Earn executor for action_type: %', r.action_type;
  END CASE;
END;
$function$;

-- Patch the live maker-checker functions in place (see header).
DO $patch$
DECLARE
  v_def text;
  v_anchor text;
  v_count integer;
BEGIN
  v_def := pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);
  IF position('earn_execute_admin_action' IN v_def) = 0 THEN
    v_anchor := E'    ELSE RAISE EXCEPTION ''No executor mapped for action_type: %'', r.action_type;';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'approve_admin_action anchor found % times (expected 1); refusing to patch', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor,
      E'    ELSE\n      IF r.action_type LIKE ''earn\\_%'' THEN\n        PERFORM public.earn_execute_admin_action(r.id);\n      ELSE\n        RAISE EXCEPTION ''No executor mapped for action_type: %'', r.action_type;\n      END IF;');
  END IF;

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position('earn_approve_reward' IN v_def) = 0 THEN
    v_anchor := E'''decide_organizer_request'', ''decide_service_provider_request''';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'request_admin_action anchor found % times (expected 1); refusing to patch', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor, v_anchor ||
      E',\n    ''earn_approve_reward'', ''earn_reject_reward'', ''earn_reverse_reward'',\n' ||
      E'    ''earn_recognize_event_profit'', ''earn_set_monthly_rate'', ''earn_decide_expense'', ''earn_update_settings''');
  END IF;
END
$patch$;

-- ---------------------------------------------------------------------------
-- Read APIs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_representative_rewards()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rep public.recruiters;
  s public.earn_settings;
  v_month date := date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')::date;
  v_rate bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_rep FROM public.recruiters WHERE id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('representative', NULL);
  END IF;
  SELECT * INTO s FROM public.earn_settings;
  v_rate := public.representative_reward_rate_kobo(v_uid, v_month);

  RETURN jsonb_build_object(
    'representative', jsonb_build_object('id', v_rep.id, 'status', v_rep.status, 'created_at', v_rep.created_at,
                                         'display_name', v_rep.display_name),
    'payouts_enabled', s.payouts_enabled,
    'programme_open', s.legacy_commission_reconciled,
    'current_month', v_month,
    'current_rate_kobo', v_rate,
    'base_reward_kobo', s.base_reward_kobo,
    'rate_review_threshold', s.rate_review_threshold,
    'qualifying_this_month', public.representative_qualifying_count(v_uid, v_month),
    'qualifying_last_month', public.representative_qualifying_count(v_uid, (v_month - interval '1 month')::date),
    -- Only whether funding is available for this representative's own
    -- approved rewards -- never VENTS' profit figures.
    'funding_available', (SELECT p.available_kobo >= v_rate FROM public.earn_profit_pool p),
    'attributions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'organizer_id', a.organizer_id,
        'organizer_name', COALESCE(u.full_name, u.username),
        'organizer_username', u.username,
        'attributed_at', a.attributed_at,
        'events', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('event_id', ev.id, 'title', ev.title,
                                              'eligibility', public.earn_event_eligibility(ev.id) - 'fee_recorded_kobo' - 'fee_refunded_kobo' - 'refund_shortfall_kobo' - 'fee_candidate_kobo' - 'paid_tickets')
                           ORDER BY ev.event_date DESC)
            FROM public.events ev
           WHERE ev.organizer_id = a.organizer_id AND ev.created_at >= a.attributed_at
             AND ev.deleted_at IS NULL), '[]'::jsonb)
      ) ORDER BY a.attributed_at DESC)
      FROM public.representative_attributions a
      JOIN public.users u ON u.id = a.organizer_id
     WHERE a.representative_id = v_uid), '[]'::jsonb),
    'claims', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'organizer_id', c.organizer_id, 'organizer_name', COALESCE(u.full_name, u.username),
        'event_id', c.event_id, 'event_title', ev.title, 'status', c.status, 'amount_kobo', c.amount_kobo,
        'reward_month', c.reward_month, 'created_at', c.created_at, 'decision_reason', c.decision_reason,
        'credited_at', c.credited_at) ORDER BY c.created_at DESC)
      FROM public.representative_reward_claims c
      JOIN public.users u ON u.id = c.organizer_id
      JOIN public.events ev ON ev.id = c.event_id
     WHERE c.representative_id = v_uid), '[]'::jsonb),
    'expenses', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', x.id, 'category', x.category, 'amount_kobo', x.amount_kobo, 'description', x.description,
        'incurred_on', x.incurred_on, 'status', x.status, 'decision_reason', x.decision_reason,
        'created_at', x.created_at) ORDER BY x.created_at DESC)
      FROM public.representative_expenses x WHERE x.representative_id = v_uid), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_referral_confirmations()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'status', c.status, 'created_at', c.created_at,
    'representative_name', COALESCE(r.display_name, u.full_name, u.username),
    'event_title', ev.title) ORDER BY c.created_at DESC), '[]'::jsonb)
    FROM public.representative_reward_claims c
    JOIN public.recruiters r ON r.id = c.representative_id
    JOIN public.users u ON u.id = c.representative_id
    JOIN public.events ev ON ev.id = c.event_id
   WHERE c.organizer_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_vents_earn_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN jsonb_build_object(
    'settings', (SELECT to_jsonb(s) FROM public.earn_settings s),
    'pool', (SELECT to_jsonb(p) FROM public.earn_profit_pool p),
    'claims', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'status', c.status, 'amount_kobo', c.amount_kobo, 'reward_month', c.reward_month,
        'is_free_event', c.is_free_event, 'free_event_verified', c.free_event_verified,
        'representative_id', c.representative_id, 'representative_name', r.display_name,
        'organizer_id', c.organizer_id, 'organizer_name', COALESCE(u.full_name, u.username),
        'event_id', c.event_id, 'event_title', ev.title, 'created_at', c.created_at,
        'decision_reason', c.decision_reason) ORDER BY c.created_at DESC)
      FROM public.representative_reward_claims c
      JOIN public.recruiters r ON r.id = c.representative_id
      JOIN public.users u ON u.id = c.organizer_id
      JOIN public.events ev ON ev.id = c.event_id), '[]'::jsonb),
    'attributions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'representative_id', a.representative_id, 'representative_name', r.display_name,
        'organizer_id', a.organizer_id, 'organizer_name', COALESCE(u.full_name, u.username),
        'attributed_at', a.attributed_at, 'organizer_had_events_before', a.organizer_had_events_before)
        ORDER BY a.attributed_at DESC)
      FROM public.representative_attributions a
      JOIN public.recruiters r ON r.id = a.representative_id
      JOIN public.users u ON u.id = a.organizer_id), '[]'::jsonb),
    'expenses', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', x.id, 'representative_id', x.representative_id, 'representative_name', r.display_name,
        'category', x.category, 'amount_kobo', x.amount_kobo, 'description', x.description,
        'incurred_on', x.incurred_on, 'status', x.status, 'created_at', x.created_at) ORDER BY x.created_at DESC)
      FROM public.representative_expenses x
      JOIN public.recruiters r ON r.id = x.representative_id), '[]'::jsonb),
    'monthly_counts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('representative_id', m.representative_id, 'month', m.reward_month, 'count', m.n)
                       ORDER BY m.reward_month DESC, m.n DESC)
      FROM (SELECT representative_id, reward_month, count(*) AS n FROM public.representative_reward_claims
             WHERE status IN ('approved', 'funded', 'credited') GROUP BY 1, 2) m), '[]'::jsonb),
    'recognitions', COALESCE((
      SELECT jsonb_agg(to_jsonb(g) ORDER BY g.created_at DESC) FROM public.earn_profit_recognitions g), '[]'::jsonb),
    'audit', COALESCE((
      SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC)
        FROM (SELECT * FROM public.earn_audit_log ORDER BY created_at DESC LIMIT 100) l), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_event_profit_candidate(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN public.earn_event_eligibility(p_event_id)
    || jsonb_build_object('already_recognized',
         EXISTS (SELECT 1 FROM public.earn_profit_recognitions WHERE event_id = p_event_id));
END;
$function$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS: every write goes through the functions above.
-- ---------------------------------------------------------------------------
ALTER TABLE public.earn_settings                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earn_audit_log                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.representative_attributions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earn_profit_pool              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earn_profit_recognitions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earn_profit_ledger            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.representative_monthly_rates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.representative_reward_claims  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.representative_expenses       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.earn_settings, public.earn_audit_log, public.representative_attributions,
              public.earn_profit_pool, public.earn_profit_recognitions, public.earn_profit_ledger,
              public.representative_monthly_rates, public.representative_reward_claims,
              public.representative_expenses
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.representative_attributions, public.representative_reward_claims,
                public.representative_expenses, public.representative_monthly_rates
  TO authenticated;

CREATE POLICY representative_attributions_select ON public.representative_attributions
  FOR SELECT TO authenticated
  USING (representative_id = (SELECT auth.uid()) OR organizer_id = (SELECT auth.uid()) OR public.is_admin());
CREATE POLICY representative_reward_claims_select ON public.representative_reward_claims
  FOR SELECT TO authenticated
  USING (representative_id = (SELECT auth.uid()) OR organizer_id = (SELECT auth.uid()) OR public.is_admin());
CREATE POLICY representative_expenses_select ON public.representative_expenses
  FOR SELECT TO authenticated
  USING (representative_id = (SELECT auth.uid()) OR public.is_admin());
CREATE POLICY representative_monthly_rates_select ON public.representative_monthly_rates
  FOR SELECT TO authenticated
  USING (representative_id = (SELECT auth.uid()) OR public.is_admin());

DO $fns$
DECLARE f text;
BEGIN
  -- Internal: no client role may call these directly.
  FOREACH f IN ARRAY ARRAY[
    'public.earn_audit_log_append_only()',
    'public.earn_audit(text,uuid,text,uuid,jsonb)',
    'public.earn_attribute_partnership(uuid)',
    'public.earn_partnership_accepted_trigger()',
    'public.earn_pool_move(text,bigint,uuid,uuid,uuid)',
    'public.earn_event_eligibility(uuid)',
    'public.earn_ticket_refund_adjust_profit()',
    'public.earn_execute_admin_action(uuid)',
    'public.representative_qualifying_count(uuid,date)',
    'public.representative_reward_rate_kobo(uuid,date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.submit_representative_reward_claim(uuid,uuid)',
    'public.respond_to_representative_reward_claim(uuid,boolean)',
    'public.claim_representative_reward(uuid,uuid)',
    'public.submit_representative_expense(text,bigint,text,date,uuid,uuid)',
    'public.get_my_representative_rewards()',
    'public.get_my_referral_confirmations()',
    'public.admin_get_vents_earn_overview()',
    'public.admin_get_event_profit_candidate(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$fns$;

-- earn_ticket_nominal_fee_kobo is a pure helper; keep it off the API too.
REVOKE ALL ON FUNCTION public.earn_ticket_nominal_fee_kobo(numeric) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Legacy 10% commission model: reconciliation snapshot
-- ---------------------------------------------------------------------------
DO $reconcile$
BEGIN
  INSERT INTO public.earn_audit_log (entity_type, action, details)
  VALUES ('settings', 'legacy_commission_snapshot', jsonb_build_object(
    'recruiters',                   (SELECT count(*) FROM public.recruiters),
    'accepted_partnerships',        (SELECT count(*) FROM public.recruiter_partnerships WHERE status = 'accepted'),
    'pending_partnerships',         (SELECT count(*) FROM public.recruiter_partnerships WHERE status = 'pending'),
    'attributions_backfilled',      (SELECT count(*) FROM public.representative_attributions),
    'commission_ledger_exists',     false,
    'commission_accrued_kobo',      0,
    'commission_paid_kobo',         0,
    'note', 'No commission ledger, accrual or payout ever existed for the 10% model. '
            'Management must confirm existing representatives accept the ₦50,000 model, '
            'then set legacy_commission_reconciled through dual control.'));
END
$reconcile$;
