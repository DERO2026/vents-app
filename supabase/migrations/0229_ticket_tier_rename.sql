-- 0229: organizers may rename a ticket tier after sales begin (decision D2a,
-- owner-approved 2026-11-26; docs/repair-tracker.md).
--
-- The data model: events.ticket_types is a JSON array of tiers
-- ({name, price, quantity, description, id}); each ticket stores the tier
-- NAME it was bought under in tickets.ticket_type (and pending_purchases.
-- ticket_type for an order in progress). The client's `id` is positional
-- (t_0, t_1, ...) and changes when tiers are removed, so it cannot identify
-- a tier. Every purchase, capacity and report function matched tickets to
-- tiers by the CURRENT name, so a rename would have:
--   * reset the renamed tier's sold count to 0 (overselling past its quantity),
--   * made an order already in checkout under the old name fail to finalize
--     ("Ticket type not found") after the buyer was charged,
--   * split the organizer's per-tier analytics in two.
--
-- Fix (additive; no ticket, payment, receipt, refund or report row is
-- touched; tickets keep the name they were bought under):
--   1. Each tier carries a stable `key` and a server-maintained
--      `previous_names` list. A BEFORE trigger on events matches the new
--      tiers to the old ones by key (a tier with no key yet is identified by
--      its name), records the old name when a tier is renamed, ignores any
--      client-supplied previous_names, and refuses a rename that would make
--      two tiers share a current or previous name (that would make sales
--      ambiguous).
--   2. ticket_tier_find / ticket_tier_names / ticket_tier_current_name: a
--      tier is found by its current name OR any previous name.
--   3. purchase_ticket, create_pending_purchase, finalize_pending_purchase:
--      the tier is found by current or previous name, and the per-tier sold
--      count includes tickets sold under every name the tier has had.
--   4. get_event_ticket_type_availability and get_event_analytics report
--      tickets under the tier's CURRENT name (counts and capacity stay
--      correct); each ticket row itself still says its purchase-time name.
--
-- Existing events need no backfill: a tier without a key is identified by
-- its name until its next save, when the trigger gives it key = name.
--
-- Functions are patched IN PLACE from their live definitions (each anchor
-- must match exactly once; any drift refuses the whole migration). The
-- anchors are outside every earlier in-place patch (0203, 0208, 0220, 0221,
-- 0224). Grants are unchanged. Undo: supabase/rollback/undo_0229.sql.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.purchase_ticket(uuid,text,jsonb,text,text)') IS NULL
     OR to_regprocedure('public.create_pending_purchase(uuid,text,jsonb,text,text)') IS NULL
     OR to_regprocedure('public.finalize_pending_purchase(text)') IS NULL
     OR to_regprocedure('public.get_event_ticket_type_availability(uuid)') IS NULL
     OR to_regprocedure('public.get_event_analytics(uuid)') IS NULL THEN
    RAISE EXCEPTION '0229: an expected ticket function is missing; refusing';
  END IF;
END
$pre$;

-- ── Tier lookup helpers (pure; no table access) ─────────────────────────────
CREATE FUNCTION public.ticket_tier_find(p_tiers jsonb, p_name text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  -- [0229] The tier whose current name is p_name, else the tier that used to
  -- be called p_name. NULL if none.
  SELECT x.value
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_tiers) = 'array' THEN p_tiers ELSE '[]'::jsonb END) WITH ORDINALITY AS x(value, ord)
   WHERE jsonb_typeof(x.value) = 'object'
     AND (x.value->>'name' = p_name
          OR (jsonb_typeof(x.value->'previous_names') = 'array' AND x.value->'previous_names' ? p_name))
   ORDER BY (x.value->>'name' = p_name) DESC, x.ord
   LIMIT 1;
$function$;

CREATE FUNCTION public.ticket_tier_names(p_tiers jsonb, p_name text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  -- [0229] Every name the tier called p_name (now or before) has had.
  SELECT CASE WHEN t IS NULL THEN ARRAY[p_name]
              ELSE ARRAY[t->>'name'] || COALESCE(ARRAY(SELECT jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(t->'previous_names') = 'array' THEN t->'previous_names' ELSE '[]'::jsonb END)), '{}')
         END
    FROM (SELECT public.ticket_tier_find(p_tiers, p_name) AS t) s;
$function$;

