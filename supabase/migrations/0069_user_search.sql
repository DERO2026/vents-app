-- search_users_for_request: powers a proper search/autocomplete experience
-- for "Someone Else Pays" (CheckoutScreen.tsx) and Ticket Transfer
-- (MyTicketsScreen.tsx), both of which previously only accepted a raw,
-- typed-blind email/username with no feedback until final submit.
--
-- public.users has NO public read policy (0008_rls_and_policies.sql:
-- select_own_user is own-row-only, admin_select_users is admin-only) --
-- there is no existing "browse other users" path for a regular
-- authenticated user, by design. This function is therefore the one
-- narrow, deliberate hole in that: SECURITY DEFINER, authenticated-only,
-- rate-limited, a minimum query length to prevent trivial enumeration by
-- iterating single characters, capped result count, and returns ONLY
-- id/username/full_name/avatar_url -- never email, phone, or any other
-- field, even though matching happens against email/username server-side.
-- This mirrors the exact same email-OR-username matching
-- create_pending_purchase/initiate_ticket_transfer already do for the
-- final resolved identifier -- this function only ever feeds the same
-- kind of client-visible existence signal one keystroke earlier, nothing
-- a determined caller couldn't already get one exact guess at a time from
-- the existing "payer not found" flow.
CREATE OR REPLACE FUNCTION public.search_users_for_request(p_query text)
 RETURNS TABLE(id uuid, username text, full_name text, avatar_url text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_query text := NULLIF(trim(p_query), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Too short to search yet -- an empty result, not an error, so the
  -- client can just render "keep typing" rather than handle a thrown
  -- exception for normal incremental typing.
  IF v_query IS NULL OR length(v_query) < 2 THEN
    RETURN;
  END IF;

  PERFORM public.check_rate_limit('search_users:' || v_uid::text, 30, 60);

  RETURN QUERY
  SELECT u.id, u.username, u.full_name, u.avatar_url
    FROM public.users u
   WHERE u.deleted_at IS NULL
     AND u.id <> v_uid
     AND u.username IS NOT NULL
     AND (u.username ILIKE v_query || '%' OR u.email ILIKE v_query || '%')
   ORDER BY (u.username ILIKE v_query || '%') DESC, u.username NULLS LAST
   LIMIT 8;
END;
$function$
;

REVOKE ALL ON FUNCTION public.search_users_for_request(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_users_for_request(text) TO authenticated;
