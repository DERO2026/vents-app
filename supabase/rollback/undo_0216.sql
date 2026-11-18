-- Undo 0216 only (supabase/migrations/0216_representative_rewards_free_events_never_qualify.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0216';
--   \i supabase/rollback/undo_0216.sql
-- Restores the pre-0216 text of earn_execute_admin_action,
-- claim_representative_reward, representative_qualifying_count (0201) and
-- earn_event_eligibility (0209), and the old CHECK in its validated state.
-- 0209's narrower 'free_event' reason stays, so a free event with no
-- tickets still cannot be submitted or approved after this undo. Run it
-- BEFORE undo_0209 (it restores the text undo_0209 expects). Changes no claim, wallet or ledger row.
DO $undo$
DECLARE
  v_def text;
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0216' THEN
    RAISE EXCEPTION 'undo_0216 refused: set vents.rollback_confirm = ''undo-0216'' to confirm';
  END IF;

  v_def := pg_get_functiondef('public.earn_execute_admin_action(uuid)'::regprocedure);
  IF position('[0216]' IN v_def) > 0 THEN
    v_def := replace(v_def, $a$  -- [0216] free events never qualify: the old free-event override is refused
  IF r.action_type = 'earn_approve_reward' AND r.payload ? 'free_event_verified'
     AND r.payload->'free_event_verified' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'Free events never qualify for a representative reward; payload.free_event_verified is no longer accepted';
  END IF;$a$, $a$  IF r.action_type = 'earn_approve_reward' AND r.payload ? 'free_event_verified'
     AND jsonb_typeof(r.payload->'free_event_verified') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'payload.free_event_verified must be true or false';
  END IF;$a$);
    v_def := replace(v_def, $a$    -- [0216] free events never qualify (fails closed if the flag is missing)
    IF COALESCE((v_elig->>'is_free_event')::boolean, true) THEN
      RAISE EXCEPTION 'Free events never qualify for a representative reward';
    END IF;$a$, $a$    IF (v_elig->>'is_free_event')::boolean AND COALESCE((r.payload->>'free_event_verified')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'A free event must be explicitly verified as genuine (payload.free_event_verified = true)';
    END IF;$a$);
    v_def := replace(v_def, $a$           free_event_verified = false,  -- [0216]$a$,
      $a$           free_event_verified = COALESCE((r.payload->>'free_event_verified')::boolean, false),$a$);
    IF position('[0216]' IN v_def) > 0 THEN
      RAISE EXCEPTION 'undo_0216: earn_execute_admin_action has unexpected [0216] text; refusing';
    END IF;
    EXECUTE v_def;
  END IF;

  v_def := pg_get_functiondef('public.claim_representative_reward(uuid,uuid)'::regprocedure);
  IF position('[0216]' IN v_def) > 0 THEN
    v_def := replace(v_def, $a$  v_tx uuid;
  v_elig jsonb;  -- [0216]
BEGIN$a$, $a$  v_tx uuid;
BEGIN$a$);
    v_def := replace(v_def, $a$

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
  END IF;$a$, '');
    IF position('[0216]' IN v_def) > 0 THEN
      RAISE EXCEPTION 'undo_0216: claim_representative_reward has unexpected [0216] text; refusing';
    END IF;
    EXECUTE v_def;
  END IF;

  -- Eligibility back to 0209's free-event test.
  v_def := pg_get_functiondef('public.earn_event_eligibility(uuid)'::regprocedure);
  IF position('[0216]' IN v_def) > 0 THEN
    v_def := replace(v_def, $a$  v_candidate bigint;
  v_valid_paid integer;  -- [0216]
BEGIN$a$, $a$  v_candidate bigint;
BEGIN$a$);
    v_def := replace(v_def, $a$  -- [0216] Tickets genuinely paid for and still paid: payment_status 'paid'
  -- with an effective price (amount less promo discount, the basis every
  -- charge and refund is priced on) above zero. Free RSVPs and 100%-promo
  -- tickets are stored as 'paid' at N0 and do not count; neither do
  -- refunded, failed or pending tickets.
  SELECT count(*) INTO v_valid_paid FROM public.tickets
   WHERE event_id = p_event_id AND payment_status = 'paid'
     AND COALESCE(amount, 0) * (1 - COALESCE(discount_percentage, 0) / 100) > 0;
$a$, '');
    v_def := replace(v_def, $a$  IF v_valid_paid = 0 THEN  -- [0216] free, 100% promo or fully refunded$a$,
      $a$  IF v_paid = 0 AND v_fees = 0 THEN$a$);
    v_def := replace(v_def, $a$    'is_free_event',        (v_valid_paid = 0),  -- [0216]
    'valid_paid_tickets',   v_valid_paid,$a$, $a$    'is_free_event',        (v_paid = 0 AND v_fees = 0),$a$);
    IF position('[0216]' IN v_def) > 0 THEN
      RAISE EXCEPTION 'undo_0216: earn_event_eligibility has unexpected [0216] text; refusing';
    END IF;
    EXECUTE v_def;
  END IF;

  v_def := pg_get_functiondef('public.representative_qualifying_count(uuid,date)'::regprocedure);
  IF position('[0216]' IN v_def) > 0 THEN
    v_def := replace(v_def, $a$     AND status IN ('approved', 'funded', 'credited')
     -- [0216] free-event claims never count as qualifying organizers
     AND NOT is_free_event AND NOT free_event_verified;$a$, $a$     AND status IN ('approved', 'funded', 'credited');$a$);
    IF position('[0216]' IN v_def) > 0 THEN
      RAISE EXCEPTION 'undo_0216: representative_qualifying_count has unexpected [0216] text; refusing';
    END IF;
    EXECUTE v_def;
  END IF;
END
$undo$;

ALTER TABLE public.representative_reward_claims
  DROP CONSTRAINT IF EXISTS representative_reward_claims_free_never_qualifies;
ALTER TABLE public.representative_reward_claims
  DROP CONSTRAINT IF EXISTS representative_reward_claims_free_needs_verification;
ALTER TABLE public.representative_reward_claims
  ADD CONSTRAINT representative_reward_claims_free_needs_verification CHECK (
    status NOT IN ('approved', 'funded', 'credited') OR NOT is_free_event OR free_event_verified) NOT VALID;
-- 0201 created this constraint validated. Every row satisfies it: rows from
-- before 0216 were checked by it, and rows written under 0216 met the stricter
-- free_never_qualifies rule. VALIDATE reads rows and changes none.
ALTER TABLE public.representative_reward_claims
  VALIDATE CONSTRAINT representative_reward_claims_free_needs_verification;
