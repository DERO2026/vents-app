-- VENTS SI Planner -- Batch 2: SI plan intelligence + tools (backend only).
--
-- Batch 1 (0156) built the plan/category/assignment/task/milestone/message
-- tables plus the one existing budget-write path
-- (set_plan_category_allocation) and search_services_fuzzy_filtered. This
-- migration adds only what those don't already cover for the new SI tool
-- layer: a reversible-change log (the frozen design's "applied (+Undo
-- 24h)" state), a multi-category reallocation RPC that goes through
-- set_plan_category_allocation for every row rather than duplicating its
-- invariant logic, an undo RPC, and a provider-assignment RPC with correct
-- replace semantics. Every other new SI tool (create_plan_draft, get_plan,
-- propose_plan_update, recommend_providers, reschedule_plan, confirm_brief)
-- is implemented as a plain RLS-scoped read/write in api/_lib/aiTools.ts,
-- using the user's own forwarded Supabase client exactly like every
-- existing tool executor in that file -- no new SQL needed for those.

-- ── 1. Plan change log (the Undo mechanism) ──────────────────────────────
-- One row per applied, reversible planner change. `before`/`after` hold
-- enough to replay the change in either direction; `undone_at` marks a
-- change already reverted (never deleted, so the history stays honest).
-- This is a PLANNING record only -- it is never written by, or capable of
-- reversing, a real Paystack payment or booking: nothing here references
-- service_bookings, and no function in this file touches that table.
CREATE TABLE IF NOT EXISTS public.plan_change_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  change_type text NOT NULL,
  actor text NOT NULL DEFAULT 'user',
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  CONSTRAINT plan_change_log_pkey PRIMARY KEY (id),
  CONSTRAINT plan_change_log_actor_check CHECK (actor IN ('user', 'si')),
  CONSTRAINT plan_change_log_type_check CHECK (change_type IN ('category_allocation'))
);

CREATE INDEX IF NOT EXISTS idx_plan_change_log_plan_id ON public.plan_change_log (plan_id, created_at DESC);

ALTER TABLE public.plan_change_log ENABLE ROW LEVEL SECURITY;

-- Read-only for clients: history/Undo-button state is visible to the plan
-- owner, but every write to this table goes through the two SECURITY
-- DEFINER functions below -- no INSERT/UPDATE/DELETE policy exists, so a
-- client can never forge or erase its own change history directly.
CREATE POLICY plan_change_log_select_own ON public.plan_change_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));

