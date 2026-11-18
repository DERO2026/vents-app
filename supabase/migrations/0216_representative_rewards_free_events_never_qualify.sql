-- 0216: VENTS Representative rewards -- free events never qualify (server
-- side, every path), and a reward is credited only for a qualifying event.
--
-- Approved rule (owner correction 2026-11-09, MONETIZATION_IMPLEMENTATION_
-- MASTER_CHECKLIST.md section 10): a fixed N50,000 per qualifying organizer;
-- the organizer and the event verified and approved by two distinct admins;
-- the event not cancelled; FREE EVENTS NEVER QUALIFY; no duplicate reward;
-- credited to the withdrawable earnings wallet.
--
-- What was still wrong after 0209:
--   0209 made earn_event_eligibility() return reason 'free_event', so a free
--   event can no longer be submitted or approved. But 0201's obsolete
--   "admin-verified free event" override was still in the code:
--     * earn_execute_admin_action accepted payload.free_event_verified = true
--       and would approve a free event if eligibility ever stopped flagging
--       it (the only thing standing between the override and a payout was a
--       text patch to another function);
--     * claim_representative_reward never looked at the event again, so a
--       free-event claim approved before 0209 could still be funded and
--       credited, and so could a claim whose event was cancelled (taken off
--       'live'), deleted or hidden by an admin after approval;
--     * the table CHECK representative_reward_claims_free_needs_verification
--       still allowed an approved/funded/credited free-event claim.
--
-- This migration, and nothing else:
--   1. earn_execute_admin_action: refuses any approval request that still
--      carries free_event_verified (anything but false); refuses a free event
--      regardless of the request (fails closed if the flag is missing);
--      always records free_event_verified = false.
--   2. claim_representative_reward: before reserving or crediting, refuses a
--      claim recorded as a free event, and a claim whose event is no longer
--      found, live, undeleted and unhidden, or no longer has a genuinely paid
--      ticket (4.). These are the
--      existing eligibility reasons; no new rule or threshold. The claim
--      stays where it is ("on hold for admin review"); admins reject or
--      reverse it through the existing dual control. No money moves.
--   3. Replaces the CHECK with representative_reward_claims_free_never_
--      qualifies (NOT VALID: existing rows are reported below, not changed).
--   4. earn_event_eligibility: an event is FREE unless at least one ticket is
--      genuinely paid for and still paid -- payment_status 'paid' with an
--      effective price (amount less promo discount, the basis every charge
--      and refund is priced on) above zero. 0209's test (no 'paid' ticket and
--      no recorded fee) missed free events with attendees: purchase_ticket
--      stores a N0 RSVP and a 100%-promo ticket as payment_status 'paid'. It
--      also treated an event whose every ticket was refunded as paid. Feeds
--      is_free_event, the 'free_event' reason, submission, approval and the
--      re-check before credit (2.); adds 'valid_paid_tickets' to the output.
--   5. representative_qualifying_count (the 9+ rate review basis): free-event
--      claims never count. The 9 threshold, the dual-control rate approval
--      and the N50,000 base are unchanged.
--
-- Unchanged: the N50,000 base reward and its CHECK, the monthly-rate review,
-- attribution, one reward per organizer, dual control, the profit pool,
-- idempotent crediting into organizer_wallets, reversals, withdrawals.
--
-- Prerequisite: 0201 and 0209 (whose 'free_event' eligibility reason this
-- relies on). One transaction; idempotent (marker [0216]); refuses to patch
-- a function whose text is not the expected 0201 version.
-- Rollback: supabase/rollback/undo_0216.sql.

