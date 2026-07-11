-- Server Health Ping: a lightweight admin-gated diagnostic RPC. Round-trips
-- through the same SECURITY DEFINER / RLS pipeline every other admin action
-- uses, so a successful call proves auth, the DB connection, and is_admin()
-- gating are all healthy — not just that Postgres is up.
CREATE OR REPLACE FUNCTION public.admin_health_ping()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_count bigint;
  v_event_count bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT count(*) INTO v_user_count FROM public.users;
  SELECT count(*) INTO v_event_count FROM public.events;

  RETURN jsonb_build_object(
    'status', 'ok',
    'server_time', now(),
    'users_reachable', v_user_count,
    'events_reachable', v_event_count
  );
END;
$function$;
