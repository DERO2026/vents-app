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
--    - A provider cannot mark a booking complete before its scheduled
--      start (Africa/Lagos); rescheduling can raise that start, never
--      lower it (service_start_floor_at). The provider clock is 48 hours
--      after the later of completion and that start. The customer can
--      dispute a completed booking inside the same 48 hours; two admins
--      resolve it (request_admin_action 'resolve_booking_dispute'). Upheld
--      for the customer, the booking becomes refundable through the
--      existing booking refund path.
--    A credit goes to on_hold_kobo (one earnings_holds row per order or
--    booking). It is released by settle_earnings when nothing blocks it:
--    a refund in progress on that order or booking (or, when a refund
--    cannot be tied to an order, on the event), a deleted or admin-hidden
--    event, a cancelled booking, an open or upheld customer dispute, an
--    admin hold (placed directly or while reviewing a user report -- a
--    report alone never holds anything), or a Paystack dispute. Release
--    runs on every withdrawal request, when the owner opens their wallet,
--    and in the scheduled cron (daily on Vercel; hourly through pg_cron
--    when that extension is installed). A withdrawal request settles
--    first, so money is withdrawable at exactly the 48-hour mark. Every
--    release records the rule and times it used (release_basis). All
--    times are timestamptz and the delay is interval '48 hours'.
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
  dispute_resolution text,           -- what Paystack later reported (never lifts the hold by itself)
  admin_hold_report_id uuid REFERENCES public.reports(id) ON DELETE RESTRICT,
  released_at   timestamptz,
  -- The rule, times and checks the release was decided on (audit).
  release_basis jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earnings_holds_source_once UNIQUE (source_kind, source_key),
  CONSTRAINT earnings_holds_has_subject CHECK (
    (source_kind = 'ticket_sale' AND event_id IS NOT NULL)
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
-- The earliest the service can have happened: the scheduled start, kept as a
-- floor that rescheduling can raise but never lower.
ALTER TABLE public.service_bookings ADD COLUMN IF NOT EXISTS service_start_floor_at timestamptz;

-- scheduled_date/scheduled_time are a local date and time with no zone;
-- VENTS operates in Nigeria, so they are read as Africa/Lagos (UTC+1, no
-- DST). NULL when there is no scheduled date.
CREATE OR REPLACE FUNCTION public.booking_scheduled_start_at(p_date date, p_time time without time zone)
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN p_date IS NULL THEN NULL
              ELSE (p_date + COALESCE(p_time, time '00:00')) AT TIME ZONE 'Africa/Lagos' END;
$function$;

-- No backfill (it would rewrite existing bookings and fire their triggers):
-- the trigger below sets the floor on a booking's next write, including the
-- one that completes it, and every check reads GREATEST(floor, schedule).

CREATE OR REPLACE FUNCTION public.service_bookings_stamp_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_start timestamptz := public.booking_scheduled_start_at(NEW.scheduled_date, NEW.scheduled_time);
  v_provider uuid;
BEGIN
  -- Floor: never lowered, whoever edits the dates.
  IF TG_OP = 'UPDATE' THEN
    NEW.service_start_floor_at := GREATEST(OLD.service_start_floor_at, v_start);
  ELSE
    NEW.service_start_floor_at := v_start;
  END IF;

  IF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    -- Approved rule: a provider cannot mark a booking complete before its
    -- scheduled service time. Only an admin who is not the provider may
    -- complete one without a schedule or early (complete_service_booking
    -- logs who did it).
    SELECT sp.user_id INTO v_provider FROM public.service_providers sp WHERE sp.id = NEW.provider_id;
    IF NOT public.is_admin() OR auth.uid() IS NOT DISTINCT FROM v_provider THEN
      IF NEW.service_start_floor_at IS NULL THEN
        RAISE EXCEPTION 'This booking has no scheduled date, so only VENTS can mark it complete';
      END IF;
      IF now() < GREATEST(NEW.service_start_floor_at, v_start) THEN
        RAISE EXCEPTION 'A booking cannot be marked complete before its scheduled time (%)',
          to_char(GREATEST(NEW.service_start_floor_at, v_start) AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD HH24:MI') || ' Lagos';
      END IF;
    END IF;
  END IF;

  -- A completed booking never goes back to 'confirmed' (the live refund
  -- revert/fail paths set that); it could otherwise be completed again.
  IF TG_OP = 'UPDATE' AND OLD.completed_at IS NOT NULL AND NEW.status = 'confirmed' THEN
    NEW.status := 'completed';
  END IF;

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

-- Customer disputes of a completed booking, opened inside the dispute window
-- (the same 48 hours the provider's earnings are held) and decided by two
-- admins (request_admin_action 'resolve_booking_dispute').
CREATE TABLE IF NOT EXISTS public.service_booking_disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES public.service_bookings(id) ON DELETE RESTRICT,
  customer_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason       text NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 2000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_for_provider', 'resolved_for_customer')),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  admin_request_id uuid REFERENCES public.admin_action_requests(id) ON DELETE RESTRICT,
  resolution_note text,
  CONSTRAINT service_booking_disputes_resolved CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS service_booking_disputes_one_per_booking ON public.service_booking_disputes (booking_id);
ALTER TABLE public.service_booking_disputes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_booking_disputes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.service_booking_disputes TO authenticated;
DROP POLICY IF EXISTS service_booking_disputes_parties_read ON public.service_booking_disputes;
CREATE POLICY service_booking_disputes_parties_read ON public.service_booking_disputes
  FOR SELECT TO authenticated USING (
    customer_id = (SELECT auth.uid()) OR public.is_admin()
    OR EXISTS (SELECT 1 FROM public.service_bookings b JOIN public.service_providers sp ON sp.id = b.provider_id
                WHERE b.id = booking_id AND sp.user_id = (SELECT auth.uid())));

CREATE OR REPLACE FUNCTION public.booking_dispute_window()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT interval '48 hours';
$function$;

-- The customer disputes a completed booking. Serialized with settlement on
-- the provider's wallet row, so a dispute inside the window always beats
-- the release, and a release after the window is never undone by one.
CREATE OR REPLACE FUNCTION public.dispute_service_booking(p_booking_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  b record;
  v_id uuid;
  v_until timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN RAISE EXCEPTION 'Please describe the problem'; END IF;
  PERFORM public.check_rate_limit('booking_dispute:' || auth.uid()::text, 10, 3600);
  SELECT sb.id, sb.customer_id, sb.status, sb.completed_at, sb.service_start_floor_at, sp.user_id AS provider_user_id
    INTO b FROM public.service_bookings sb JOIN public.service_providers sp ON sp.id = sb.provider_id
   WHERE sb.id = p_booking_id;
  IF NOT FOUND OR b.customer_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Only the customer can dispute this booking'; END IF;
  IF b.status <> 'completed' OR b.completed_at IS NULL THEN RAISE EXCEPTION 'Only a completed booking can be disputed'; END IF;
  PERFORM 1 FROM public.organizer_wallets w WHERE w.organizer_id = b.provider_user_id FOR UPDATE;
  v_until := GREATEST(b.completed_at, b.service_start_floor_at) + public.booking_dispute_window();
  IF now() >= v_until THEN RAISE EXCEPTION 'The dispute window for this booking has closed'; END IF;
  INSERT INTO public.service_booking_disputes (booking_id, customer_id, reason)
  VALUES (b.id, auth.uid(), trim(p_reason))
  ON CONFLICT (booking_id) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'This booking has already been disputed'; END IF;
  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (b.provider_user_id, 'booking', 'Booking disputed',
          'The customer disputed a completed booking. Its earnings stay on hold until VENTS reviews it.');
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'service_booking_disputed', b.provider_user_id,
          jsonb_build_object('booking_id', b.id, 'dispute_id', v_id, 'reason', trim(p_reason)), public.actor_role());
  RETURN jsonb_build_object('dispute_id', v_id, 'status', 'open');
END;
$function$;

-- Dual-control executor (approve_admin_action): payload {dispute_id,
-- outcome: 'provider' | 'customer', note}. 'provider' lets the earnings
-- release. 'customer' keeps them held and makes the booking refundable:
-- cancel_service_booking (patched below) then accepts this one completed
-- booking, through the existing refund path -- a VENTS Wallet booking is
-- refunded at once, a Paystack booking through api/wallet/refund-ticket and
-- the refund webhooks. The customer gets the total paid back; the provider
-- gives back the subtotal (from the held earnings, then the balance, then a
-- recovery), exactly as for any booking refund.
CREATE OR REPLACE FUNCTION public.execute_booking_dispute_resolution(p_admin_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
  d public.service_booking_disputes;
  v_provider uuid;
  v_outcome text;
BEGIN
  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_admin_request_id;
  IF NOT FOUND OR r.action_type <> 'resolve_booking_dispute' THEN RAISE EXCEPTION 'Not a booking dispute resolution'; END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF r.requested_by = auth.uid() THEN RAISE EXCEPTION 'Cannot approve your own request'; END IF;
  v_outcome := r.payload->>'outcome';
  IF jsonb_typeof(r.payload->'outcome') IS DISTINCT FROM 'string' OR v_outcome NOT IN ('provider', 'customer') THEN
    RAISE EXCEPTION 'payload.outcome must be "provider" or "customer"';
  END IF;
  IF jsonb_typeof(r.payload->'note') IS DISTINCT FROM 'string' OR length(trim(r.payload->>'note')) = 0 THEN
    RAISE EXCEPTION 'payload.note (the reason for the decision) is required';
  END IF;
  SELECT * INTO d FROM public.service_booking_disputes
   WHERE id = NULLIF(r.payload->>'dispute_id', '')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispute not found'; END IF;
  IF d.status <> 'open' THEN RAISE EXCEPTION 'Dispute already %', d.status; END IF;
  SELECT sp.user_id INTO v_provider FROM public.service_bookings b JOIN public.service_providers sp ON sp.id = b.provider_id WHERE b.id = d.booking_id;
  IF r.requested_by IN (v_provider, d.customer_id) OR auth.uid() IN (v_provider, d.customer_id) THEN
    RAISE EXCEPTION 'A party to the booking cannot request or approve its dispute resolution';
  END IF;
  UPDATE public.service_booking_disputes
     SET status = CASE v_outcome WHEN 'provider' THEN 'resolved_for_provider' ELSE 'resolved_for_customer' END,
         resolved_at = now(), admin_request_id = r.id, resolution_note = trim(r.payload->>'note')
   WHERE id = d.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'service_booking_dispute_resolved', v_provider,
          jsonb_build_object('dispute_id', d.id, 'booking_id', d.booking_id, 'outcome', v_outcome,
                             'requested_by', r.requested_by, 'note', trim(r.payload->>'note')),
          public.actor_role());
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
    IF v_end IS NULL THEN v_blockers := array_append(v_blockers, 'event_end_unknown'); END IF;
    IF e.deleted_at IS NOT NULL THEN v_blockers := array_append(v_blockers, 'event_deleted'); END IF;
    IF e.hidden THEN v_blockers := array_append(v_blockers, 'event_hidden_by_admin'); END IF;
    -- A refund in progress holds only the order it belongs to (the hold's
    -- source_key is that order's payment_ref). A refund that cannot be tied
    -- to an order (no payment_ref) holds the whole event, conservatively.
    IF EXISTS (SELECT 1 FROM public.tickets t WHERE t.payment_ref = h.source_key AND t.payment_status = 'refund_pending') THEN
      v_blockers := array_append(v_blockers, 'refund_pending');
    END IF;
    IF EXISTS (SELECT 1 FROM public.tickets t WHERE t.event_id = h.event_id AND t.payment_ref IS NULL
                AND t.payment_status = 'refund_pending') THEN
      v_blockers := array_append(v_blockers, 'refund_pending_unlinked');
    END IF;
    IF v_release IS NOT NULL AND now() < v_release THEN v_blockers := array_append(v_blockers, 'not_yet'); END IF;
    RETURN jsonb_build_object('rule', 'event_end_plus_48h', 'event_end_at', v_end, 'event_end_at_sale', h.event_end_at_sale,
                              'release_at', v_release, 'checked_at', now(), 'blockers', to_jsonb(v_blockers));
  END IF;

  SELECT sb.status, sb.payment_status, sb.completed_at, sb.service_start_floor_at INTO b
    FROM public.service_bookings sb WHERE sb.id = h.booking_id;
  -- 48 hours after the later of completion and the scheduled start, so
  -- neither an early completion nor a date change moves the clock earlier.
  v_release := GREATEST(b.completed_at, b.service_start_floor_at) + public.earnings_release_delay();
  IF b.status = 'cancelled' THEN v_blockers := array_append(v_blockers, 'booking_cancelled'); END IF;
  IF b.payment_status IN ('refund_pending', 'refunded') THEN v_blockers := array_append(v_blockers, 'refund_pending'); END IF;
  IF EXISTS (SELECT 1 FROM public.service_booking_disputes d WHERE d.booking_id = h.booking_id AND d.status = 'open') THEN
    v_blockers := array_append(v_blockers, 'customer_dispute');
  ELSIF EXISTS (SELECT 1 FROM public.service_booking_disputes d WHERE d.booking_id = h.booking_id AND d.status = 'resolved_for_customer') THEN
    v_blockers := array_append(v_blockers, 'dispute_upheld');
  END IF;
  IF b.status IS DISTINCT FROM 'completed' OR b.completed_at IS NULL THEN
    v_blockers := array_append(v_blockers, 'not_completed');
  ELSIF now() < v_release THEN
    v_blockers := array_append(v_blockers, 'not_yet');
  END IF;
  RETURN jsonb_build_object('rule', 'booking_completed_plus_48h', 'completed_at', b.completed_at,
                            'service_start_floor_at', b.service_start_floor_at,
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
         dispute_reference = CASE WHEN p_hold THEN dispute_reference END,
         admin_hold_report_id = CASE WHEN p_hold THEN admin_hold_report_id END
   WHERE id = h.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), CASE WHEN p_hold THEN 'earnings_hold_placed' ELSE 'earnings_hold_lifted' END, h.owner_id,
          jsonb_build_object('hold_id', h.id, 'source_kind', h.source_kind, 'source_key', h.source_key,
                             'amount_kobo', h.amount_kobo, 'reason', trim(p_reason),
                             'previous_hold_reason', h.admin_hold_reason, 'dispute_reference', h.dispute_reference,
                             'report_id', h.admin_hold_report_id),
          public.actor_role());
  RETURN jsonb_build_object('hold_id', h.id, 'admin_hold', p_hold);
END;
$function$;

-- An admin reviewing a user report holds the earnings it concerns: every
-- unreleased sale of the reported event, or every unreleased hold of the
-- reported user. Reports never do this by themselves. Each hold names the
-- report (admin_hold_report_id) and is audited; lifting is the usual
-- super-admin path (admin_set_earnings_hold).
CREATE OR REPLACE FUNCTION public.admin_hold_earnings_for_report(p_report_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  rp public.reports;
  h public.earnings_holds;
  v_count integer := 0;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  SELECT * INTO rp FROM public.reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report not found'; END IF;
  FOR h IN SELECT * FROM public.earnings_holds x
            WHERE x.released_at IS NULL AND x.admin_hold_at IS NULL
              AND ((rp.target_type = 'event' AND x.event_id = rp.target_id)
                OR (rp.target_type = 'user' AND x.owner_id = rp.target_id))
            ORDER BY x.created_at FOR UPDATE
  LOOP
    IF h.owner_id = auth.uid() THEN RAISE EXCEPTION 'An admin cannot place a hold on their own earnings'; END IF;
    UPDATE public.earnings_holds
       SET admin_hold_at = now(), admin_hold_by = auth.uid(), admin_hold_reason = trim(p_reason),
           admin_hold_report_id = rp.id
     WHERE id = h.id;
    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (auth.uid(), 'earnings_hold_placed', h.owner_id,
            jsonb_build_object('hold_id', h.id, 'report_id', rp.id, 'reason', trim(p_reason), 'amount_kobo', h.amount_kobo),
            public.actor_role());
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('report_id', rp.id, 'holds_placed', v_count);
END;
$function$;

-- Paystack charge.dispute.* (server only).
-- Paystack's dispute payload is not verified in this repository (see
-- docs/money-flow-audit.md): the caller passes every candidate reference
-- it found (data.transaction.reference, data.transaction_reference,
-- data.reference) and the first that names a held sale or booking wins.
-- create/remind freeze the held earnings (never lifted automatically);
-- resolve records Paystack's outcome on the hold for the admin who lifts it.
-- Already-released earnings are logged for admins. Idempotent per dispute.
CREATE OR REPLACE FUNCTION public.place_payment_dispute_hold(p_references text[], p_dispute_id text, p_event text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ref text;
  v_cand text;
  v_found text;
  h public.earnings_holds;
BEGIN
  IF p_event NOT IN ('charge.dispute.create', 'charge.dispute.remind', 'charge.dispute.resolve') THEN
    RAISE EXCEPTION 'Unsupported dispute event %', p_event;
  END IF;
  FOREACH v_cand IN ARRAY COALESCE(p_references, ARRAY[]::text[]) LOOP
    CONTINUE WHEN v_cand IS NULL OR v_cand = '';
    v_ref := NULL;
    SELECT x.payment_ref INTO v_ref FROM public.get_pending_purchase_owner(v_cand) x;
    SELECT * INTO h FROM public.earnings_holds
     WHERE (source_kind = 'ticket_sale' AND source_key = COALESCE(v_ref, v_cand))
        OR (source_kind = 'service_booking' AND booking_id = (SELECT sb.id FROM public.service_bookings sb WHERE sb.payment_ref = v_cand LIMIT 1))
     LIMIT 1;
    IF FOUND THEN v_found := v_cand; EXIT; END IF;
  END LOOP;
  IF v_found IS NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (NULL, 'payment_dispute_unmatched', NULL,
            jsonb_build_object('references', to_jsonb(p_references), 'dispute_id', p_dispute_id, 'event', p_event), 'webhook');
    RETURN 'not_found';
  END IF;
  PERFORM 1 FROM public.organizer_wallets w WHERE w.organizer_id = h.owner_id FOR UPDATE;
  SELECT * INTO h FROM public.earnings_holds WHERE id = h.id FOR UPDATE;

  IF p_event = 'charge.dispute.resolve' THEN
    IF h.dispute_reference IS NOT DISTINCT FROM COALESCE(p_dispute_id, v_found) THEN
      UPDATE public.earnings_holds SET dispute_resolution = 'paystack_resolved' WHERE id = h.id;
    END IF;
    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (NULL, 'payment_dispute_resolved_by_paystack', h.owner_id,
            jsonb_build_object('hold_id', h.id, 'reference', v_found, 'dispute_id', p_dispute_id,
                               'still_held', h.released_at IS NULL AND h.admin_hold_at IS NOT NULL), 'webhook');
    RETURN 'resolution_recorded';
  END IF;

  IF h.released_at IS NOT NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (NULL, 'payment_dispute_after_release', h.owner_id,
            jsonb_build_object('hold_id', h.id, 'reference', v_found, 'dispute_id', p_dispute_id), 'webhook');
    RETURN 'already_released';
  END IF;
  IF h.admin_hold_at IS NOT NULL AND h.dispute_reference IS NOT DISTINCT FROM COALESCE(p_dispute_id, v_found) THEN
    RETURN 'already_held';
  END IF;
  UPDATE public.earnings_holds
     SET admin_hold_at = COALESCE(admin_hold_at, now()),
         admin_hold_reason = COALESCE(admin_hold_reason, 'Paystack payment dispute ' || COALESCE(p_dispute_id, '')),
         dispute_reference = COALESCE(p_dispute_id, v_found)
   WHERE id = h.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'earnings_hold_placed', h.owner_id,
          jsonb_build_object('hold_id', h.id, 'reason', 'payment_dispute', 'reference', v_found, 'dispute_id', p_dispute_id,
                             'event', p_event),
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
      E'      ELSIF r.action_type = ''resolve_booking_dispute'' THEN\n' ||
      E'        PERFORM public.execute_booking_dispute_resolution(r.id);\n' ||
      E'      ELSIF r.action_type LIKE ''earn\\_%'' THEN\n');
  END IF;

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position('authorize_withdrawal' IN v_def) = 0 THEN
    v_anchor := E'''earn_decide_expense'', ''earn_update_settings''';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'request_admin_action anchor found % times (expected 1; is 0201 applied?)', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor, v_anchor || E',\n    ''authorize_withdrawal'', ''resolve_booking_dispute''');
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
    -- The authorized recipient, on an account the organizer still has active.
    SELECT b.recipient_code INTO v_recipient FROM public.organizer_bank_accounts b
     WHERE b.id = w.bank_account_id AND b.is_active;
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
    'public.place_payment_dispute_hold(text[],text,text)',
    'public.execute_booking_dispute_resolution(uuid)',
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
    'public.admin_hold_earnings_for_report(uuid,text)',
    'public.dispute_service_booking(uuid,text)',
    'public.booking_dispute_window()',
    'public.booking_scheduled_start_at(date,time without time zone)',
    'public.settle_my_earnings()',
    'public.admin_earnings_reconciliation()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin') THEN
    GRANT EXECUTE ON FUNCTION public.release_matured_earnings(integer) TO project_admin;
    GRANT EXECUTE ON FUNCTION public.place_payment_dispute_hold(text[], text, text) TO project_admin;
  END IF;
END
$grants$;

DROP FUNCTION pg_temp.vents_0203_patch(regprocedure, text, text[]);