DO $pre$
BEGIN
  IF to_regprocedure('public.earn_execute_admin_action(uuid)') IS NULL
     OR to_regprocedure('public.claim_representative_reward(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '0216 requires 0201 (representative reward functions are missing)';
  END IF;
  IF position('[0209]' IN pg_get_functiondef('public.earn_event_eligibility(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0216 requires 0209 (earn_event_eligibility does not exclude free events yet)';
  END IF;
END
$pre$;

DO $patch$
DECLARE
  v_def text;
  v_pairs text[][];
  i int;

  -- 1a. The obsolete override in the request payload.
  a1_old constant text := $a$  IF r.action_type = 'earn_approve_reward' AND r.payload ? 'free_event_verified'
     AND jsonb_typeof(r.payload->'free_event_verified') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'payload.free_event_verified must be true or false';
  END IF;$a$;
  a1_new constant text := $a$  -- [0216] free events never qualify: the old free-event override is refused
  IF r.action_type = 'earn_approve_reward' AND r.payload ? 'free_event_verified'
     AND r.payload->'free_event_verified' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'Free events never qualify for a representative reward; payload.free_event_verified is no longer accepted';
  END IF;$a$;

  -- 1b. The approval branch: a free event is refused whatever the request says.
  a2_old constant text := $a$    IF (v_elig->>'is_free_event')::boolean AND COALESCE((r.payload->>'free_event_verified')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'A free event must be explicitly verified as genuine (payload.free_event_verified = true)';
    END IF;$a$;
  a2_new constant text := $a$    -- [0216] free events never qualify (fails closed if the flag is missing)
    IF COALESCE((v_elig->>'is_free_event')::boolean, true) THEN
      RAISE EXCEPTION 'Free events never qualify for a representative reward';
    END IF;$a$;

  -- 1c. Never record a free-event verification.
  a3_old constant text := $a$           free_event_verified = COALESCE((r.payload->>'free_event_verified')::boolean, false),$a$;
  a3_new constant text := $a$           free_event_verified = false,  -- [0216]$a$;

  -- 2a. claim_representative_reward: a local for the eligibility snapshot.
  b1_old constant text := $a$  v_tx uuid;
BEGIN$a$;
  b1_new constant text := $a$  v_tx uuid;
  v_elig jsonb;  -- [0216]
BEGIN$a$;

  -- 2b. Re-check the event before any money is reserved or credited.
  b2_old constant text := $a$  IF NOT public.earn_organizer_is_verified(c.organizer_id) THEN
    RAISE EXCEPTION 'The organizer is no longer verified; this reward is on hold for admin review';
  END IF;$a$;
  b2_new constant text := $a$  IF NOT public.earn_organizer_is_verified(c.organizer_id) THEN
    RAISE EXCEPTION 'The organizer is no longer verified; this reward is on hold for admin review';
  END IF;

  -- [0216] Credited only for a qualifying event: never a free event (an
  -- approval recorded before 0209/0216), and never an event that was
  -- cancelled, deleted or hidden after approval. Existing eligibility
  -- reasons only; nothing is moved -- admins reject or reverse the claim.
  IF c.is_free_event OR c.free_event_verified THEN
    RAISE EXCEPTION 'Free events never qualify for a representative reward; this reward is on hold for admin review';
  END IF;
  v_elig := public.earn_event_eligibility(c.event_id);
  IF (v_elig->'reasons') ?| ARRAY['event_not_found', 'event_deleted', 'event_hidden_by_admin', 'event_not_live', 'free_event'] THEN
    RAISE EXCEPTION 'The qualifying event no longer qualifies (cancelled, deleted, hidden, or no paid ticket remains); this reward is on hold for admin review'
      USING DETAIL = 'eligibility reasons: ' || (v_elig->'reasons')::text;
  END IF;$a$;
BEGIN
  -- 1. earn_execute_admin_action
  v_def := pg_get_functiondef('public.earn_execute_admin_action(uuid)'::regprocedure);
  IF position('[0216]' IN v_def) = 0 THEN
    v_pairs := ARRAY[[a1_old, a1_new], [a2_old, a2_new], [a3_old, a3_new]];
    FOR i IN 1 .. array_length(v_pairs, 1) LOOP
      IF (length(v_def) - length(replace(v_def, v_pairs[i][1], ''))) / length(v_pairs[i][1]) <> 1 THEN
        RAISE EXCEPTION '0216: earn_execute_admin_action is not the expected 0201 version (anchor % not found exactly once)', i;
      END IF;
      v_def := replace(v_def, v_pairs[i][1], v_pairs[i][2]);
    END LOOP;
    EXECUTE v_def;
  END IF;

  -- 2. claim_representative_reward
  v_def := pg_get_functiondef('public.claim_representative_reward(uuid,uuid)'::regprocedure);
  IF position('[0216]' IN v_def) = 0 THEN
    v_pairs := ARRAY[[b1_old, b1_new], [b2_old, b2_new]];
    FOR i IN 1 .. array_length(v_pairs, 1) LOOP
      IF (length(v_def) - length(replace(v_def, v_pairs[i][1], ''))) / length(v_pairs[i][1]) <> 1 THEN
        RAISE EXCEPTION '0216: claim_representative_reward is not the expected 0201 version (anchor % not found exactly once)', i;
      END IF;
      v_def := replace(v_def, v_pairs[i][1], v_pairs[i][2]);
    END LOOP;
    EXECUTE v_def;
  END IF;
END
$patch$;

-- 4. Eligibility: an event is free unless a ticket is genuinely paid for and
-- still paid. 5. The 9+ rate-review count excludes free-event claims.
DO $patch2$
DECLARE
  v_def text;
  v_pairs text[][];
  i int;

  e1_old constant text := $a$  v_candidate bigint;
BEGIN$a$;
  e1_new constant text := $a$  v_candidate bigint;
  v_valid_paid integer;  -- [0216]
BEGIN$a$;
  e2_old constant text := $a$    FROM public.tickets WHERE event_id = p_event_id;
$a$;
  e2_new constant text := $a$    FROM public.tickets WHERE event_id = p_event_id;
  -- [0216] Tickets genuinely paid for and still paid: payment_status 'paid'
  -- with an effective price (amount less promo discount, the basis every
  -- charge and refund is priced on) above zero. Free RSVPs and 100%-promo
  -- tickets are stored as 'paid' at N0 and do not count; neither do
  -- refunded, failed or pending tickets.
  SELECT count(*) INTO v_valid_paid FROM public.tickets
   WHERE event_id = p_event_id AND payment_status = 'paid'
     AND COALESCE(amount, 0) * (1 - COALESCE(discount_percentage, 0) / 100) > 0;
$a$;
  e3_old constant text := $a$  IF v_paid = 0 AND v_fees = 0 THEN
    v_reasons := array_append(v_reasons, 'free_event');$a$;
  e3_new constant text := $a$  IF v_valid_paid = 0 THEN  -- [0216] free, 100% promo or fully refunded
    v_reasons := array_append(v_reasons, 'free_event');$a$;
  e4_old constant text := $a$    'is_free_event',        (v_paid = 0 AND v_fees = 0),$a$;
  e4_new constant text := $a$    'is_free_event',        (v_valid_paid = 0),  -- [0216]
    'valid_paid_tickets',   v_valid_paid,$a$;

  q1_old constant text := $a$     AND status IN ('approved', 'funded', 'credited');$a$;
  q1_new constant text := $a$     AND status IN ('approved', 'funded', 'credited')
     -- [0216] free-event claims never count toward the 9+ rate review
     AND NOT is_free_event AND NOT free_event_verified;$a$;
BEGIN
  v_def := pg_get_functiondef('public.earn_event_eligibility(uuid)'::regprocedure);
  IF position('[0216]' IN v_def) = 0 THEN
    v_pairs := ARRAY[[e1_old, e1_new], [e2_old, e2_new], [e3_old, e3_new], [e4_old, e4_new]];
    FOR i IN 1 .. array_length(v_pairs, 1) LOOP
      IF (length(v_def) - length(replace(v_def, v_pairs[i][1], ''))) / length(v_pairs[i][1]) <> 1 THEN
        RAISE EXCEPTION '0216: earn_event_eligibility is not the expected 0201/0203/0209 version (anchor % not found exactly once)', i;
      END IF;
      v_def := replace(v_def, v_pairs[i][1], v_pairs[i][2]);
    END LOOP;
    EXECUTE v_def;
  END IF;

  v_def := pg_get_functiondef('public.representative_qualifying_count(uuid,date)'::regprocedure);
  IF position('[0216]' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, q1_old, ''))) / length(q1_old) <> 1 THEN
      RAISE EXCEPTION '0216: representative_qualifying_count is not the expected 0201 version';
    END IF;
    EXECUTE replace(v_def, q1_old, q1_new);
  END IF;
END
$patch2$;

-- 3. The table rule: an approved, funded or credited claim is never a free
-- event. NOT VALID so existing rows are not rewritten or refused here; every
-- new or updated row is checked. Existing rows are reported below.
ALTER TABLE public.representative_reward_claims
  DROP CONSTRAINT IF EXISTS representative_reward_claims_free_needs_verification;
ALTER TABLE public.representative_reward_claims
  DROP CONSTRAINT IF EXISTS representative_reward_claims_free_never_qualifies;
ALTER TABLE public.representative_reward_claims
  ADD CONSTRAINT representative_reward_claims_free_never_qualifies
  CHECK (status NOT IN ('approved', 'funded', 'credited') OR NOT is_free_event) NOT VALID;

-- Report (read-only) any claim the old override let through, for the owner
-- to reject or reverse through dual control. Changes nothing.
DO $report$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.representative_reward_claims
   WHERE (is_free_event OR free_event_verified) AND status IN ('approved', 'funded', 'credited');
  IF v_n > 0 THEN
    RAISE WARNING '0216: % free-event reward claim(s) are approved, funded or credited; they can no longer be credited and need an admin rejection or reversal', v_n;
  END IF;
  -- Claims approved under 0209's narrower test whose event has no genuinely
  -- paid ticket (free with attendees, 100% promo, fully refunded).
  SELECT count(*) INTO v_n FROM public.representative_reward_claims c
   WHERE c.status IN ('approved', 'funded', 'credited') AND NOT c.is_free_event
     AND (public.earn_event_eligibility(c.event_id)->>'is_free_event')::boolean;
  IF v_n > 0 THEN
    RAISE WARNING '0216: % approved, funded or credited reward claim(s) are for an event with no genuinely paid ticket; approved/funded ones are now on hold, credited ones need an admin decision', v_n;
  END IF;
END
$report$;
