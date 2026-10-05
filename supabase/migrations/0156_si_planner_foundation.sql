-- VENTS SI Planner -- Batch 1: backend/data foundation only.
--
-- Design source of truth: "VENTS SI Planner.dc.html" (design spec v1,
-- frozen 5 Oct 2026, §12 Components/States/Models, §14 Build notes & real
-- gaps). No UI from that spec is built here -- this migration exists only
-- to close the two backend gaps the spec itself calls out as blocking:
--   1. "SI today is stateless; conversations are in-memory per session
--      (VentsAiScreen.tsx). Planner needs new tables and persisted plan
--      threads." -- tables below, plus plan_messages for the persisted
--      per-plan thread.
--   2. "search_services_or_providers accepts only keyword + category.
--      Recommendations need optional location and max_starting_price
--      filters." -- a new search_services_fuzzy_filtered function below,
--      sitting alongside the existing search_services_fuzzy (0081)
--      unchanged, so today's api/_lib/aiTools.ts call site is completely
--      unaffected.
-- Provider availability is explicitly NOT modeled here -- the spec
-- confirms it doesn't exist anywhere in the repo and the planner design
-- deliberately never claims it; nothing to add.
--
-- Everything else in the spec (PlanOfferCard, QuestionCard, PlanUpdateCard,
-- the Plans tab UI, the new SI tool declarations/execution wiring in
-- api/_lib/aiTools.ts, VentsAiScreen.tsx integration) is UI/integration
-- work for a later batch and is deliberately NOT touched here, per the
-- explicit instruction that this batch is backend/data foundation only.

-- ── 1. Plans ─────────────────────────────────────────────────────────────
-- EventPlan (§12). `kind` is already modeled as 'personal' | 'organizer'
-- per the spec's own organizer-expansion path, even though V1 scope is
-- personal-only (§14 "Suggested V1 scope") -- this avoids a later migration
-- just to widen a CHECK constraint. No `thread_id` column: this schema
-- gives each plan exactly one persisted thread via plan_messages.plan_id
-- (a 1:1 FK), matching the spec's "one pinned SI thread per plan" rule
-- without a redundant join table.
CREATE TABLE IF NOT EXISTS public.plans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'personal',
  event_type text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  -- brief fields (§12 EventPlan.brief), flattened rather than jsonb-only --
  -- date/guests/city are read/filtered often enough (draft vs active,
  -- "not-yet" states per spec §S4) to deserve real columns; style/
  -- priorities/extras stay jsonb-ish arrays since they're display-only.
  event_date date,
  end_date date,
  city text,
  venue_note text,
  guests int,
  setting text,
  style text[] NOT NULL DEFAULT '{}'::text[],
  -- Spec caps priorities at 3 (brief.priorities[3]); enforced here, not
  -- just in the UI, since this is a real data invariant, not a display rule.
  priorities text[] NOT NULL DEFAULT '{}'::text[],
  extras jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency text NOT NULL DEFAULT 'NGN',
  total_kobo bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_pkey PRIMARY KEY (id),
  CONSTRAINT plans_kind_check CHECK (kind IN ('personal', 'organizer')),
  CONSTRAINT plans_status_check CHECK (status IN ('draft', 'active', 'past', 'archived')),
  CONSTRAINT plans_total_kobo_check CHECK (total_kobo IS NULL OR total_kobo >= 0),
  CONSTRAINT plans_priorities_max3_check CHECK (array_length(priorities, 1) IS NULL OR array_length(priorities, 1) <= 3)
);

CREATE INDEX IF NOT EXISTS idx_plans_owner_id ON public.plans (owner_id);

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY plans_select_own ON public.plans FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin_or_root());
CREATE POLICY plans_insert_own ON public.plans FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY plans_update_own ON public.plans FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin_or_root())
  WITH CHECK (owner_id = auth.uid() OR public.is_admin_or_root());
CREATE POLICY plans_delete_own ON public.plans FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin_or_root());

-- ── 2. Plan categories ───────────────────────────────────────────────────
-- PlanCategory (§12). allocated_kobo is NOT directly writable by clients --
-- see set_plan_category_allocation() below, which is the only path that
-- changes it, so the budget invariant (§12 "Budget interaction") is
-- enforced in one place rather than re-checked ad hoc wherever a client
-- might PATCH this row.
CREATE TABLE IF NOT EXISTS public.plan_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  vents_category text,
  allocated_kobo bigint NOT NULL DEFAULT 0,
  is_priority boolean NOT NULL DEFAULT false,
  is_contingency boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_categories_pkey PRIMARY KEY (id),
  CONSTRAINT plan_categories_plan_key_unique UNIQUE (plan_id, key),
  CONSTRAINT plan_categories_allocated_check CHECK (allocated_kobo >= 0)
);