CREATE FUNCTION public.ticket_tier_current_name(p_tiers jsonb, p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  -- [0229] The tier's current name for a ticket bought under p_name.
  SELECT COALESCE(public.ticket_tier_find(p_tiers, p_name)->>'name', p_name);
$function$;

GRANT EXECUTE ON FUNCTION public.ticket_tier_find(jsonb, text) TO anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.ticket_tier_names(jsonb, text) TO anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.ticket_tier_current_name(jsonb, text) TO anon, authenticated, project_admin;

-- ── Tier identity on every save ────────────────────────────────────────────
CREATE FUNCTION public.events_ticket_tier_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_out   jsonb := '[]'::jsonb;
  v_tier  jsonb;
  v_old   jsonb;
  v_key   text;
  v_prev  jsonb;
  v_keys  text[] := '{}';
  v_claimed text[];
  v_clash text;
BEGIN
  IF NEW.ticket_types IS NULL OR jsonb_typeof(NEW.ticket_types) <> 'array' THEN
    RETURN NEW;  -- validate_event_ticket_types reports a malformed value
  END IF;
  -- Every identity the new list claims (explicit key, else name).
  SELECT COALESCE(array_agg(COALESCE(NULLIF(btrim(n.value->>'key'), ''), n.value->>'name')), '{}') INTO v_claimed
    FROM jsonb_array_elements(NEW.ticket_types) AS n(value)
   WHERE jsonb_typeof(n.value) = 'object';
  FOR v_tier IN SELECT value FROM jsonb_array_elements(NEW.ticket_types) LOOP
    IF jsonb_typeof(v_tier) <> 'object' THEN
      v_out := v_out || jsonb_build_array(v_tier);
      CONTINUE;
    END IF;
    v_key := COALESCE(NULLIF(btrim(v_tier->>'key'), ''), v_tier->>'name');
    v_old := NULL;
    IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.ticket_types) = 'array' THEN
      SELECT o.value INTO v_old
        FROM jsonb_array_elements(OLD.ticket_types) AS o(value)
       WHERE jsonb_typeof(o.value) = 'object'
         AND COALESCE(NULLIF(btrim(o.value->>'key'), ''), o.value->>'name') = v_key
       LIMIT 1;
      -- Older app builds send no key. For such a tier that matches nothing by
      -- name, fall back to the client's per-save `id`, but only onto an old
      -- tier that no tier in the new list claims (a rename in that save).
      IF v_old IS NULL AND NULLIF(btrim(v_tier->>'key'), '') IS NULL AND NULLIF(v_tier->>'id', '') IS NOT NULL THEN
        SELECT o.value INTO v_old
          FROM jsonb_array_elements(OLD.ticket_types) AS o(value)
         WHERE jsonb_typeof(o.value) = 'object'
           AND o.value->>'id' = v_tier->>'id'
           AND NOT (COALESCE(NULLIF(btrim(o.value->>'key'), ''), o.value->>'name') = ANY (v_claimed))
         LIMIT 1;
        IF v_old IS NOT NULL THEN
          v_key := COALESCE(NULLIF(btrim(v_old->>'key'), ''), v_old->>'name');
        END IF;
      END IF;
    END IF;
    IF v_key = ANY (v_keys) THEN
      RAISE EXCEPTION 'Two ticket types have the same identity ("%"); refresh and try again', v_key;
    END IF;
    v_keys := v_keys || v_key;
    -- previous_names is server-maintained: the old tier's list, plus its old
    -- name when this save renames it. Anything the client sent is ignored.
    v_prev := CASE WHEN jsonb_typeof(v_old->'previous_names') = 'array' THEN v_old->'previous_names' ELSE '[]'::jsonb END;
    IF v_old IS NOT NULL AND (v_old->>'name') IS DISTINCT FROM (v_tier->>'name') THEN
      v_prev := v_prev || to_jsonb(v_old->>'name');
    END IF;
    SELECT COALESCE(jsonb_agg(DISTINCT n), '[]'::jsonb) INTO v_prev
      FROM jsonb_array_elements_text(v_prev) AS n
     WHERE n IS DISTINCT FROM v_tier->>'name' AND n IS NOT NULL;
    v_out := v_out || jsonb_build_array(v_tier || jsonb_build_object('key', v_key, 'previous_names', v_prev));
  END LOOP;

  -- A renamed tier's names (current and previous) may not overlap another
  -- tier's names: sales under that name would belong to two tiers.
  SELECT a.n INTO v_clash
    FROM (SELECT x.ord, n FROM jsonb_array_elements(v_out) WITH ORDINALITY AS x(t, ord),
                 LATERAL (SELECT x.t->>'name' AS n UNION SELECT jsonb_array_elements_text(x.t->'previous_names')) names
           WHERE jsonb_typeof(x.t) = 'object') a
    JOIN (SELECT x.ord, n, jsonb_array_length(x.t->'previous_names') AS renamed
            FROM jsonb_array_elements(v_out) WITH ORDINALITY AS x(t, ord),
                 LATERAL (SELECT x.t->>'name' AS n UNION SELECT jsonb_array_elements_text(x.t->'previous_names')) names
           WHERE jsonb_typeof(x.t) = 'object') b
      ON a.n = b.n AND a.ord <> b.ord
   WHERE b.renamed > 0
   LIMIT 1;
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'The ticket type name "%" is already used, or was used before, by another ticket type at this event. Choose a different name.', v_clash;
  END IF;

  NEW.ticket_types := v_out;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_events_ticket_tier_identity
  BEFORE INSERT OR UPDATE OF ticket_types ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_ticket_tier_identity();

