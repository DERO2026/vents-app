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
-- 2. Settlement (approved 2026-10-30, replacing the earlier 7-day hold):
--    - Ticket earnings become withdrawable exactly 48 hours after the
--      event ends (public.event_effective_end_at; never earlier than the
--      end recorded at the sale, so moving an event earlier cannot release
--      money early).
--    - Service-provider earnings become withdrawable exactly 48 hours
--      after the booking is marked completed (service_bookings.completed_at,
--      stamped once by trigger).
--    A credit goes to on_hold_kobo (one earnings_holds row per order or
--    booking). It is released by settle_earnings when nothing blocks it:
--    a pending refund on the event or booking, a deleted or admin-hidden
--    event, a cancelled booking, an admin hold, or a Paystack dispute
--    (which places an admin hold). Release runs on every withdrawal request,
--    when the owner opens their wallet, and in the scheduled cron, which is
--    hourly through pg_cron when that extension is installed and daily
--    through Vercel otherwise. A withdrawal request settles first, so money
--    is withdrawable at exactly the 48-hour mark even between cron runs.
--    Every release records the rule and the times it used (release_basis).
--    All times are timestamptz and the delay is interval '48 hours'
--    (absolute, independent of the session TimeZone and of DST).
--    Balances that already exist before this migration stay available.
--    Representative rewards keep their separate 7-day hold (0201). A
--    reversed payout returns to the available balance.
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
  -- What the release waits for: the event (ticket sales) or the booking.
  event_id      uuid REFERENCES public.events(id) ON DELETE RESTRICT,
  event_end_at_sale timestamptz,
  booking_id    uuid REFERENCES public.service_bookings(id) ON DELETE RESTRICT,
  -- An admin (or a Paystack dispute) can freeze a hold; only a super admin
  -- who is not the owner can lift it (admin_set_earnings_hold).
  admin_hold_at     timestamptz,
  admin_hold_by     uuid,
  admin_hold_reason text,
  dispute_reference text,
  released_at   timestamptz,
  -- The rule, times and checks the release was decided on (audit).
  release_basis jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earnings_holds_source_once UNIQUE (source_kind, source_key),
  CONSTRAINT earnings_holds_has_subject CHECK (
    (source_kind = 'ticket_sale' AND event_id IS NOT NULL AND event_end_at_sale IS NOT NULL)
    OR (source_kind = 'service_booking' AND booking_id IS NOT NULL)),
  CONSTRAINT earnings_holds_adds_up CHECK (amount_kobo + refunded_kobo + released_kobo = original_kobo),
  CONSTRAINT earnings_holds_released_empty CHECK (released_at IS NULL OR amount_kobo = 0)
);
CREATE INDEX IF NOT EXISTS earnings_holds_open_by_owner ON public.earnings_holds (owner_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS earnings_holds_open_by_event ON public.earnings_holds (event_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS earnings_holds_open_by_booking ON public.earnings_holds (booking_id) WHERE released_at IS NULL;

-- When a booking was confirmed completed, and by whom: stamped once, by
-- trigger, on whichever path sets status = 'completed'
-- (complete_service_booking today).
ALTER TABLE public.service_bookings ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE public.service_bookings ADD COLUMN IF NOT EXISTS completed_by uuid;
CREATE OR REPLACE FUNCTION public.service_bookings_stamp_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.completed_at IS NOT NULL THEN
    NEW.completed_at := OLD.completed_at;   -- never moved once set
    NEW.completed_by := OLD.completed_by;
  ELSIF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  ELSE
    NEW.completed_at := NULL;               -- callers cannot set it
    NEW.completed_by := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS service_bookings_stamp_completion ON public.service_bookings;
CREATE TRIGGER service_bookings_stamp_completion BEFORE INSERT OR UPDATE ON public.service_bookings
  FOR EACH ROW EXECUTE FUNCTION public.service_bookings_stamp_completion();

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

-- 48 hours, as an absolute interval (not '2 days', which follows the
-- session TimeZone across a DST change).
CREATE OR REPLACE FUNCTION public.earnings_release_delay()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT interval '48 hours';
$function$;

-- Called by the credit functions while they hold the wallet row lock.
-- p_subject is the event id (ticket_sale) or the booking id (service_booking).
CREATE OR REPLACE FUNCTION public.earnings_place_hold(p_owner uuid, p_kind text, p_key text, p_amount_kobo bigint, p_subject uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_end timestamptz;
BEGIN
  IF p_kind = 'ticket_sale' THEN
    SELECT public.event_effective_end_at(e.event_date, e.end_date) INTO v_end FROM public.events e WHERE e.id = p_subject;
    INSERT INTO public.earnings_holds (owner_id, source_kind, source_key, original_kobo, amount_kobo, event_id, event_end_at_sale)
    VALUES (p_owner, p_kind, p_key, p_amount_kobo, p_amount_kobo, p_subject, v_end);
  ELSE
    INSERT INTO public.earnings_holds (owner_id, source_kind, source_key, original_kobo, amount_kobo, booking_id)
    VALUES (p_owner, p_kind, p_key, p_amount_kobo, p_amount_kobo, p_subject);
  END IF;
END;
$function$;

-- When a hold may be released, and what (if anything) blocks it now.
-- {release_at, blockers[], rule, ...}; releasable when blockers is [].
CREATE OR REPLACE FUNCTION public.earnings_hold_state(p_hold_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  h public.earnings_holds;
  e record;
  b record;
  v_end timestamptz;
  v_release timestamptz;
  v_blockers text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO h FROM public.earnings_holds WHERE id = p_hold_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF h.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('released', true, 'released_at', h.released_at, 'blockers', '[]'::jsonb);
  END IF;
  IF h.admin_hold_at IS NOT NULL THEN
    v_blockers := array_append(v_blockers, CASE WHEN h.dispute_reference IS NOT NULL THEN 'payment_dispute' ELSE 'admin_hold' END);
  END IF;

  IF h.source_kind = 'ticket_sale' THEN
    SELECT ev.event_date, ev.end_date, ev.deleted_at, COALESCE(ev.hidden_by_admin, false) AS hidden
      INTO e FROM public.events ev WHERE ev.id = h.event_id;
    -- The later of the end recorded at the sale and the event's current end:
    -- postponing delays the release, moving the end earlier does not hasten it.
    v_end := GREATEST(h.event_end_at_sale, public.event_effective_end_at(e.event_date, e.end_date));
    v_release := v_end + public.earnings_release_delay();
    IF e.deleted_at IS NOT NULL THEN v_blockers := array_append(v_blockers, 'event_deleted'); END IF;
    IF e.hidden THEN v_blockers := array_append(v_blockers, 'event_hidden_by_admin'); END IF;
    IF EXISTS (SELECT 1 FROM public.tickets t WHERE t.event_id = h.event_id AND t.payment_status = 'refund_pending') THEN
      v_blockers := array_append(v_blockers, 'refund_pending');
    END IF;
    IF now() < v_release THEN v_blockers := array_append(v_blockers, 'not_yet'); END IF;
    RETURN jsonb_build_object('rule', 'event_end_plus_48h', 'event_end_at', v_end, 'event_end_at_sale', h.event_end_at_sale,
                              'release_at', v_release, 'checked_at', now(), 'blockers', to_jsonb(v_blockers));
  END IF;

  SELECT sb.status, sb.payment_status, sb.completed_at INTO b FROM public.service_bookings sb WHERE sb.id = h.booking_id;
  v_release := b.completed_at + public.earnings_release_delay();
  IF b.status = 'cancelled' THEN v_blockers := array_append(v_blockers, 'booking_cancelled'); END IF;
  IF b.payment_status IN ('refund_pending', 'refunded') THEN v_blockers := array_append(v_blockers, 'refund_pending'); END IF;
  IF b.status IS DISTINCT FROM 'completed' OR b.completed_at IS NULL THEN
    v_blockers := array_append(v_blockers, 'not_completed');
  ELSIF now() < v_release THEN
    v_blockers := array_append(v_blockers, 'not_yet');
  END IF;
  RETURN jsonb_build_object('rule', 'booking_completed_plus_48h', 'completed_at', b.completed_at,
                            'release_at', v_release, 'checked_at', now(), 'blockers', to_jsonb(v_blockers));
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
  v_state    jsonb;
  h public.earnings_holds;
  r public.earnings_recoveries;
BEGIN
  SELECT balance_kobo INTO v_balance FROM public.organizer_wallets WHERE organizer_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('released_kobo', 0, 'recovered_kobo', 0);
  END IF;

  FOR h IN SELECT * FROM public.earnings_holds
            WHERE owner_id = p_owner AND released_at IS NULL
            ORDER BY created_at, id FOR UPDATE
  LOOP
    v_state := public.earnings_hold_state(h.id);
    CONTINUE WHEN jsonb_array_length(v_state->'blockers') > 0;
    UPDATE public.earnings_holds
       SET released_at = now(), released_kobo = released_kobo + h.amount_kobo, amount_kobo = 0,
           release_basis = v_state
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

-- Cron entry point (server only): settles every wallet with a hold that is
-- releasable now.
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
                    WHERE h.owner_id = w.organizer_id AND h.released_at IS NULL
                      AND jsonb_array_length(public.earnings_hold_state(h.id)->'blockers') = 0)
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

-- Optional: run the release hourly inside the database when pg_cron is
-- already installed (it is not installed by this migration). The Vercel
-- daily cron calls the same function either way.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$SELECT cron.schedule('vents_release_matured_earnings', '7 * * * *', 'SELECT public.release_matured_earnings(500)')$q$;
  ELSE
    RAISE NOTICE '0203: pg_cron is not installed; matured earnings are released by the Vercel cron and on each withdrawal request';
  END IF;
END
$cron$;

-- Place (any admin) or lift (a super admin) a hold on held earnings, e.g.
-- while a complaint is investigated. Neither can be done by the owner.
CREATE OR REPLACE FUNCTION public.admin_set_earnings_hold(p_hold_id uuid, p_hold boolean, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  h public.earnings_holds;
BEGIN
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_hold AND NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF NOT p_hold AND NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required to lift a hold'; END IF;
  PERFORM 1 FROM public.organizer_wallets w JOIN public.earnings_holds x ON x.owner_id = w.organizer_id
   WHERE x.id = p_hold_id FOR UPDATE OF w;
  SELECT * INTO h FROM public.earnings_holds WHERE id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hold not found'; END IF;
  IF h.owner_id = auth.uid() THEN RAISE EXCEPTION 'An admin cannot place or lift a hold on their own earnings'; END IF;
  IF h.released_at IS NOT NULL THEN RAISE EXCEPTION 'These earnings were already released'; END IF;

  UPDATE public.earnings_holds
     SET admin_hold_at = CASE WHEN p_hold THEN COALESCE(admin_hold_at, now()) END,
         admin_hold_by = CASE WHEN p_hold THEN COALESCE(admin_hold_by, auth.uid()) END,
         admin_hold_reason = CASE WHEN p_hold THEN COALESCE(admin_hold_reason, trim(p_reason)) END,
         dispute_reference = CASE WHEN p_hold THEN dispute_reference END
   WHERE id = h.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), CASE WHEN p_hold THEN 'earnings_hold_placed' ELSE 'earnings_hold_lifted' END, h.owner_id,
          jsonb_build_object('hold_id', h.id, 'source_kind', h.source_kind, 'source_key', h.source_key,
                             'amount_kobo', h.amount_kobo, 'reason', trim(p_reason),
                             'previous_hold_reason', h.admin_hold_reason, 'dispute_reference', h.dispute_reference),
          public.actor_role());
  RETURN jsonb_build_object('hold_id', h.id, 'admin_hold', p_hold);
END;
$function$;

-- Paystack charge.dispute.* (server only): freeze the disputed sale's held
-- earnings. Never lifted automatically; an admin lifts it after review.
-- If the earnings were already released, the dispute is logged for admins.
CREATE OR REPLACE FUNCTION public.place_payment_dispute_hold(p_reference text, p_dispute_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ref text;
  h public.earnings_holds;
BEGIN
  IF p_reference IS NULL OR p_reference = '' THEN RETURN 'not_found'; END IF;
  SELECT x.payment_ref INTO v_ref FROM public.get_pending_purchase_owner(p_reference) x;
  SELECT * INTO h FROM public.earnings_holds
   WHERE (source_kind = 'ticket_sale' AND source_key = COALESCE(v_ref, p_reference))
      OR (source_kind = 'service_booking' AND booking_id = (SELECT sb.id FROM public.service_bookings sb WHERE sb.payment_ref = p_reference LIMIT 1))
   LIMIT 1;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  PERFORM 1 FROM public.organizer_wallets w WHERE w.organizer_id = h.owner_id FOR UPDATE;
  SELECT * INTO h FROM public.earnings_holds WHERE id = h.id FOR UPDATE;

  IF h.released_at IS NOT NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (NULL, 'payment_dispute_after_release', h.owner_id,
            jsonb_build_object('hold_id', h.id, 'reference', p_reference, 'dispute_id', p_dispute_id), 'webhook');
    RETURN 'already_released';
  END IF;
  IF h.dispute_reference IS NOT DISTINCT FROM p_dispute_id AND h.admin_hold_at IS NOT NULL THEN
    RETURN 'already_held';
  END IF;
  UPDATE public.earnings_holds
     SET admin_hold_at = COALESCE(admin_hold_at, now()),
         admin_hold_reason = COALESCE(admin_hold_reason, 'Paystack payment dispute ' || COALESCE(p_dispute_id, '')),
         dispute_reference = COALESCE(p_dispute_id, p_reference)
   WHERE id = h.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'earnings_hold_placed', h.owner_id,
          jsonb_build_object('hold_id', h.id, 'reason', 'payment_dispute', 'reference', p_reference, 'dispute_id', p_dispute_id),
          'webhook');
  RETURN 'held';
END;
$function$;

-- Held earnings with their release time and blockers, for the wallet
-- (own) and the admin console (anyone's).
CREATE OR REPLACE FUNCTION public.get_earnings_holds(p_owner uuid DEFAULT NULL)
 RETURNS TABLE(hold_id uuid, source_kind text, amount_kobo bigint, original_kobo bigint, release_at timestamptz,
               blockers jsonb, admin_hold_reason text, event_title text, created_at timestamptz)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_owner uuid := COALESCE(p_owner, auth.uid());
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_owner <> auth.uid() AND NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  SELECT h.id, h.source_kind, h.amount_kobo, h.original_kobo,
         (s.st->>'release_at')::timestamptz, s.st->'blockers', h.admin_hold_reason, ev.title, h.created_at
    FROM public.earnings_holds h
    CROSS JOIN LATERAL (SELECT public.earnings_hold_state(h.id) AS st) s
    LEFT JOIN public.events ev ON ev.id = h.event_id
   WHERE h.owner_id = v_owner AND h.released_at IS NULL AND h.amount_kobo > 0
   ORDER BY (s.st->>'release_at')::timestamptz NULLS LAST, h.created_at;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Rule 5 and rules 1/2: patches to the live money functions
-- ---------------------------------------------------------------------------
-- create_pending_purchase
SELECT pg_temp.vents_0203_patch('public.create_pending_purchase(uuid,text,jsonb,text,text)', 'e10d13bed6fe2e53743c1fb5bca6cd57', ARRAY[
  $x0203$v_amount_kobo := round(v_unit_price * v_count * (1.05 - v_discount_pct / 100) * 100)::bigint;$x0203$, $x0203$v_amount_kobo := round(v_unit_price * v_count * (public.ticket_fee_buyer_multiplier('v2_4_5') - v_discount_pct / 100) * 100)::bigint;$x0203$,
  $x0203$     AND status = 'pending'
     AND created_at > now() - interval '30 minutes'$x0203$, $x0203$     AND status = 'pending'
     AND fee_model = 'v2_4_5'
     AND created_at > now() - interval '30 minutes'$x0203$,
  $x0203$(event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at)$x0203$, $x0203$(event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at, fee_model)$x0203$,
  $x0203$     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END);$x0203$, $x0203$     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END, 'v2_4_5');$x0203$
]);

-- confirm_ticket_payment
SELECT pg_temp.vents_0203_patch('public.confirm_ticket_payment(text,bigint)', '56d671416e12041eefe0856cec303b75', ARRAY[
  $x0203$  v_prior_paid_count integer;
BEGIN$x0203$, $x0203$  v_prior_paid_count integer;
  v_fee_model        text;
  v_face_kobo        bigint;
  v_commission_kobo  bigint;
BEGIN$x0203$,
  $x0203$         max(t.ticket_type), e.organizer_id, e.id, max(e.title),$x0203$, $x0203$         max(t.ticket_type), max(t.fee_model), e.organizer_id, e.id, max(e.title),$x0203$,
  $x0203$         v_ticket_type, v_organizer_id, v_event_id, v_event_title,$x0203$, $x0203$         v_ticket_type, v_fee_model, v_organizer_id, v_event_id, v_event_title,$x0203$,
  $x0203$v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;$x0203$, $x0203$v_expected_kobo := round(v_total_amount * (public.ticket_fee_buyer_multiplier(v_fee_model) - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;$x0203$,
  $x0203$    v_credit_kobo := floor(v_total_amount * 100)::bigint;$x0203$, $x0203$    -- Organizer settlement = face value minus the VENTS organizer commission.
    v_face_kobo := floor(v_total_amount * 100)::bigint;
    v_commission_kobo := public.ticket_fee_commission_kobo(v_face_kobo, v_fee_model);
    v_credit_kobo := v_face_kobo - v_commission_kobo;$x0203$,
  $x0203$      'gross_kobo', v_credit_kobo,
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_credit_kobo),$x0203$, $x0203$      'gross_kobo', v_face_kobo,
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_face_kobo),
      'organizer_commission_kobo', v_commission_kobo,
      'net_kobo', v_credit_kobo,
      'fee_model', v_fee_model,$x0203$
]);

-- confirm_ticket_payment_via_wallet
SELECT pg_temp.vents_0203_patch('public.confirm_ticket_payment_via_wallet(text)', '99e7184e21cd3acee3739ebd7d260464', ARRAY[
  $x0203$  v_prior_paid_count integer;
BEGIN$x0203$, $x0203$  v_prior_paid_count integer;
  v_fee_model        text;
  v_face_kobo        bigint;
  v_commission_kobo  bigint;
BEGIN$x0203$,
  $x0203$         max(t.ticket_type), e.organizer_id, e.id, max(e.title),$x0203$, $x0203$         max(t.ticket_type), max(t.fee_model), e.organizer_id, e.id, max(e.title),$x0203$,
  $x0203$         v_ticket_type, v_organizer_id, v_event_id, v_event_title,$x0203$, $x0203$         v_ticket_type, v_fee_model, v_organizer_id, v_event_id, v_event_title,$x0203$,
  $x0203$v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;$x0203$, $x0203$v_expected_kobo := round(v_total_amount * (public.ticket_fee_buyer_multiplier(v_fee_model) - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;$x0203$,
  $x0203$    v_credit_kobo := floor(v_total_amount * 100)::bigint;$x0203$, $x0203$    -- Organizer settlement = face value minus the VENTS organizer commission.
    v_face_kobo := floor(v_total_amount * 100)::bigint;
    v_commission_kobo := public.ticket_fee_commission_kobo(v_face_kobo, v_fee_model);
    v_credit_kobo := v_face_kobo - v_commission_kobo;$x0203$,
  $x0203$      'gross_kobo', v_credit_kobo,
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_credit_kobo),$x0203$, $x0203$      'gross_kobo', v_face_kobo,
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_face_kobo),
      'organizer_commission_kobo', v_commission_kobo,
      'net_kobo', v_credit_kobo,
      'fee_model', v_fee_model,$x0203$
]);

-- refund_ticket
SELECT pg_temp.vents_0203_patch('public.refund_ticket(uuid,text)', '6ad935dc8a027533a1481208045fe861', ARRAY[
  $x0203$  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage,
$x0203$, $x0203$  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage, t.fee_model,
$x0203$,
  $x0203$  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;$x0203$, $x0203$  v_refund_kobo := round(v_ticket.amount * (public.ticket_fee_buyer_multiplier(v_ticket.fee_model) - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;$x0203$,
  $x0203$      v_owed_kobo := floor(v_ticket.amount * 100)::bigint;$x0203$, $x0203$      v_owed_kobo := floor(v_ticket.amount * 100)::bigint
                   - public.ticket_fee_commission_kobo(floor(v_ticket.amount * 100)::bigint, v_ticket.fee_model);$x0203$,
  $x0203$      SELECT balance_kobo INTO v_wallet_bal
        FROM public.organizer_wallets
       WHERE organizer_id = v_ticket.organizer_id
         FOR UPDATE;

      v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_owed_kobo);

      IF v_actual_debit > 0 THEN
        UPDATE public.organizer_wallets
           SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
         WHERE organizer_id = v_ticket.organizer_id;

        INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
        VALUES (
          v_ticket.organizer_id, 'refund', v_actual_debit,
          'Refund (Wallet): ' || v_ticket.ticket_type ||
            CASE WHEN v_actual_debit < v_owed_kobo
                 THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_owed_kobo || ' kobo owed)'
                 ELSE '' END,
          v_ticket.id
        );
      END IF;

      IF v_actual_debit < v_owed_kobo THEN
        INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
        VALUES (
          auth.uid(), 'refund_wallet_shortfall', v_ticket.organizer_id,
          jsonb_build_object(
            'ticket_id', v_ticket.id, 'owed_kobo', v_owed_kobo, 'recovered_kobo', v_actual_debit,
            'shortfall_kobo', v_owed_kobo - v_actual_debit
          ),
          public.actor_role()
        );
      END IF;
$x0203$, $x0203$      v_actual_debit := public.earnings_debit_for_refund(
        v_ticket.organizer_id, v_owed_kobo,
        'ticket_sale', COALESCE(v_ticket.payment_ref, v_ticket.id::text),
        'ticket_refund', v_ticket.id::text,
        'Refund (Wallet): ' || v_ticket.ticket_type, v_ticket.id,
        jsonb_build_object('ticket_id', v_ticket.id),
        auth.uid(), public.actor_role(), 'refund_wallet_shortfall');
$x0203$
]);

-- finalize_ticket_refund
SELECT pg_temp.vents_0203_patch('public.finalize_ticket_refund(text)', '0006acfb1f30da94029367dbc21a6b98', ARRAY[
  $x0203$  SELECT t.id, t.user_id, t.amount, t.discount_percentage, t.ticket_type, t.payment_status,
$x0203$, $x0203$  SELECT t.id, t.user_id, t.amount, t.discount_percentage, t.fee_model, t.payment_ref, t.ticket_type, t.payment_status,
$x0203$,
  $x0203$  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;$x0203$, $x0203$  v_refund_kobo := round(v_ticket.amount * (public.ticket_fee_buyer_multiplier(v_ticket.fee_model) - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;$x0203$,
  $x0203$    v_owed_kobo := floor(v_ticket.amount * 100)::bigint;$x0203$, $x0203$    v_owed_kobo := floor(v_ticket.amount * 100)::bigint
                 - public.ticket_fee_commission_kobo(floor(v_ticket.amount * 100)::bigint, v_ticket.fee_model);$x0203$,
  $x0203$    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_ticket.organizer_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_owed_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_ticket.organizer_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
      VALUES (
        v_ticket.organizer_id, 'refund', v_actual_debit,
        'Refund: ' || v_ticket.ticket_type ||
          CASE WHEN v_actual_debit < v_owed_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_owed_kobo || ' kobo owed)'
               ELSE '' END,
        v_ticket.id
      );
    END IF;

    IF v_actual_debit < v_owed_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        v_ticket.refund_initiated_by, 'refund_wallet_shortfall', v_ticket.organizer_id,
        jsonb_build_object(
          'ticket_id', v_ticket.id, 'owed_kobo', v_owed_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_owed_kobo - v_actual_debit
        ),
        'webhook'
      );
    END IF;
$x0203$, $x0203$    v_actual_debit := public.earnings_debit_for_refund(
      v_ticket.organizer_id, v_owed_kobo,
      'ticket_sale', COALESCE(v_ticket.payment_ref, v_ticket.id::text),
      'ticket_refund', v_ticket.id::text,
      'Refund: ' || v_ticket.ticket_type, v_ticket.id,
      jsonb_build_object('ticket_id', v_ticket.id),
      v_ticket.refund_initiated_by, 'webhook', 'refund_wallet_shortfall');
$x0203$
]);

-- cancel_service_booking
SELECT pg_temp.vents_0203_patch('public.cancel_service_booking(uuid,text)', '80d930ef3b259cc982a91ec4895b732c', ARRAY[
  $x0203$    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_provider_user_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_booking.subtotal_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_provider_user_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
      VALUES (
        v_provider_user_id, 'refund', v_actual_debit,
        'Refund (Wallet): service booking' ||
          CASE WHEN v_actual_debit < v_booking.subtotal_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_booking.subtotal_kobo || ' kobo owed)'
               ELSE '' END,
        jsonb_build_object('service_booking_id', v_booking.id)
      );
    END IF;

    IF v_actual_debit < v_booking.subtotal_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), 'refund_service_booking_wallet_shortfall', v_provider_user_id,
        jsonb_build_object(
          'booking_id', v_booking.id, 'owed_kobo', v_booking.subtotal_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_booking.subtotal_kobo - v_actual_debit
        ),
        public.actor_role()
      );
    END IF;
$x0203$, $x0203$    v_actual_debit := public.earnings_debit_for_refund(
      v_provider_user_id, v_booking.subtotal_kobo,
      'service_booking', v_booking.id::text,
      'service_booking_refund', v_booking.id::text,
      'Refund (Wallet): service booking', NULL,
      jsonb_build_object('service_booking_id', v_booking.id, 'booking_id', v_booking.id),
      auth.uid(), public.actor_role(), 'refund_service_booking_wallet_shortfall');
$x0203$
]);

-- finalize_service_booking_refund
SELECT pg_temp.vents_0203_patch('public.finalize_service_booking_refund(text)', 'e2c6c2979960fa5477da0de0f49fefb7', ARRAY[
  $x0203$    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_booking.provider_user_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_booking.subtotal_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_booking.provider_user_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
      VALUES (
        v_booking.provider_user_id, 'refund', v_actual_debit,
        'Refund (Paystack): service booking' ||
          CASE WHEN v_actual_debit < v_booking.subtotal_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_booking.subtotal_kobo || ' kobo owed)'
               ELSE '' END,
        jsonb_build_object('service_booking_id', v_booking.id)
      );
    END IF;

    IF v_actual_debit < v_booking.subtotal_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        v_booking.refund_initiated_by, 'refund_service_booking_shortfall', v_booking.provider_user_id,
        jsonb_build_object(
          'booking_id', v_booking.id, 'owed_kobo', v_booking.subtotal_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_booking.subtotal_kobo - v_actual_debit
        ),
        'webhook'
      );
    END IF;
$x0203$, $x0203$    v_actual_debit := public.earnings_debit_for_refund(
      v_booking.provider_user_id, v_booking.subtotal_kobo,
      'service_booking', v_booking.id::text,
      'service_booking_refund', v_booking.id::text,
      'Refund (Paystack): service booking', NULL,
      jsonb_build_object('service_booking_id', v_booking.id, 'booking_id', v_booking.id),
      v_booking.refund_initiated_by, 'webhook', 'refund_service_booking_shortfall');
$x0203$
]);