CREATE INDEX IF NOT EXISTS idx_plan_categories_plan_id ON public.plan_categories (plan_id);

ALTER TABLE public.plan_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_categories_select_own ON public.plan_categories FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));
CREATE POLICY plan_categories_insert_own ON public.plan_categories FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND p.owner_id = auth.uid()));
CREATE POLICY plan_categories_update_own ON public.plan_categories FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));
CREATE POLICY plan_categories_delete_own ON public.plan_categories FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));

-- ── 3. Plan assignments ──────────────────────────────────────────────────
-- PlanAssignment (§12). booking_id links to the EXISTING service_bookings
-- table (0054) -- the planner never creates its own booking/payment
-- concept, it only points at one. status here is the planner's own
-- shortlist/assign state; once a real booking exists, paid/cancelled are
-- read off service_bookings.payment_status/status (see assignment_financials
-- below), never duplicated onto this row by a client write.
CREATE TABLE IF NOT EXISTS public.plan_assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.plan_categories(id) ON DELETE CASCADE,
  provider_id uuid REFERENCES public.service_providers(id),
  own_vendor_name text,
  own_vendor_phone text,
  agreed_kobo bigint,
  status text NOT NULL DEFAULT 'shortlisted',
  booking_id uuid REFERENCES public.service_bookings(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT plan_assignments_status_check CHECK (status IN ('shortlisted', 'assigned', 'booked', 'cancelled')),
  CONSTRAINT plan_assignments_agreed_check CHECK (agreed_kobo IS NULL OR agreed_kobo >= 0),
  -- Mirrors the spec's own union type: either a real VENTS provider or a
  -- named own-vendor, never neither (an assignment with no one named is
  -- meaningless) and never both (ambiguous which one applies).
  CONSTRAINT plan_assignments_provider_xor_own_vendor CHECK (
    (provider_id IS NOT NULL AND own_vendor_name IS NULL)
    OR (provider_id IS NULL AND own_vendor_name IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_plan_assignments_category_id ON public.plan_assignments (category_id);
CREATE INDEX IF NOT EXISTS idx_plan_assignments_booking_id ON public.plan_assignments (booking_id);

ALTER TABLE public.plan_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_assignments_select_own ON public.plan_assignments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.plan_categories c JOIN public.plans p ON p.id = c.plan_id
    WHERE c.id = category_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())
  ));
CREATE POLICY plan_assignments_insert_own ON public.plan_assignments FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.plan_categories c JOIN public.plans p ON p.id = c.plan_id
    WHERE c.id = category_id AND p.owner_id = auth.uid()
  ));
CREATE POLICY plan_assignments_update_own ON public.plan_assignments FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.plan_categories c JOIN public.plans p ON p.id = c.plan_id
    WHERE c.id = category_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.plan_categories c JOIN public.plans p ON p.id = c.plan_id
    WHERE c.id = category_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())
  ));
CREATE POLICY plan_assignments_delete_own ON public.plan_assignments FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.plan_categories c JOIN public.plans p ON p.id = c.plan_id
    WHERE c.id = category_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())
  ));

-- ── 4. Plan tasks ────────────────────────────────────────────────────────
-- PlanTask (§12). completes_on_booking marks a task the UI locks/auto-
-- completes once its linked assignment's booking is paid (§12 TaskRow
-- "auto-done (green, locked)") -- read-derived in a later batch, not
-- enforced at the DB layer here.
CREATE TABLE IF NOT EXISTS public.plan_tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.plan_categories(id) ON DELETE SET NULL,
  title text NOT NULL,
  offset_days int,
  due_override date,
  done_at timestamptz,
  source text NOT NULL DEFAULT 'user',
  completes_on_booking boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_tasks_pkey PRIMARY KEY (id),
  CONSTRAINT plan_tasks_source_check CHECK (source IN ('si', 'user'))
);

CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan_id ON public.plan_tasks (plan_id);

