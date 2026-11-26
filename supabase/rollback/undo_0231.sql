-- Undo 0231 (safe ticket-tier identity, finding N3). Gated: run with
--   SET vents.rollback_confirm = 'undo-0231';
-- Restores 0229's events_ticket_tier_identity exactly (text copied verbatim
-- from 0229_ticket_tier_rename.sql) and its default EXECUTE grant. Refuses
-- unless the live function carries the [0231] marker. No event, ticket or
-- order row is touched; keys stored by 0231 (including "Name#2" keys for
-- legacy duplicates) stay and are read by 0229 as ordinary keys.
-- WARNING: after undo, the older-app positional fallback (finding N3) is
-- back: an older build's delete + add can move a tier's sales and open
-- orders to a different tier, and legacy duplicate-name events become
-- uneditable again.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0231' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0231'' first';
  END IF;
  IF position('[0231]' IN pg_get_functiondef('public.events_ticket_tier_identity()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'undo_0231: events_ticket_tier_identity does not carry the 0231 version; refusing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.events_ticket_tier_identity()
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

GRANT EXECUTE ON FUNCTION public.events_ticket_tier_identity() TO PUBLIC;

COMMIT;
