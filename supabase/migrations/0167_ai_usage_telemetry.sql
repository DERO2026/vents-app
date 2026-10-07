-- VENTS Phase 5A -- lightweight AI usage/cost telemetry.
--
-- Purpose: the Phase 5 economics audit's cost-per-request figures were
-- all estimates -- this gives VENTS a real, minimal, append-only ledger of
-- what Anthropic actually reports per completed call, specifically so the
-- cache-hit-rate and per-request-cost assumptions behind the VENTS AI
-- $4.99/50/75 launch decision can be checked against real traffic before
-- money changes hands. This is NOT a dashboard, NOT an analytics
-- platform, and NOT a billing ledger -- it stores raw Anthropic usage
-- counters plus a clearly-labeled ESTIMATE, nothing else.
--
-- Privacy, enforced structurally (no column exists to put these in, not
-- just a convention not to use one): no prompt text, no message content,
-- no tool arguments/results, no images, no email, no username, no auth
-- user id, no IP address. `round_id` is a random UUID generated fresh per
-- HTTP request by the calling code (api/_lib/aiTelemetry.ts) -- it groups
-- the rounds of one request together for later cross-round cost
-- aggregation and is NEVER derived from, or stored alongside, anything
-- that identifies who made the request.
CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id                           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  surface                      text NOT NULL CHECK (surface IN ('chat', 'extraction', 'vision')),
  model                        text NOT NULL,
  round_id                     uuid NOT NULL,
  round_index                  smallint NOT NULL DEFAULT 0,
  status                       text NOT NULL CHECK (status IN ('success', 'error')),
  -- Every one of these is nullable BY DESIGN: when Anthropic's response
  -- doesn't report a value (an error response has no usage object; a
  -- response with no server-side tool use never ran a web search), the
  -- column stores NULL, never a fabricated 0 or guess.
  input_tokens                 integer,
  output_tokens                integer,
  cache_creation_input_tokens  integer,
  cache_read_input_tokens      integer,
  web_search_requests          integer,
  -- A CALCULATED ESTIMATE from the raw counters above, using the pricing
  -- CONFIGURATION in api/_lib/aiPricing.ts (kept out of this table on
  -- purpose -- a future price change never needs to touch historical
  -- rows; the raw token counts above remain the source of truth and the
  -- estimate can always be recomputed from them). This is explicitly an
  -- ESTIMATE, never an invoice or a billing amount -- nothing in VENTS
  -- reads this column to charge anyone.
  estimated_cost_usd           numeric(12, 6)
);

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
-- No policies -- no direct anon/authenticated access at all, by design
-- (same pattern as every other server-only table in this codebase:
-- rate_limits 0026, ai_entitlements/ai_usage_periods 0165). The only
-- writer is record_ai_usage_event() below, reachable only via the
-- trusted project_admin Postgres connection. There is no read RPC either
-- -- aggregate queries (average cost/request, cache-read %, p95, etc.)
-- are run directly against this table via the project's own SQL tooling
-- when actually needed, not exposed as an app-facing API, since this
-- phase explicitly does not build a dashboard.

-- A couple of narrow indexes for the aggregate queries this ledger exists
-- to support (cost by surface, cost by model, time-windowed averages) --
-- nothing exotic, this table is expected to stay small relative to
-- VENTS's other tables at current traffic.
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_surface_created_at
  ON public.ai_usage_events (surface, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_model_created_at
  ON public.ai_usage_events (model, created_at);

-- Single writer, SECURITY DEFINER, project_admin-only -- the application
-- code never has a path to insert into this table other than through
-- this function, and this function never has a path to touch any other
-- table (no entitlement/usage/billing table is read or written here),
-- so a bug or compromise in telemetry recording cannot read another
-- user's data, modify usage, modify costs, influence entitlement
-- balances, or affect billing -- it can only ever append one row shaped
-- exactly like this table's columns.
CREATE OR REPLACE FUNCTION public.record_ai_usage_event(
  p_surface text,
  p_model text,
  p_round_id uuid,
  p_round_index smallint,
  p_status text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cache_creation_input_tokens integer,
  p_cache_read_input_tokens integer,
  p_web_search_requests integer,
  p_estimated_cost_usd numeric
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_surface NOT IN ('chat', 'extraction', 'vision') THEN
    RAISE EXCEPTION 'invalid p_surface: %', p_surface;
  END IF;
  IF p_status NOT IN ('success', 'error') THEN
    RAISE EXCEPTION 'invalid p_status: %', p_status;
  END IF;

  INSERT INTO public.ai_usage_events (
    surface, model, round_id, round_index, status,
    input_tokens, output_tokens, cache_creation_input_tokens,
    cache_read_input_tokens, web_search_requests, estimated_cost_usd
  ) VALUES (
    p_surface, p_model, p_round_id, COALESCE(p_round_index, 0), p_status,
    p_input_tokens, p_output_tokens, p_cache_creation_input_tokens,
    p_cache_read_input_tokens, p_web_search_requests, p_estimated_cost_usd
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_ai_usage_event(text, text, uuid, smallint, text, integer, integer, integer, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_usage_event(text, text, uuid, smallint, text, integer, integer, integer, integer, integer, numeric) TO project_admin;

-- No grant of any kind on public.ai_usage_events itself to anon/
-- authenticated (table grants default to none beyond the owner unless
-- explicitly granted, and none are granted here) -- combined with RLS
-- enabled + zero policies, this is two independent layers denying direct
-- table access, matching this repo's established defense-in-depth
-- convention for server-only tables.