-- ── In-place patches ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.vents_0229_patch(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  IF position('[0229]' IN v_def) > 0 THEN
    RAISE EXCEPTION '0229: % is already patched; refusing to run twice', p_sig;
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION '0229: % is not the expected version (anchor % not found exactly once); refusing to patch', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END;
$h$;

SELECT pg_temp.vents_0229_patch('public.purchase_ticket(uuid,text,jsonb,text,text)', ARRAY[
  ARRAY[$a$    FROM jsonb_array_elements(v_event.ticket_types) AS tt
    WHERE tt->>'name' = p_ticket_type
    LIMIT 1;$a$, $a$    FROM (SELECT public.ticket_tier_find(v_event.ticket_types, p_ticket_type) AS tt) AS found  -- [0229] current or previous name
    WHERE tt IS NOT NULL
    LIMIT 1;$a$],
  ARRAY[$a$      WHERE event_id = p_event_id AND ticket_type = p_ticket_type AND status = 'active';$a$,
        $a$      WHERE event_id = p_event_id AND ticket_type = ANY (public.ticket_tier_names(v_event.ticket_types, p_ticket_type)) AND status = 'active';$a$]
]);

SELECT pg_temp.vents_0229_patch('public.create_pending_purchase(uuid,text,jsonb,text,text)', ARRAY[
  ARRAY[$a$    FROM jsonb_array_elements(v_event.ticket_types) AS tt
    WHERE tt->>'name' = p_ticket_type
    LIMIT 1;$a$, $a$    FROM (SELECT public.ticket_tier_find(v_event.ticket_types, p_ticket_type) AS tt) AS found  -- [0229] current or previous name
    WHERE tt IS NOT NULL
    LIMIT 1;$a$],
  ARRAY[$a$   WHERE user_id = v_user_id AND event_id = p_event_id AND ticket_type = p_ticket_type$a$,
        $a$   WHERE user_id = v_user_id AND event_id = p_event_id AND ticket_type = ANY (public.ticket_tier_names(v_event.ticket_types, p_ticket_type))$a$]
]);

SELECT pg_temp.vents_0229_patch('public.finalize_pending_purchase(text)', ARRAY[
  ARRAY[$a$      FROM jsonb_array_elements(v_event.ticket_types) AS tt
      WHERE tt->>'name' = v_row.ticket_type
      LIMIT 1;$a$, $a$      FROM (SELECT public.ticket_tier_find(v_event.ticket_types, v_row.ticket_type) AS tt) AS found  -- [0229] current or previous name
      WHERE tt IS NOT NULL
      LIMIT 1;$a$],
  ARRAY[$a$        WHERE event_id = v_row.event_id AND ticket_type = v_row.ticket_type AND status = 'active';$a$,
        $a$        WHERE event_id = v_row.event_id AND ticket_type = ANY (public.ticket_tier_names(v_event.ticket_types, v_row.ticket_type)) AND status = 'active';$a$]
]);

SELECT pg_temp.vents_0229_patch('public.get_event_ticket_type_availability(uuid)', ARRAY[
  ARRAY[$a$  sold AS (
    SELECT t.ticket_type, count(*)::integer AS n
      FROM public.tickets t
     WHERE t.event_id = p_event_id AND t.status = 'active'
     GROUP BY t.ticket_type
  ),$a$, $a$  sold AS (
    -- [0229] Tickets sold under a tier's earlier names count toward it,
    -- reported under its current name.
    SELECT public.ticket_tier_current_name(ev.tiers, t.ticket_type) AS ticket_type, count(*)::integer AS n
      FROM public.tickets t CROSS JOIN ev
     WHERE t.event_id = p_event_id AND t.status = 'active'
     GROUP BY 1
  ),$a$]
]);

SELECT pg_temp.vents_0229_patch('public.get_event_analytics(uuid)', ARRAY[
  ARRAY[$a$    SELECT ticket_type, count(*)::integer AS sold_count, COALESCE(sum(amount * 100), 0)::bigint AS revenue_kobo
    FROM paid GROUP BY ticket_type$a$, $a$    -- [0229] Reported under the tier's current name; each ticket keeps its own.
    SELECT public.ticket_tier_current_name(v_event.ticket_types, ticket_type) AS ticket_type, count(*)::integer AS sold_count, COALESCE(sum(amount * 100), 0)::bigint AS revenue_kobo
    FROM paid GROUP BY 1$a$],
  ARRAY[$a$    SELECT ticket_type, count(*)::integer AS reserved_count
    FROM active_any_payment GROUP BY ticket_type$a$, $a$    SELECT public.ticket_tier_current_name(v_event.ticket_types, ticket_type) AS ticket_type, count(*)::integer AS reserved_count
    FROM active_any_payment GROUP BY 1$a$]
]);

COMMIT;
