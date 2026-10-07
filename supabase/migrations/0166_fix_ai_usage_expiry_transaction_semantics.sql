-- VENTS Phase 4A -- fix misleading transaction-semantics claims in
-- check_and_reserve_ai_usage() (0165_ai_subscription_foundation.sql).
--
-- Finding (from live Phase 4 verification against the testerboy test
-- account): the function's expired-entitlement path did
--   UPDATE ai_entitlements SET status = 'expired' ...;
--   RAISE EXCEPTION 'entitlement_expired' ...;
-- in that order, inside a single function call with no exception handler.
-- Postgres rolls back EVERY effect of a call the instant it raises an
-- uncaught exception -- the UPDATE above is undone along with everything
-- else the call did, so status never actually becomes 'expired' on disk.
-- Confirmed live: after triggering this path against testerboy's test
-- entitlement, status read back as the original 'active', not 'expired'.
--
-- The exact same reasoning makes the usage-ceiling path's "compensating
-- decrement" dead code: that path does
--   UPDATE ai_usage_periods SET used_units = used_units - 1 ...;
--   RAISE EXCEPTION 'usage_ceiling_exceeded' ...;
-- but the preceding increment (from THIS SAME call) is itself inside the
-- same transaction and gets rolled back by the RAISE too -- the decrement
-- is undoing an increment that was already about to vanish on its own.
-- Confirmed live: used_units correctly stayed at the ceiling (15) after
-- the 16th call was rejected, but that was Postgres's automatic rollback
-- doing the work, not the decrement statement.
--
-- Neither of these was ever a security or billing bug: both paths still
-- RAISE unconditionally on the bad case, so check_and_reserve_ai_usage
-- always rejected correctly on every real call this migration has ever
-- made (see 0165's own test suite and the live verification). The bug was
-- purely in what the code claimed to durably persist and in one line of
-- genuinely unreachable-in-effect cleanup logic.
--
-- Fix: remove both writes-before-raise outright, and keep enforcement
-- based directly on period_end on every call rather than on a cached
-- status column -- that was already the real enforcement mechanism (an
-- expired row with a stale 'active' status was ALWAYS still rejected,
-- precisely because the period_end check runs every time regardless of
-- what status currently says). No autonomous transaction, trigger, or
-- background job is introduced to make 'expired' durable -- that would be
-- new infrastructure to persist a value nothing actually depends on for
-- correctness, which the brief explicitly ruled out.
--
-- The one write in this function that DOES genuinely persist is the grace
-- transition (status := 'grace') -- that path never raises afterward in
-- the same call (it falls through to the usage reservation and a normal
-- return), so its effects commit normally. Left unchanged.
--
-- Atomic locking/increment behavior (FOR UPDATE on the entitlement row,
-- the single INSERT ... ON CONFLICT ... RETURNING upsert on the usage
-- row) is completely unchanged -- concurrency protection is not touched by
-- this migration.
CREATE OR REPLACE FUNCTION public.check_and_reserve_ai_usage(p_user_id uuid, p_surface text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ent          public.ai_entitlements;
  v_plan         public.ai_plans;
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_used         integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_surface NOT IN ('chat', 'extraction', 'vision') THEN
    RAISE EXCEPTION 'invalid p_surface: %', p_surface;
  END IF;

  -- Row lock: a second concurrent call for the same user blocks here until
  -- the first call's transaction commits or rolls back, so the two never
  -- interleave their reads of the same entitlement/usage state.
  SELECT * INTO v_ent FROM public.ai_entitlements WHERE user_id = p_user_id FOR UPDATE;

  IF v_ent IS NULL THEN
    RAISE EXCEPTION 'no_entitlement' USING ERRCODE = 'P0001';
  END IF;

  IF v_ent.status NOT IN ('trialing', 'active', 'grace') THEN
    RAISE EXCEPTION 'entitlement_inactive' USING ERRCODE = 'P0001';
  END IF;

  -- Period check, re-derived from period_end on EVERY call -- this is the
  -- actual, durable enforcement mechanism. A stale status value (e.g. a
  -- row that still says 'active' because nothing ever got the chance to
  -- write 'expired' back) cannot bypass this: the comparison below runs
  -- every time regardless of what `status` currently holds, so expiry is
  -- always correctly detected and rejected from period_end alone.
  --
  -- This function deliberately does NOT try to also persist status =
  -- 'expired' on this path. An earlier version did
  -- (UPDATE ... SET status = 'expired'; RAISE EXCEPTION ...), but a RAISE
  -- EXCEPTION with no enclosing exception handler rolls back every write
  -- this call made, including that UPDATE -- so the write never actually
  -- reached disk and the comment claiming it did was wrong. Persisting
  -- 'expired' durably would need a transaction that outlives this one
  -- (an autonomous transaction, a trigger, a background job) purely to
  -- update a column nothing reads for correctness -- not worth the added
  -- infrastructure. A NULL period_end (the open-ended trial) never hits
  -- this branch at all.
  IF v_ent.period_end IS NOT NULL AND v_ent.period_end < now() THEN
    IF v_ent.grace_until IS NOT NULL AND v_ent.grace_until >= now() THEN
      -- Within grace: this path does NOT raise afterward, so (unlike the
      -- expired/ceiling paths above and below) this write genuinely
      -- commits -- it falls through to a normal, successful return.
      IF v_ent.status <> 'grace' THEN
        UPDATE public.ai_entitlements SET status = 'grace', updated_at = now()
          WHERE user_id = p_user_id;
        v_ent.status := 'grace';
      END IF;
    ELSE
      RAISE EXCEPTION 'entitlement_expired' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT * INTO v_plan FROM public.ai_plans WHERE plan_id = v_ent.plan_id;
  IF v_plan IS NULL OR NOT v_plan.active THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Usage bucket key: the entitlement's OWN period, not the calendar month.
  -- The open-ended trial (period_end IS NULL) uses one single lifetime
  -- bucket per user (period_start fixed at the entitlement's own
  -- period_start, 'infinity' as the nominal end) so its total stays capped
  -- at the plan's hard_ceiling across the whole trial, not per-month.
  v_period_start := v_ent.period_start;
  v_period_end := COALESCE(v_ent.period_end, 'infinity'::timestamptz);

  INSERT INTO public.ai_usage_periods (user_id, surface, period_start, period_end, used_units, updated_at)
  VALUES (p_user_id, p_surface, v_period_start, v_period_end, 1, now())
  ON CONFLICT (user_id, surface, period_start)
  DO UPDATE SET used_units = public.ai_usage_periods.used_units + 1, updated_at = now()
  RETURNING used_units INTO v_used;

  -- No compensating decrement here. If this push past the hard ceiling,
  -- the RAISE EXCEPTION below has no enclosing exception handler, so
  -- Postgres rolls back this ENTIRE call -- including the increment this
  -- same statement just made -- automatically. A manual decrement before
  -- the raise would only be undoing an increment that was already about
  -- to be discarded by the rollback; it was dead code, not a safeguard.
  IF v_used > v_plan.hard_ceiling THEN
    RAISE EXCEPTION 'usage_ceiling_exceeded' USING ERRCODE = 'P0429';
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'plan_id', v_ent.plan_id,
    'status', v_ent.status,
    'used_units', v_used,
    'included_units', v_plan.included_units,
    'hard_ceiling', v_plan.hard_ceiling,
    'over_included', v_used > v_plan.included_units
  );
END;
$function$;

-- Grants are unchanged by this migration (still project_admin-only) --
-- CREATE OR REPLACE FUNCTION does not reset existing grants in Postgres,
-- but this is stated explicitly rather than left implicit, matching this
-- repo's own convention (see 0163's note on check_rate_limit's PERFORM
-- calls needing no additional grant).