-- get_event_analytics
SELECT pg_temp.vents_0203_patch('public.get_event_analytics(uuid)', '1657aa6186eb1286981f5fe258d84654', ARRAY[
  $x0203$      COALESCE(sum(amount * 100), 0)::bigint AS gross_kobo,
$x0203$, $x0203$      COALESCE(sum(amount * 100), 0)::bigint AS gross_kobo,
      COALESCE(sum(public.ticket_fee_commission_kobo(floor(amount * 100)::bigint, fee_model)), 0)::bigint AS commission_kobo,
$x0203$,
  $x0203$round(amount * (1.05 - COALESCE(discount_percentage, 0) / 100) * 100)$x0203$, $x0203$round(amount * (public.ticket_fee_buyer_multiplier(fee_model) - COALESCE(discount_percentage, 0) / 100) * 100)$x0203$,
  $x0203$      'organizerEarnedKobo', o.gross_kobo,$x0203$, $x0203$      'organizerEarnedKobo', o.gross_kobo - o.commission_kobo,
      'ventsCommissionKobo', o.commission_kobo,$x0203$
]);

-- credit_organizer_wallet
SELECT pg_temp.vents_0203_patch('public.credit_organizer_wallet(uuid,bigint,text,uuid,jsonb)', '9b889f4696ceb56f990cdf582c40c679', ARRAY[
  $x0203$  SELECT t.id, e.organizer_id, t.payment_status
$x0203$, $x0203$  SELECT t.id, e.organizer_id, t.payment_status, t.payment_ref, e.id AS event_id
$x0203$,
  $x0203$  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo)
  VALUES (p_organizer_id, p_amount_kobo, p_amount_kobo)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo      = organizer_wallets.balance_kobo + p_amount_kobo,$x0203$, $x0203$  -- Settlement hold: the sale is earned now but withdrawable only 48
  -- hours after the event ends (see earnings_hold_state).
  INSERT INTO public.organizer_wallets (organizer_id, on_hold_kobo, total_earned_kobo)
  VALUES (p_organizer_id, p_amount_kobo, p_amount_kobo)
  ON CONFLICT (organizer_id) DO UPDATE
    SET on_hold_kobo      = organizer_wallets.on_hold_kobo + p_amount_kobo,$x0203$,
  $x0203$  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id, p_metadata);
