-- Undo 0229 (ticket tier rename). Gated: run with
--   SET vents.rollback_confirm = 'undo-0229';
-- Reverses each in-place patch exactly (every [0229] replacement back to the
-- original text; refuses if a function no longer carries it), then drops the
-- tier-identity trigger and the helpers. Event ticket_types keep any `key` /
-- `previous_names` values (the pre-0229 code ignores them; no data is
-- rewritten). WARNING: after undo, tickets sold under a tier's earlier name
-- no longer count toward that tier (a renamed tier could oversell), and an
-- order in checkout under an old name fails to finalize. Revert the client
-- (CreateEventScreen) first.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0229' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0229'' first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.vents_undo_0229(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION 'undo_0229: % does not carry 0229 patch % exactly once; refusing', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END;
$h$;

SELECT pg_temp.vents_undo_0229('public.purchase_ticket(uuid,text,jsonb,text,text)', ARRAY[
  ARRAY[$a$    FROM (SELECT public.ticket_tier_find(v_event.ticket_types, p_ticket_type) AS tt) AS found  -- [0229] current or previous name
    WHERE tt IS NOT NULL
    LIMIT 1;$a$, $a$    FROM jsonb_array_elements(v_event.ticket_types) AS tt
    WHERE tt->>'name' = p_ticket_type
    LIMIT 1;$a$],
  ARRAY[$a$      WHERE event_id = p_event_id AND ticket_type = ANY (public.ticket_tier_names(v_event.ticket_types, p_ticket_type)) AND status = 'active';$a$, $a$      WHERE event_id = p_event_id AND ticket_type = p_ticket_type AND status = 'active';$a$]
]);

SELECT pg_temp.vents_undo_0229('public.create_pending_purchase(uuid,text,jsonb,text,text)', ARRAY[
  ARRAY[$a$    FROM (SELECT public.ticket_tier_find(v_event.ticket_types, p_ticket_type) AS tt) AS found  -- [0229] current or previous name
    WHERE tt IS NOT NULL
    LIMIT 1;$a$, $a$    FROM jsonb_array_elements(v_event.ticket_types) AS tt
    WHERE tt->>'name' = p_ticket_type
    LIMIT 1;$a$],
  ARRAY[$a$   WHERE user_id = v_user_id AND event_id = p_event_id AND ticket_type = ANY (public.ticket_tier_names(v_event.ticket_types, p_ticket_type))$a$, $a$   WHERE user_id = v_user_id AND event_id = p_event_id AND ticket_type = p_ticket_type$a$]
]);

SELECT pg_temp.vents_undo_0229('public.finalize_pending_purchase(text)', ARRAY[
  ARRAY[$a$      FROM (SELECT public.ticket_tier_find(v_event.ticket_types, v_row.ticket_type) AS tt) AS found  -- [0229] current or previous name
      WHERE tt IS NOT NULL
      LIMIT 1;$a$, $a$      FROM jsonb_array_elements(v_event.ticket_types) AS tt
      WHERE tt->>'name' = v_row.ticket_type
      LIMIT 1;$a$],
  ARRAY[$a$        WHERE event_id = v_row.event_id AND ticket_type = ANY (public.ticket_tier_names(v_event.ticket_types, v_row.ticket_type)) AND status = 'active';$a$, $a$        WHERE event_id = v_row.event_id AND ticket_type = v_row.ticket_type AND status = 'active';$a$]
]);

SELECT pg_temp.vents_undo_0229('public.get_event_ticket_type_availability(uuid)', ARRAY[
  ARRAY[$a$  sold AS (
    -- [0229] Tickets sold under a tier's earlier names count toward it,
    -- reported under its current name.
    SELECT public.ticket_tier_current_name(ev.tiers, t.ticket_type) AS ticket_type, count(*)::integer AS n
      FROM public.tickets t CROSS JOIN ev
     WHERE t.event_id = p_event_id AND t.status = 'active'
     GROUP BY 1
  ),$a$, $a$  sold AS (
    SELECT t.ticket_type, count(*)::integer AS n
      FROM public.tickets t
     WHERE t.event_id = p_event_id AND t.status = 'active'
     GROUP BY t.ticket_type
  ),$a$]
]);

SELECT pg_temp.vents_undo_0229('public.get_event_analytics(uuid)', ARRAY[
  ARRAY[$a$    -- [0229] Reported under the tier's current name; each ticket keeps its own.
    SELECT public.ticket_tier_current_name(v_event.ticket_types, ticket_type) AS ticket_type, count(*)::integer AS sold_count, COALESCE(sum(amount * 100), 0)::bigint AS revenue_kobo
    FROM paid GROUP BY 1$a$, $a$    SELECT ticket_type, count(*)::integer AS sold_count, COALESCE(sum(amount * 100), 0)::bigint AS revenue_kobo
    FROM paid GROUP BY ticket_type$a$],
  ARRAY[$a$    SELECT public.ticket_tier_current_name(v_event.ticket_types, ticket_type) AS ticket_type, count(*)::integer AS reserved_count
    FROM active_any_payment GROUP BY 1$a$, $a$    SELECT ticket_type, count(*)::integer AS reserved_count
    FROM active_any_payment GROUP BY ticket_type$a$]
]);

DROP TRIGGER IF EXISTS trg_events_ticket_tier_identity ON public.events;
DROP FUNCTION IF EXISTS public.events_ticket_tier_identity();
DROP FUNCTION IF EXISTS public.ticket_tier_current_name(jsonb, text);
DROP FUNCTION IF EXISTS public.ticket_tier_names(jsonb, text);
DROP FUNCTION IF EXISTS public.ticket_tier_find(jsonb, text);
COMMIT;
