-- VENTS SI Planner -- Batch 3 (P25/P26/P27): backend pieces for the Plans
-- list, plan switcher, and free-chat plan disambiguation. Design source of
-- truth: "VENTS SI Planner.dc.html" frames P25/P26/P27.
--
-- get_plans_overview(): a single aggregate read for every one of the
-- caller's own plans (readiness %, committed-or-paid kobo, overdue task
-- count) -- avoids the N+1 of running fetchPlanWorkspace-style per-plan
-- queries for every row in the Plans list. Mirrors computeReadiness()
-- (VentsAiScreen.tsx) and the dueDate()/overdue derivation already used by
-- the Tasks/Timeline tabs exactly, so the Plans list, the plan switcher,
-- and the Workspace screen never disagree about what "47% ready" means.
--
-- duplicate_plan_as_template(): P25's "Duplicate as template" long-press
-- action. Copies ONLY plan_categories and plan_milestones (structure, no
-- money committed/paid, no provider/booking/payment data) plus a small set
-- of safe style/structure fields off plans itself. Never copies
-- plan_assignments, plan_tasks, plan_messages, or any service_bookings/
-- payment/wallet data, and never copies event_date/city/guests/total_kobo/
-- venue_note/extras, since those are specific to the ORIGINAL event, not a
-- reusable template.

CREATE OR REPLACE FUNCTION public.get_plans_overview()
RETURNS TABLE(
  id uuid,
  title text,
  event_type text,
  status text,
  event_date date,
  city text,
  guests int,
  total_kobo bigint,
  currency text,
  created_at timestamptz,
  readiness_pct int,
  committed_or_paid_kobo bigint,
  overdue_task_count int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH my_plans AS (
    SELECT p.id, p.title, p.event_type, p.status, p.event_date, p.city, p.guests,
           p.total_kobo, p.currency, p.created_at
    FROM public.plans p
    WHERE p.owner_id = auth.uid()
  ),
  cat_agg AS (
    -- Per-plan category/budget rollup, matching computeReadiness()'s
    -- teamPct (categories with a committed-or-paid assignment / total
    -- categories) and budgetPct (committed+paid / allocated) exactly.
    SELECT
      c.plan_id,
      COUNT(*) AS categories_total,
      COUNT(*) FILTER (WHERE coalesce(a.committed_or_paid, 0) > 0) AS categories_assigned,
      coalesce(SUM(c.allocated_kobo), 0) AS allocated_total,
      coalesce(SUM(a.committed_or_paid), 0) AS committed_or_paid_total
    FROM public.plan_categories c
    LEFT JOIN (
      SELECT pa.category_id, SUM(pa.agreed_kobo) AS committed_or_paid
      FROM public.plan_assignments pa
      WHERE pa.status IN ('assigned', 'booked') AND pa.agreed_kobo IS NOT NULL
      GROUP BY pa.category_id
    ) a ON a.category_id = c.id
    GROUP BY c.plan_id
  ),
  task_agg AS (
    -- Same due-date derivation as the client's dueDate() helper:
    -- due_override wins outright; otherwise event_date - offset_days.
    -- A task with neither has no due date and can never be overdue.
    SELECT
      t.plan_id,
      COUNT(*) AS tasks_total,
      COUNT(*) FILTER (WHERE t.done_at IS NOT NULL) AS tasks_done,
      COUNT(*) FILTER (
        WHERE t.done_at IS NULL
          AND (
            (t.due_override IS NOT NULL AND t.due_override < CURRENT_DATE)
            OR (t.due_override IS NULL AND t.offset_days IS NOT NULL AND p2.event_date IS NOT NULL
                AND (p2.event_date - t.offset_days) < CURRENT_DATE)
          )
      ) AS overdue_count
    FROM public.plan_tasks t
    JOIN public.plans p2 ON p2.id = t.plan_id
    GROUP BY t.plan_id
  )
  SELECT
    mp.id, mp.title, mp.event_type, mp.status, mp.event_date, mp.city, mp.guests,
    mp.total_kobo, mp.currency, mp.created_at,
    ROUND((
      (coalesce(ta.tasks_done, 0)::numeric / GREATEST(coalesce(ta.tasks_total, 0), 1)) * 0.5
      + (coalesce(ca.categories_assigned, 0)::numeric / GREATEST(coalesce(ca.categories_total, 0), 1)) * 0.35
      + LEAST(1, coalesce(ca.committed_or_paid_total, 0)::numeric / GREATEST(coalesce(ca.allocated_total, 0), 1)) * 0.15
    ) * 100)::int AS readiness_pct,
    coalesce(ca.committed_or_paid_total, 0) AS committed_or_paid_kobo,
    coalesce(ta.overdue_count, 0)::int AS overdue_task_count
  FROM my_plans mp
  LEFT JOIN cat_agg ca ON ca.plan_id = mp.id
  LEFT JOIN task_agg ta ON ta.plan_id = mp.id
  ORDER BY (mp.event_date IS NULL), mp.event_date, mp.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_plans_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_plans_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.duplicate_plan_as_template(
  p_plan_id uuid,
  p_title text
)
RETURNS public.plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_owner_id uuid;
  v_source public.plans;
  v_new public.plans;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'A title is required';
  END IF;

  SELECT * INTO v_source FROM public.plans WHERE id = p_plan_id;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Plan not found';
  END IF;
  -- Ownership check happens here, server-side, regardless of what the
  -- caller's RLS-scoped client already enforces on the SELECT above --
  -- this function runs as SECURITY DEFINER so it must re-verify itself.
  IF v_source.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the plan owner can duplicate this plan';
  END IF;

  -- The new plan always belongs to the caller (never a client-supplied
  -- owner), starts as a fresh draft, and never carries the source's
  -- event-specific fields (date/city/guests/budget/venue note/extras) --
  -- only structural/style fields a future similar event could reuse.
  INSERT INTO public.plans (owner_id, kind, event_type, title, status, currency, style, priorities)
  VALUES (auth.uid(), v_source.kind, v_source.event_type, btrim(p_title), 'draft', v_source.currency, v_source.style, v_source.priorities)
  RETURNING * INTO v_new;

  -- Category structure only -- allocated_kobo is zeroed, never copied, so
  -- the duplicate never implies a budget split that was never actually
  -- set for it.
  INSERT INTO public.plan_categories (plan_id, key, label, vents_category, allocated_kobo, is_priority, is_contingency, sort)
  SELECT v_new.id, c.key, c.label, c.vents_category, 0, c.is_priority, c.is_contingency, c.sort
  FROM public.plan_categories c
  WHERE c.plan_id = p_plan_id;

  INSERT INTO public.plan_milestones (plan_id, phase_key, label, ends_offset_days)
  SELECT v_new.id, m.phase_key, m.label, m.ends_offset_days
  FROM public.plan_milestones m
  WHERE m.plan_id = p_plan_id;

  RETURN v_new;
END;
$function$;

REVOKE ALL ON FUNCTION public.duplicate_plan_as_template(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.duplicate_plan_as_template(uuid, text) TO authenticated;
