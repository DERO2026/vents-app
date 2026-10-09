-- Audit finding F23 (MASTER_AUDIT.md). NOT YET APPLIED TO PRODUCTION --
-- drafted for review, pending explicit authorization.
--
-- list_service_provider_capability_desync() (migration 0053) is LANGUAGE sql
-- with no internal role check at all. Confirmed live:
-- has_function_privilege('authenticated', 'list_service_provider_capability_
-- desync()', 'EXECUTE') = true -- any logged-in user, not just an admin, can
-- call it. It reveals which accounts have an approved service-provider
-- request but a desynced is_service_provider flag (other users' request
-- status/approval timestamps) -- low severity (read-only, no money
-- movement, normally an empty result in steady state), but still a real
-- authorization gap: its own sibling, backfill_service_provider_capability_
-- desync() (the apply side), correctly checks is_admin() internally; only
-- the read-only list side was ever missing the equivalent check.
--
-- No legitimate call site in src/ or api/ calls this function at all -- it
-- exists purely as an admin-operated dry-run tool (per its own 0053 header
-- comment: "Run this first and review the output before calling the apply
-- function below"), invoked ad hoc via direct RPC call during an incident
-- investigation, not through any Admin Console screen. So gating it server-
-- side cannot break any existing UI workflow -- confirmed by grep: zero
-- call sites anywhere in the app.
--
-- Fix: match the sibling apply function's own is_admin() gate exactly,
-- same level this codebase already uses for every other is_admin()-gated
-- list_*/admin_list_* RPC (e.g. admin_list_organizer_verifications,
-- admin_list_service_bookings). Converts LANGUAGE sql -> LANGUAGE plpgsql
-- (required to express the IF/RAISE check), with the same RETURN QUERY
-- restructuring already used in this audit's own corrected F21 draft
-- (0172's list_vc_to_wallet_pool_backfill_candidates()). The underlying
-- query itself -- which rows count as desynced -- is completely unchanged.
CREATE OR REPLACE FUNCTION public.list_service_provider_capability_desync()
 RETURNS TABLE(user_id uuid, request_id uuid, request_status text, is_service_provider boolean, approved_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT u.id, r.id, r.status, u.is_service_provider, r.reviewed_at
  FROM public.service_provider_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE r.status = 'approved' AND u.is_service_provider = false;
END;
$function$;