END;$x0203$, $x0203$  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id, p_metadata);

  PERFORM public.earnings_place_hold(p_organizer_id, 'ticket_sale',
                                     COALESCE(v_ticket.payment_ref, p_ticket_sale_id::text), p_amount_kobo,
                                     v_ticket.event_id);
END;$x0203$
]);

-- credit_provider_wallet_for_booking
SELECT pg_temp.vents_0203_patch('public.credit_provider_wallet_for_booking(uuid,bigint,uuid,text)', '2f0724e6b3de78ddd97b27af3a1188c7', ARRAY[
  $x0203$  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo, total_withdrawn_kobo, pending_kobo)
  VALUES (p_provider_user_id, p_amount_kobo, p_amount_kobo, 0, 0)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo = public.organizer_wallets.balance_kobo + p_amount_kobo,$x0203$, $x0203$  -- Settlement hold until 48 hours after completion (see earnings_hold_state).
  INSERT INTO public.organizer_wallets (organizer_id, on_hold_kobo, total_earned_kobo, total_withdrawn_kobo, pending_kobo)
  VALUES (p_provider_user_id, p_amount_kobo, p_amount_kobo, 0, 0)
  ON CONFLICT (organizer_id) DO UPDATE
    SET on_hold_kobo = public.organizer_wallets.on_hold_kobo + p_amount_kobo,$x0203$,
  $x0203$  VALUES (p_provider_user_id, 'credit', p_amount_kobo, p_description, jsonb_build_object('service_booking_id', p_booking_id));
END;$x0203$, $x0203$  VALUES (p_provider_user_id, 'credit', p_amount_kobo, p_description, jsonb_build_object('service_booking_id', p_booking_id));

  PERFORM public.earnings_place_hold(p_provider_user_id, 'service_booking', p_booking_id::text, p_amount_kobo, p_booking_id);
END;$x0203$
]);

