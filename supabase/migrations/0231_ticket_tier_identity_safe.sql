-- 0231: safe ticket-tier identity for older app builds (finding N3; corrects
-- 0229, decision D2a).
--
-- 0229 identified a tier by its `key` (current app) or, for a tier with no
-- key, by its name; for an older app build (which sends no key) it then fell
-- back to the client's positional `id` (t_0, t_1, ...) onto an old tier that
-- the new list no longer claimed. Tested on a local copy, that fallback:
--   * delete one tier + add another in the same save: the NEW tier inherited
--     the deleted tier's sales, and an order already in checkout for the
--     deleted N9,000 tier was issued as a N50 ticket and confirmed;
--   * delete one tier + rename another: sales linked to the wrong tier;
--   * an event with two tiers of the same name (legal before 0229) could no
--     longer be saved at all ("Two ticket types have the same identity").
-- Also found while fixing it: an older build re-saving an event whose tier
-- the current app had renamed matched nothing (it sends the current name,
-- not the key), so the tier silently lost its key and earlier names.
--
-- New rules (events_ticket_tier_identity replaced; nothing else changes;
-- no ticket, order, payment or event row is rewritten):
--   1. A tier that sends a key is that tier. A tier with no key (older app)
--      is the existing tier with the same CURRENT name, else a new tier.
--      The positional id is never used.
--   2. Older app saves: if a tier that has sales (any ticket under any of its
--      names) or an open order (pending in the last 48 hours) disappears in
--      a save that also adds an unmatched tier, the save is REFUSED with an
--      actionable message -- it could be a rename, and guessing could move
--      sales to the wrong tier. Price/quantity/description edits, reorders,
--      adding tiers, removing or renaming unsold tiers stay allowed.
--   3. Every app version: a tier may not carry a name (current or previous)
--      that existing tickets or open orders belong to under a DIFFERENT tier
--      (including a removed one). Prevents a deleted tier's sales or orders
--      from being picked up by a new same-named tier.
--   4. A save may not create two tiers with the same name. Duplicates that
--      already existed (legacy events) are kept and stay editable: the k-th
--      tier with a given identity is matched to the k-th old one, and the
--      server stores a distinct key for each ("VIP", "VIP#2", ...).
--   5. 0229's server-maintained previous_names and rename-clash check are
--      unchanged.
-- The trigger function is SECURITY DEFINER so the sales check sees every
-- ticket regardless of the caller's row-level security; it is not callable
-- directly (it returns trigger).
--
-- Requires 0229. Refuses unless the live trigger function is exactly 0229's
-- version (its id-fallback text present once, no [0231] marker).
-- Undo: supabase/rollback/undo_0231.sql (restores 0229's function).

BEGIN;

DO $pre$
DECLARE
  v_def text;
BEGIN
  IF to_regprocedure('public.events_ticket_tier_identity()') IS NULL
     OR to_regprocedure('public.ticket_tier_find(jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '0231 requires 0229 (ticket tier identity); apply 0229 first';
  END IF;
  v_def := pg_get_functiondef('public.events_ticket_tier_identity()'::regprocedure);
  IF position('[0231]' IN v_def) > 0 THEN
    RAISE EXCEPTION '0231: events_ticket_tier_identity is already patched; refusing to run twice';
  END IF;
  IF (length(v_def) - length(replace(v_def, $a$AND o.value->>'id' = v_tier->>'id'$a$, ''))) / length($a$AND o.value->>'id' = v_tier->>'id'$a$) <> 1 THEN
    RAISE EXCEPTION '0231: events_ticket_tier_identity is not the expected (0229) version; refusing';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.events_ticket_tier_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  -- [0231] safe tier identity; no positional fallback.
  v_old_tiers jsonb := '[]'::jsonb;   -- [{ident, name, names[], tier}]
  v_new       jsonb := '[]'::jsonb;   -- [{ident, keyless, matched, tier}]
  v_out       jsonb := '[]'::jsonb;
  v_tier      jsonb;
  v_old       jsonb;
  v_base      text;
  v_ident     text;
  v_occ       integer;
  v_keyless   boolean;
  v_any_keyless boolean := false;
  v_unmatched_keyless boolean := false;
  v_prev      jsonb;
  v_name      text;
  v_clash     text;
  v_owner     text;
  i           integer;
BEGIN
  IF NEW.ticket_types IS NULL OR jsonb_typeof(NEW.ticket_types) <> 'array' THEN
    RETURN NEW;  -- validate_event_ticket_types reports a malformed value
  END IF;

  -- Old tiers, each with a unique identity (stored key, else name; the k-th
  -- duplicate of an identity is "<identity>#k", as rule 4 stores it).
  IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.ticket_types) = 'array' THEN
    FOR v_tier IN SELECT value FROM jsonb_array_elements(OLD.ticket_types) LOOP
      CONTINUE WHEN jsonb_typeof(v_tier) <> 'object';
      v_base := COALESCE(NULLIF(btrim(v_tier->>'key'), ''), v_tier->>'name');
      v_ident := v_base; v_occ := 1;
      WHILE EXISTS (SELECT 1 FROM jsonb_array_elements(v_old_tiers) x WHERE x->>'ident' = v_ident) LOOP
        v_occ := v_occ + 1; v_ident := v_base || '#' || v_occ;
      END LOOP;
      v_old_tiers := v_old_tiers || jsonb_build_array(jsonb_build_object(
        'ident', v_ident, 'name', v_tier->>'name', 'tier', v_tier,
        'names', to_jsonb(ARRAY[v_tier->>'name'] || COALESCE(ARRAY(SELECT jsonb_array_elements_text(
                   CASE WHEN jsonb_typeof(v_tier->'previous_names') = 'array' THEN v_tier->'previous_names' ELSE '[]'::jsonb END)), '{}'))));
    END LOOP;
  END IF;

  -- New tiers: resolve each to an identity.
  FOR v_tier IN SELECT value FROM jsonb_array_elements(NEW.ticket_types) LOOP
    IF jsonb_typeof(v_tier) <> 'object' THEN
      v_new := v_new || jsonb_build_array(jsonb_build_object('tier', v_tier, 'scalar', true));
      CONTINUE;
    END IF;
    v_keyless := NULLIF(btrim(v_tier->>'key'), '') IS NULL;
    v_any_keyless := v_any_keyless OR v_keyless;
    v_old := NULL;
    v_base := NULL;
    IF v_keyless THEN
      -- Older app: the k-th keyless tier named N is the k-th old tier whose
      -- CURRENT name is N.
      SELECT count(*) + 1 INTO v_occ FROM jsonb_array_elements(v_new) x
       WHERE (x->>'keyless')::boolean AND x->'tier'->>'name' = v_tier->>'name';
      SELECT o INTO v_old FROM jsonb_array_elements(v_old_tiers) WITH ORDINALITY AS t(o, ord)
       WHERE o->>'name' = v_tier->>'name' ORDER BY ord OFFSET v_occ - 1 LIMIT 1;
      IF v_old IS NOT NULL THEN
        v_ident := v_old->>'ident';
      ELSE
        v_ident := v_tier->>'name';
        v_unmatched_keyless := true;
      END IF;
    ELSE
      v_base := btrim(v_tier->>'key');
      SELECT count(*) + 1 INTO v_occ FROM jsonb_array_elements(v_new) x
       WHERE NOT COALESCE((x->>'keyless')::boolean, true) AND x->>'base' = v_base;
      v_ident := CASE WHEN v_occ = 1 THEN v_base ELSE v_base || '#' || v_occ END;
      IF v_occ > 1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_old_tiers) o WHERE o->>'ident' = v_ident) THEN
        RAISE EXCEPTION 'Two ticket types have the same identity ("%"); refresh and try again', v_base;
      END IF;
      SELECT o INTO v_old FROM jsonb_array_elements(v_old_tiers) o WHERE o->>'ident' = v_ident;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_new) x WHERE x->>'ident' = v_ident) THEN
      RAISE EXCEPTION 'Two ticket types have the same identity ("%"); refresh and try again', v_ident;
    END IF;
    v_new := v_new || jsonb_build_array(jsonb_build_object(
      'tier', v_tier, 'ident', v_ident, 'base', v_base, 'keyless', v_keyless, 'old', v_old));
  END LOOP;

  -- Rule 2: an older app save that drops a tier with sales or open orders
  -- while adding an unmatched tier is ambiguous (rename or delete + add).
  IF v_any_keyless AND v_unmatched_keyless THEN
    FOR v_old IN SELECT o FROM jsonb_array_elements(v_old_tiers) o
                  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_new) x WHERE x->>'ident' = o->>'ident') LOOP
      IF EXISTS (SELECT 1 FROM public.tickets t
                  WHERE t.event_id = NEW.id AND t.ticket_type IN (SELECT jsonb_array_elements_text(v_old->'names')))
         OR EXISTS (SELECT 1 FROM public.pending_purchases pp
                     WHERE pp.event_id = NEW.id AND pp.status = 'pending' AND pp.created_at > now() - interval '48 hours'
                       AND pp.ticket_type IN (SELECT jsonb_array_elements_text(v_old->'names'))) THEN
        RAISE EXCEPTION 'Ticket type "%" already has sales, so this version of the VENTS app can''t rename or replace it. Update the VENTS app and try again, or keep "%" and add the new ticket type alongside it.',
          v_old->>'name', v_old->>'name';
      END IF;
    END LOOP;
  END IF;

  -- Build the stored list: key = identity; previous_names server-maintained.
  FOR i IN 0 .. jsonb_array_length(v_new) - 1 LOOP
    IF (v_new->i->>'scalar') IS NOT NULL THEN
      v_out := v_out || jsonb_build_array(v_new->i->'tier');
      CONTINUE;
    END IF;
    v_tier := v_new->i->'tier';
    v_old := CASE WHEN jsonb_typeof(v_new->i->'old') = 'object' THEN v_new->i->'old'->'tier' END;
    v_prev := CASE WHEN jsonb_typeof(v_old->'previous_names') = 'array' THEN v_old->'previous_names' ELSE '[]'::jsonb END;
    IF v_old IS NOT NULL AND (v_old->>'name') IS DISTINCT FROM (v_tier->>'name') THEN
      v_prev := v_prev || to_jsonb(v_old->>'name');
    END IF;
    SELECT COALESCE(jsonb_agg(DISTINCT n), '[]'::jsonb) INTO v_prev
      FROM jsonb_array_elements_text(v_prev) AS n
     WHERE n IS DISTINCT FROM v_tier->>'name' AND n IS NOT NULL;
    v_out := v_out || jsonb_build_array(v_tier || jsonb_build_object('key', v_new->i->>'ident', 'previous_names', v_prev));
  END LOOP;

  -- Rule 4: no NEW duplicate names (legacy duplicates may stay).
  SELECT n.name INTO v_clash
    FROM (SELECT x->>'name' AS name, count(*) AS c FROM jsonb_array_elements(v_out) x
           WHERE jsonb_typeof(x) = 'object' GROUP BY 1) n
   WHERE n.c > 1
     AND n.c > (SELECT count(*) FROM jsonb_array_elements(v_old_tiers) o WHERE o->>'name' = n.name)
   LIMIT 1;
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'Two ticket types can''t both be called "%". Choose a different name.', v_clash;
  END IF;

  -- 0229's rule: a renamed tier's names may not overlap another tier's names.
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

  -- Rule 3: a name that tickets or open orders were bought under belongs to
  -- the tier that had it; no other tier (new, or after a delete) may take it.
  IF TG_OP = 'UPDATE' THEN
    FOR i IN 0 .. jsonb_array_length(v_new) - 1 LOOP
      CONTINUE WHEN (v_new->i->>'scalar') IS NOT NULL;
      FOR v_name IN SELECT jsonb_array_elements_text(v_out->i->'previous_names') UNION SELECT v_out->i->>'name' LOOP
        CONTINUE WHEN v_name IS NULL;
        -- Already this tier's name before this save: nothing changes.
        CONTINUE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_old_tiers) o
                               WHERE o->>'ident' = v_new->i->>'ident' AND o->'names' ? v_name);
        IF EXISTS (SELECT 1 FROM public.tickets t WHERE t.event_id = NEW.id AND t.ticket_type = v_name)
           OR EXISTS (SELECT 1 FROM public.pending_purchases pp
                       WHERE pp.event_id = NEW.id AND pp.status = 'pending' AND pp.ticket_type = v_name) THEN
          SELECT o->>'name' INTO v_owner FROM jsonb_array_elements(v_old_tiers) o WHERE o->'names' ? v_name LIMIT 1;
          RAISE EXCEPTION 'Tickets were already sold under the name "%" for %. A different ticket type can''t use that name; choose another name.',
            v_name, COALESCE('the ticket type "' || v_owner || '"', 'a ticket type that was removed');
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  NEW.ticket_types := v_out;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.events_ticket_tier_identity() FROM PUBLIC, anon, authenticated;

COMMIT;