-- ── 2. Apply a budget reallocation (one or more categories, one log row) ─
-- The actual column write for every category in p_changes still goes
-- through set_plan_category_allocation (0156) -- this function only
-- orchestrates multiple calls to it inside one transaction and records the
-- combined before/after as a single undoable change. p_actor distinguishes
-- a direct user instruction from an SI suggestion the user tapped Apply
-- on, purely for the change log's own record -- both paths enforce the
-- exact same invariants, since the budget rule in §12 doesn't differ by
-- who triggered it.
CREATE OR REPLACE FUNCTION public.apply_plan_allocation_changes(
  p_plan_id uuid,
  p_changes jsonb,
  p_actor text DEFAULT 'user'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_owner_id uuid;
  v_before jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
  v_change jsonb;
  v_category_id uuid;
  v_new_kobo bigint;
  v_old_kobo bigint;
  v_log_id uuid;
  v_count int := 0;
  v_pass int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_actor NOT IN ('user', 'si') THEN
    RAISE EXCEPTION 'Invalid actor';
  END IF;

  SELECT owner_id INTO v_owner_id FROM public.plans WHERE id = p_plan_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Plan not found';
  END IF;
  IF v_owner_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only the plan owner can change its budget';
  END IF;

  -- Two passes (decreases, then increases): applying every decrease first
  -- means a same-batch swap (money moved OUT of one category INTO another)
  -- never trips set_plan_category_allocation's over-budget check on an
  -- intermediate state, even though the net result keeps the plan within
  -- budget throughout. Applying in plain array order would let a
  -- perfectly valid swap fail just because the increase happened to be
  -- listed before its matching decrease (caught live against a real
  -- "move 200k from decoration to catering" test during this batch).
  FOR v_pass IN 0..1 LOOP
    FOR v_change IN SELECT * FROM jsonb_array_elements(p_changes) LOOP
      v_category_id := (v_change->>'category_id')::uuid;
      v_new_kobo := (v_change->>'new_allocated_kobo')::bigint;

      -- Defends against a category id for a different plan ending up in
      -- the same batch (e.g. a client bug, or a stale id from a previous
      -- plan) -- every row in the batch must belong to THIS plan.
      SELECT allocated_kobo INTO v_old_kobo
      FROM public.plan_categories
      WHERE id = v_category_id AND plan_id = p_plan_id;

      IF v_old_kobo IS NULL THEN
        RAISE EXCEPTION 'Category % does not belong to this plan', v_category_id;
      END IF;

      IF (v_pass = 0 AND v_new_kobo <= v_old_kobo) OR (v_pass = 1 AND v_new_kobo > v_old_kobo) THEN
        PERFORM public.set_plan_category_allocation(v_category_id, v_new_kobo);
        v_before := v_before || jsonb_build_array(jsonb_build_object('category_id', v_category_id, 'allocated_kobo', v_old_kobo));
        v_after := v_after || jsonb_build_array(jsonb_build_object('category_id', v_category_id, 'allocated_kobo', v_new_kobo));
        v_count := v_count + 1;
      END IF;
    END LOOP;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No changes given';
  END IF;

  INSERT INTO public.plan_change_log (plan_id, change_type, actor, before, after)
  VALUES (p_plan_id, 'category_allocation', p_actor, v_before, v_after)
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_plan_allocation_changes(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_plan_allocation_changes(uuid, jsonb, text) TO authenticated;

-- ── 3. Undo a logged change ──────────────────────────────────────────────
-- Reverts every category in the log row back to its `before` value via
-- set_plan_category_allocation (so the same invariants apply to an undo as
-- to any other allocation write -- a revert that would now put the plan
-- over budget, because something else changed in the meantime, correctly
-- fails rather than silently corrupting the budget). Only the plan owner,
-- only once per log row, only within 24h of the original change, matching
-- the design's own "applied (+Undo 24h)" state.
CREATE OR REPLACE FUNCTION public.undo_plan_change(p_change_log_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_plan_id uuid;
  v_owner_id uuid;
  v_change_type text;
  v_before jsonb;
  v_created_at timestamptz;
  v_undone_at timestamptz;
  v_item jsonb;
  v_category_id uuid;
  v_target_kobo bigint;
  v_current_kobo bigint;
  v_pass int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT l.plan_id, p.owner_id, l.change_type, l.before, l.created_at, l.undone_at
    INTO v_plan_id, v_owner_id, v_change_type, v_before, v_created_at, v_undone_at
  FROM public.plan_change_log l
  JOIN public.plans p ON p.id = l.plan_id
  WHERE l.id = p_change_log_id;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'Change not found';
  END IF;
  IF v_owner_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only the plan owner can undo this change';
  END IF;
  IF v_undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'This change was already undone';
  END IF;
  IF now() - v_created_at > interval '24 hours' THEN
    RAISE EXCEPTION 'This change is too old to undo (the 24-hour window has passed)';
  END IF;

  IF v_change_type = 'category_allocation' THEN
    -- Same decreases-first ordering as apply_plan_allocation_changes, but
    -- computed fresh against the CURRENT allocated_kobo at undo time (not
    -- the stored array order) -- a revert is itself just another
    -- allocation change and gets the exact same mid-transaction-budget
    -- protection.
    FOR v_pass IN 0..1 LOOP
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_before) LOOP
        v_category_id := (v_item->>'category_id')::uuid;
        v_target_kobo := (v_item->>'allocated_kobo')::bigint;

        SELECT allocated_kobo INTO v_current_kobo FROM public.plan_categories WHERE id = v_category_id;

        IF (v_pass = 0 AND v_target_kobo <= v_current_kobo) OR (v_pass = 1 AND v_target_kobo > v_current_kobo) THEN
          PERFORM public.set_plan_category_allocation(v_category_id, v_target_kobo);
        END IF;
      END LOOP;
    END LOOP;
  ELSE
    RAISE EXCEPTION 'Unknown change type';
  END IF;

  UPDATE public.plan_change_log SET undone_at = now() WHERE id = p_change_log_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.undo_plan_change(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.undo_plan_change(uuid) TO authenticated;

-- ── 4. Assign a real VENTS provider to a plan category ───────────────────
-- Assigned is deliberately NOT booked: this never creates a service_
-- bookings row, never touches payment_status, and never claims
-- availability -- it only records which provider the user picked for a
-- category, at an agreed (not charged) amount. "Replace" cancels any
-- existing shortlisted/assigned row for the category and inserts the new
-- one, matching §S5's "removing or replacing a provider" -- but a category
-- that already has a PAID (`booked`) assignment is refused outright: this
-- tool must never silently cancel a real paid booking's assignment record.
-- That remove/replace-with-refund-safety flow is explicitly out of scope
-- for this batch (see Batch 2 instructions §11 and §17).
CREATE OR REPLACE FUNCTION public.assign_plan_provider(
  p_category_id uuid,
  p_provider_id uuid,
  p_agreed_kobo bigint DEFAULT NULL
)
RETURNS public.plan_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_plan_id uuid;
  v_owner_id uuid;
  v_provider_status text;
  v_has_booked boolean;
  v_row public.plan_assignments;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_agreed_kobo IS NOT NULL AND p_agreed_kobo < 0 THEN
    RAISE EXCEPTION 'Agreed amount must be zero or a positive amount';
  END IF;

  SELECT c.plan_id, p.owner_id INTO v_plan_id, v_owner_id
  FROM public.plan_categories c
  JOIN public.plans p ON p.id = c.plan_id
  WHERE c.id = p_category_id;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'Plan category not found';
  END IF;
  IF v_owner_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only the plan owner can assign a provider';
  END IF;

  SELECT status INTO v_provider_status FROM public.service_providers WHERE id = p_provider_id;
  IF v_provider_status IS NULL THEN
    RAISE EXCEPTION 'Provider not found';
  END IF;
  IF v_provider_status <> 'approved' THEN
    RAISE EXCEPTION 'Provider is not an approved VENTS listing';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.plan_assignments a WHERE a.category_id = p_category_id AND a.status = 'booked'
  ) INTO v_has_booked;
  IF v_has_booked THEN
    RAISE EXCEPTION 'This category already has a paid booking -- it can''t be replaced from here';
  END IF;

  UPDATE public.plan_assignments
    SET status = 'cancelled', updated_at = now()
    WHERE category_id = p_category_id AND status IN ('shortlisted', 'assigned');

  INSERT INTO public.plan_assignments (category_id, provider_id, agreed_kobo, status)
  VALUES (p_category_id, p_provider_id, p_agreed_kobo, 'assigned')
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_plan_provider(uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_plan_provider(uuid, uuid, bigint) TO authenticated;

-- ── 5. Table-level grants for Batch 1's tables (gap fix) ─────────────────
-- Batch 1 (0156) enabled RLS and added policies on all six tables, but
-- never actually GRANTed table-level SELECT/INSERT/UPDATE/DELETE to the
-- authenticated role -- Supabase's default per-schema grant only covers
-- REFERENCES/TRIGGER/TRUNCATE for a newly created table, not the DML
-- privileges RLS policies are meant to filter. Without this, every policy
-- in 0156 was correctly defined but completely unreachable: a real
-- `authenticated`-role client got a flat "permission denied for table
-- plans" before RLS ever got a chance to evaluate. Caught live in this
-- batch by testing against role authenticated (not the default superuser
-- connection), not just by reading the policy SQL. No anon grants here --
-- planning is authenticated-only, by design, never anonymous.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_assignments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_milestones TO authenticated;
-- plan_messages is append-only from the client (no UPDATE/DELETE policy
-- exists for it either), so only SELECT/INSERT are granted.
GRANT SELECT, INSERT ON public.plan_messages TO authenticated;
-- plan_change_log has no client-writable policy at all -- SELECT only.
GRANT SELECT ON public.plan_change_log TO authenticated;
