-- Undo 0216 only (supabase/migrations/0216_representative_rewards_free_events_never_qualify.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0216';
--   \i supabase/rollback/undo_0216.sql
-- Restores 0201's text of earn_execute_admin_action and
-- claim_representative_reward and the old CHECK. 0209's 'free_event'
-- eligibility reason stays, so free events still cannot be submitted or
-- approved after this undo. Changes no claim, wallet or ledger row.
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
    RAISE EXCEPTION 'The qualifying event was cancelled, deleted or hidden; this reward is on hold for admin review'
      USING DETAIL = 'eligibility reasons: ' || (v_elig->'reasons')::text;
  END IF;$a$, '');
    IF position('[0216]' IN v_def) > 0 THEN
      RAISE EXCEPTION 'undo_0216: claim_representative_reward has unexpected [0216] text; refusing';
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