ALTER TABLE public.plan_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_tasks_select_own ON public.plan_tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));
CREATE POLICY plan_tasks_insert_own ON public.plan_tasks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND p.owner_id = auth.uid()));
CREATE POLICY plan_tasks_update_own ON public.plan_tasks FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));
CREATE POLICY plan_tasks_delete_own ON public.plan_tasks FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));

-- ── 5. Plan milestones ───────────────────────────────────────────────────
-- PlanMilestone (§12). Phase template rows per plan; the timeline itself is
-- "derived, not edited" (§12 Timeline interaction) from these + plan_tasks
-- + the plan's event_date, computed in a later batch -- this table only
-- holds the phase data the derivation will read.
CREATE TABLE IF NOT EXISTS public.plan_milestones (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  phase_key text NOT NULL,
  label text NOT NULL,
  ends_offset_days int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_milestones_pkey PRIMARY KEY (id),
  CONSTRAINT plan_milestones_plan_phase_unique UNIQUE (plan_id, phase_key)
);

CREATE INDEX IF NOT EXISTS idx_plan_milestones_plan_id ON public.plan_milestones (plan_id);

ALTER TABLE public.plan_milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_milestones_select_own ON public.plan_milestones FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));
CREATE POLICY plan_milestones_insert_own ON public.plan_milestones FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND p.owner_id = auth.uid()));
CREATE POLICY plan_milestones_update_own ON public.plan_milestones FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));
CREATE POLICY plan_milestones_delete_own ON public.plan_milestones FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));

-- ── 6. Plan messages (the persisted per-plan SI thread) ──────────────────
-- This is the "persisted plan threads" half of the §14 PERSISTENCE gap.
-- General SI Chat (outside a plan) deliberately stays in-memory/stateless,
-- exactly as it is today -- the spec only calls for persistence of a
-- plan's own pinned thread, not a wholesale rework of VentsAiScreen's
-- existing session-only history.
CREATE TABLE IF NOT EXISTS public.plan_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_messages_pkey PRIMARY KEY (id),
  CONSTRAINT plan_messages_role_check CHECK (role IN ('user', 'assistant'))
);

CREATE INDEX IF NOT EXISTS idx_plan_messages_plan_id_created_at ON public.plan_messages (plan_id, created_at);

ALTER TABLE public.plan_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_messages_select_own ON public.plan_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND (p.owner_id = auth.uid() OR public.is_admin_or_root())));
CREATE POLICY plan_messages_insert_own ON public.plan_messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND p.owner_id = auth.uid()));
-- No UPDATE/DELETE policy: a plan thread is an append-only log, same as
-- every other chat-message table in this codebase -- messages are never
-- edited or deleted by a client once sent.