-- request_organizer_payout
SELECT pg_temp.vents_0203_patch('public.request_organizer_payout(bigint,uuid,text)', 'dd12a3e3b54b5aa620404e8b928527f4', ARRAY[
  $x0203$  SELECT balance_kobo INTO v_balance
  FROM public.organizer_wallets
  WHERE organizer_id = v_organizer_id
  FOR UPDATE;
$x0203$, $x0203$  -- Matured holds become available (and outstanding recoveries are
  -- deducted) before the balance is read.
  PERFORM public.settle_earnings(v_organizer_id);

  SELECT balance_kobo INTO v_balance
  FROM public.organizer_wallets
  WHERE organizer_id = v_organizer_id
  FOR UPDATE;
$x0203$
]);

-- earn_event_eligibility (0201/0202 text in this repo)
SELECT pg_temp.vents_0203_patch('public.earn_event_eligibility(uuid)', '1e1c85cc28f52fe84a6d7d3a45f20df8', ARRAY[
  $x0203$SELECT COALESCE(sum(GREATEST(0, COALESCE((ot.metadata->>'buyer_fee_kobo')::bigint, 0))), 0)$x0203$, $x0203$SELECT COALESCE(sum(GREATEST(0, COALESCE((ot.metadata->>'buyer_fee_kobo')::bigint, 0))
                    + GREATEST(0, COALESCE((ot.metadata->>'organizer_commission_kobo')::bigint, 0))), 0)$x0203$,
  $x0203$SELECT COALESCE(sum(public.earn_ticket_nominal_fee_kobo(t.amount)), 0)$x0203$, $x0203$SELECT COALESCE(sum(public.earn_ticket_nominal_fee_kobo(t.amount, t.fee_model)), 0)$x0203$
]);

