-- VENTS SI Planner -- Batch C (S2-C / S5-A): the smallest real backend
-- pieces the next frame group needs. Design source of truth: "VENTS SI
-- Planner.dc.html" frames S2-C and S5-A.
--
-- add_plan_category(): the "+ Category" button in WorkspaceTeamTab has
-- been visible-but-dead since it was first built -- this makes it real.
-- Marks the new row vents_category = 'custom' so the UI can tell it apart
-- from a template-seeded category without guessing from its label. (Every
-- template-seeded category also has vents_category NULL today -- that
-- column was declared in 0156 but never actually populated for the seed
-- path -- so 'custom' is a new, deliberate sentinel, not a repurposed one;
-- fixing the seed path's own NULL is a separate, unrelated gap.)
--
-- assign_own_vendor(): S2-C's "Add" action (and the already-displayed-but-
-- never-reachable "own vendor" assignment state) needs a real writer --
-- there was none; assign_plan_provider (0157) only ever accepts a real
-- service_providers row. Mirrors its exact replace/protect invariants
-- (cancel any existing shortlisted/assigned row, refuse if already paid)
-- so the two paths never diverge.
--
-- remove_plan_assignment(): S5-A. A transactional remove, not several
-- independent frontend writes -- cancels the assignment and reopens only
-- the tasks the schema can actually attribute to it. plan_tasks has no
-- assignment_id column (confirmed against the live schema, not assumed),
-- only category_id + completes_on_booking; completes_on_booking is
-- reserved for tasks a REAL booking auto-completes (0158's trigger), which
-- by construction never applies to a plan-only (unpaid) assignment -- so
-- this reopens the same category-scoped completes_on_booking rows 0158's
-- own cancellation trigger reopens, and nothing else. It never touches a
-- manually-completed task (source='user', completes_on_booking=false),
-- matching the explicit "never blindly reopen the whole category" rule.
-- A 'booked' (paid) assignment is refused outright -- that is S5-B's
-- booking-flow territory, not this function's.

CREATE OR REPLACE FUNCTION public.add_plan_category(
  p_plan_id uuid,
  p_label text
)
RETURNS public.plan_categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_owner_id uuid;
  v_label text;
  v_base_key text;
  v_key text;
  v_suffix int := 1;
  v_sort int;
  v_row public.plan_categories;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_label := btrim(p_label);
  IF v_label = '' OR v_label IS NULL THEN
    RAISE EXCEPTION 'A category name is required';
  END IF;

  SELECT owner_id INTO v_owner_id FROM public.plans WHERE id = p_plan_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Plan not found';
  END IF;
  IF v_owner_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only the plan owner can add a category';
  END IF;

  -- Same slug shape as the event-type template keys (lowercase,
  -- underscored) -- plan_categories_plan_key_unique is per-plan, so a
  -- collision only needs a numeric suffix, never a failure.
  v_base_key := lower(regexp_replace(v_label, '[^a-zA-Z0-9]+', '_', 'g'));
  v_base_key := btrim(v_base_key, '_');
  IF v_base_key = '' THEN
    v_base_key := 'category';
  END IF;
  v_key := v_base_key;
  WHILE EXISTS (SELECT 1 FROM public.plan_categories WHERE plan_id = p_plan_id AND key = v_key) LOOP
    v_suffix := v_suffix + 1;
    v_key := v_base_key || '_' || v_suffix;
  END LOOP;

  SELECT coalesce(MAX(sort), -1) + 1 INTO v_sort FROM public.plan_categories WHERE plan_id = p_plan_id;

  INSERT INTO public.plan_categories (plan_id, key, label, vents_category, allocated_kobo, sort)
  VALUES (p_plan_id, v_key, v_label, 'custom', 0, v_sort)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_plan_category(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_plan_category(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.assign_own_vendor(
  p_category_id uuid,
  p_vendor_name text,
  p_vendor_phone text DEFAULT NULL,
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
  v_has_booked boolean;
  v_name text;
  v_row public.plan_assignments;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_agreed_kobo IS NOT NULL AND p_agreed_kobo < 0 THEN
    RAISE EXCEPTION 'Agreed amount must be zero or a positive amount';
  END IF;

  v_name := btrim(p_vendor_name);
  IF v_name = '' OR v_name IS NULL THEN
    RAISE EXCEPTION 'A vendor name is required';
  END IF;

  SELECT c.plan_id, p.owner_id INTO v_plan_id, v_owner_id
  FROM public.plan_categories c
  JOIN public.plans p ON p.id = c.plan_id
  WHERE c.id = p_category_id;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'Plan category not found';
  END IF;
  IF v_owner_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only the plan owner can assign a vendor';
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

  INSERT INTO public.plan_assignments (category_id, own_vendor_name, own_vendor_phone, agreed_kobo, status)
  VALUES (p_category_id, v_name, btrim(p_vendor_phone), p_agreed_kobo, 'assigned')
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_own_vendor(uuid, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_own_vendor(uuid, text, text, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_plan_assignment(
  p_assignment_id uuid
)
RETURNS public.plan_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_owner_id uuid;
  v_category_id uuid;
  v_status text;
  v_row public.plan_assignments;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT a.category_id, a.status, p.owner_id
    INTO v_category_id, v_status, v_owner_id
  FROM public.plan_assignments a
  JOIN public.plan_categories c ON c.id = a.category_id
  JOIN public.plans p ON p.id = c.plan_id
  WHERE a.id = p_assignment_id;

  IF v_category_id IS NULL THEN
    RAISE EXCEPTION 'Assignment not found';
  END IF;
  IF v_owner_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only the plan owner can remove this assignment';
  END IF;
  IF v_status = 'booked' THEN
    RAISE EXCEPTION 'This provider is booked and paid -- removing it here would not cancel or refund the booking. Use the booking itself.';
  END IF;

  -- Idempotent: a second call on an already-cancelled assignment is a
  -- harmless no-op, never an error -- and never reopens tasks twice.
  IF v_status = 'cancelled' THEN
    SELECT * INTO v_row FROM public.plan_assignments WHERE id = p_assignment_id;
    RETURN v_row;
  END IF;

  UPDATE public.plan_assignments
    SET status = 'cancelled', updated_at = now()
    WHERE id = p_assignment_id
    RETURNING * INTO v_row;

  -- Same category-scoped, completes_on_booking-only reopen as 0158's real-
  -- booking-cancel trigger -- the only task/assignment relationship this
  -- schema actually has. Never touches a manually-completed task.
  UPDATE public.plan_tasks
    SET done_at = NULL, updated_at = now()
    WHERE category_id = v_category_id
      AND completes_on_booking = true
      AND done_at IS NOT NULL;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.remove_plan_assignment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_plan_assignment(uuid) TO authenticated;