-- ── 7. Budget invariant enforcement ──────────────────────────────────────
-- The spec's one hard money rule (§12 "Budget interaction Invariants"):
-- allocation >= committed + paid for that category, and total allocated
-- across categories never exceeds the plan's total_kobo. Enforced here as
-- the single write path for allocated_kobo, rather than left to every
-- future client call site to re-check.
CREATE OR REPLACE FUNCTION public.set_plan_category_allocation(
  p_category_id uuid,
  p_allocated_kobo bigint
)
RETURNS public.plan_categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_plan_id uuid;
  v_owner_id uuid;
  v_total_kobo bigint;
  v_committed_and_paid bigint;
  v_other_allocated bigint;
  v_row public.plan_categories;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_allocated_kobo IS NULL OR p_allocated_kobo < 0 THEN
    RAISE EXCEPTION 'Allocation must be zero or a positive amount';
  END IF;

  SELECT c.plan_id, p.owner_id, p.total_kobo
    INTO v_plan_id, v_owner_id, v_total_kobo
  FROM public.plan_categories c
  JOIN public.plans p ON p.id = c.plan_id
  WHERE c.id = p_category_id;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'Plan category not found';
  END IF;
  IF v_owner_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only the plan owner can change its budget';
  END IF;

  -- committed = agreed_kobo where status = assigned, or booked and the
  -- linked booking isn't paid yet; paid = booked and the linked booking IS
  -- paid. Matches §12's committed/paid derivation exactly.
  SELECT coalesce(SUM(a.agreed_kobo), 0) INTO v_committed_and_paid
  FROM public.plan_assignments a
  WHERE a.category_id = p_category_id
    AND a.status IN ('assigned', 'booked')
    AND a.agreed_kobo IS NOT NULL;

  IF p_allocated_kobo < v_committed_and_paid THEN
    RAISE EXCEPTION 'Allocation (%) can''t be set below what''s already committed or paid (%)', p_allocated_kobo, v_committed_and_paid;
  END IF;

  IF v_total_kobo IS NOT NULL THEN
    SELECT coalesce(SUM(c.allocated_kobo), 0) INTO v_other_allocated
    FROM public.plan_categories c
    WHERE c.plan_id = v_plan_id AND c.id <> p_category_id;

    IF v_other_allocated + p_allocated_kobo > v_total_kobo THEN
      RAISE EXCEPTION 'Allocation would put the plan over its total budget';
    END IF;
  END IF;

  UPDATE public.plan_categories
    SET allocated_kobo = p_allocated_kobo, updated_at = now()
    WHERE id = p_category_id
    RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_plan_category_allocation(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_plan_category_allocation(uuid, bigint) TO authenticated;

-- ── 8. Provider search filters (§14 gap: location + max price) ──────────
-- A SEPARATE function, not an overload of search_services_fuzzy (0081):
-- Postgres resolves a named-argument call against the candidate requiring
-- the fewest defaulted parameters, but with two overloads of the same name
-- differing only in trailing optional params, that resolution has edge
-- cases that aren't worth risking against the function
-- executeSearchServicesOrProviders calls today in production. Keeping
-- search_services_fuzzy(text,text,int) completely untouched guarantees
-- zero regression risk for that existing call site; this new function is
-- what a later batch's recommend_providers(category_id) SI tool calls
-- instead, once it needs the location/budget filters. When
-- p_max_starting_price is given, a provider with no starting_price on file
-- is excluded rather than assumed affordable (never claim a price fits a
-- budget without real data).
CREATE OR REPLACE FUNCTION public.search_services_fuzzy_filtered(
  p_query text,
  p_category text DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_location text DEFAULT NULL,
  p_max_starting_price numeric DEFAULT NULL
)
RETURNS TABLE(
  provider_id uuid,
  business_name text,
  provider_category text,
  provider_description text,
  location text,
  starting_price numeric,
  starting_price_currency text,
  service_id uuid,
  service_name text,
  service_description text,
  service_price numeric,
  service_currency text,
  match_score real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT
    sp.id AS provider_id,
    sp.business_name,
    sp.category AS provider_category,
    sp.description AS provider_description,
    sp.location,
    sp.starting_price,
    sp.starting_price_currency,
    ps.id AS service_id,
    ps.name AS service_name,
    ps.description AS service_description,
    ps.price AS service_price,
    ps.currency AS service_currency,
    GREATEST(
      public.similarity(coalesce(ps.name, ''), coalesce(p_query, '')),
      public.similarity(coalesce(ps.description, ''), coalesce(p_query, '')),
      public.similarity(coalesce(sp.business_name, ''), coalesce(p_query, '')),
      public.similarity(coalesce(sp.description, ''), coalesce(p_query, '')),
      public.similarity(coalesce(sp.category, ''), coalesce(p_query, ''))
    ) AS match_score
  FROM public.provider_services ps
  JOIN public.service_providers sp ON sp.id = ps.provider_id
  WHERE
    sp.status = 'approved'
    AND ps.is_active = true
    AND (
      p_category IS NULL
      OR sp.category = p_category
      OR ps.category = p_category
      OR EXISTS (
        SELECT 1 FROM public.service_provider_categories spc
        WHERE spc.provider_id = sp.id AND spc.category = p_category
      )
    )
    AND (
      coalesce(p_query, '') = ''
      OR ps.name ILIKE '%' || p_query || '%'
      OR ps.description ILIKE '%' || p_query || '%'
      OR sp.business_name ILIKE '%' || p_query || '%'
      OR sp.description ILIKE '%' || p_query || '%'
      OR sp.category ILIKE '%' || p_query || '%'
      OR public.similarity(coalesce(ps.name, ''), p_query) > 0.2
      OR public.similarity(coalesce(sp.business_name, ''), p_query) > 0.2
    )
    AND (p_location IS NULL OR sp.location ILIKE '%' || p_location || '%')
    AND (p_max_starting_price IS NULL OR (sp.starting_price IS NOT NULL AND sp.starting_price <= p_max_starting_price))
  ORDER BY match_score DESC, sp.created_at DESC
  LIMIT LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);
$function$
;

REVOKE ALL ON FUNCTION public.search_services_fuzzy_filtered(text, text, int, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_services_fuzzy_filtered(text, text, int, text, numeric) TO anon, authenticated, project_admin;