-- earn_ticket_refund_adjust_profit (0201/0202 text in this repo)
SELECT pg_temp.vents_0203_patch('public.earn_ticket_refund_adjust_profit()', 'dbe79d321193934acacc9e36f9c6a580', ARRAY[
  $x0203$v_fee := public.earn_ticket_nominal_fee_kobo(NEW.amount);$x0203$, $x0203$v_fee := public.earn_ticket_nominal_fee_kobo(NEW.amount, NEW.fee_model);$x0203$
]);

-- complete_organizer_payout (0201/0202 text in this repo)
SELECT pg_temp.vents_0203_patch('public.complete_organizer_payout(text)', 'ca6b015abbe0c1a4cdb66470d5a4ad29', ARRAY[
  $x0203$    IF v_debit < v_amount_kobo THEN
$x0203$, $x0203$    IF v_debit < v_amount_kobo THEN
      -- Rule: never absorb it silently; recover it from future earnings.
      INSERT INTO public.earnings_recoveries (owner_id, source_kind, source_key, amount_kobo, reason, metadata)
      VALUES (v_organizer_id, 'payout_after_cancel', v_id::text, v_amount_kobo - v_debit,
              'Withdrawal paid after it was cancelled',
              jsonb_build_object('request_id', v_id, 'amount_kobo', v_amount_kobo, 'recovered_now_kobo', v_debit))
      ON CONFLICT (source_kind, source_key) DO NOTHING;
$x0203$
]);

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
           COUNT(*) FILTER (WHERE h.released_at IS NULL
                              AND jsonb_array_length(public.earnings_hold_state(h.id)->'blockers') = 0
                              AND (public.earnings_hold_state(h.id)->>'release_at')::timestamptz < now() - interval '1 day')::int AS overdue
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
    'public.earnings_place_hold(uuid,text,text,bigint,uuid)',
    'public.earnings_hold_state(uuid)',
    'public.service_bookings_stamp_completion()',
    'public.place_payment_dispute_hold(text,text)',
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
    'public.earnings_release_delay()',
    'public.get_earnings_holds(uuid)',
    'public.admin_set_earnings_hold(uuid,boolean,text)',
    'public.settle_my_earnings()',
    'public.admin_earnings_reconciliation()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin') THEN
    GRANT EXECUTE ON FUNCTION public.release_matured_earnings(integer) TO project_admin;
    GRANT EXECUTE ON FUNCTION public.place_payment_dispute_hold(text, text) TO project_admin;
  END IF;
END
$grants$;

DROP FUNCTION pg_temp.vents_0203_patch(regprocedure, text, text[]);
