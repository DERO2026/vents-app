-- ROOT-CAUSE FIX for "new row violates row-level security policy for table
-- service_providers" on Save & Publish, after a full audit (this migration
-- does NOT touch RLS -- service_providers_insert_own/update_own (0034) and
-- their WITH CHECK conditions are untouched and correct; the problem was
-- never the policy).
--
-- ── Audit findings ──────────────────────────────────────────────────────
--
-- 1. Is there a Postgres/application "Service Provider role"? No, and none
--    is needed. 0033_service_provider_capability.sql's own header is
--    explicit: is_service_provider is "deliberately NOT a role" -- a plain
--    boolean capability on users, independent of the role column, so one
--    account can be Organizer (role='organizer') AND Service Provider
--    (is_service_provider=true) simultaneously. That architecture is
--    correct and is kept as-is.
--
-- 2. Source of truth for "can this user write service_providers rows"?
--    users.is_service_provider, checked by service_providers_insert_own /
--    service_providers_update_own (0034): auth.uid() = user_id AND
--    users.is_service_provider = true. This is the one and only gate --
--    correct, unweakened, unchanged here.
--
-- 3. What's supposed to grant the capability after approval?
--    admin_decide_service_provider_request(request_id, status, note)
--    (0044) -- SECURITY DEFINER, gated on is_admin_or_root() (root or
--    role='admin'; note this means a sub-admin cannot approve/reject a
--    Service Provider request today -- a real but separate, non-breaking
--    finding, not touched in this pass). On approval it atomically sets
--    service_provider_requests.status='approved' AND
--    users.is_service_provider=true AND writes the applicant's
--    notification, all in one transaction. This RPC is correct.
--
-- 4. Why did a real Preview account end up with status='approved' and
--    is_service_provider=false? NOT a bug in that RPC, and NOT reachable
--    through the app's own authenticated client: users has its own
--    trg_protect_capability_columns trigger (0033) that RAISES on any
--    attempt to change is_service_provider through a normal `authenticated`
--    -role UPDATE -- only admin_decide_service_provider_request and
--    admin_set_service_provider_capability (both SECURITY DEFINER, so they
--    run as the function owner, not 'authenticated') can move it. What
--    that trigger does NOT protect is service_provider_requests.status
--    itself -- nothing before this migration stopped status from being set
--    to 'approved' by some path OTHER than that one RPC (a raw admin
--    UPDATE via service_provider_requests_admin_update's RLS policy, which
--    exists and permits it; or a direct SQL edit against the row, e.g. a
--    superuser/SQL-editor session, which trg_protect_capability_columns
--    doesn't apply to in the first place since it only fires on the users
--    table). Either way, the RPC being correct was never sufficient on its
--    own -- the invariant "approved ⇒ capability" was only ever true
--    because every caller happened to go through it, not because the
--    database enforced it.
--
-- ── The fix ─────────────────────────────────────────────────────────────
-- Move enforcement from "the one sanctioned RPC also happens to grant it"
-- to a table-level trigger on service_provider_requests itself, so the
-- invariant holds no matter how status ends up 'approved' -- through the
-- RPC (still doing its own explicit grant too; redundant but harmless and
-- idempotent, kept for defense-in-depth/audit-log continuity), through the
-- admin raw-UPDATE RLS path, or through direct SQL. Deliberately
-- one-directional (grants on approval, never auto-revokes on rejection):
-- admin_decide_service_provider_request's own reject branch never touches
-- is_service_provider today, because an already-approved provider
-- resubmitting a new request that later gets rejected must not lose their
-- existing, separately-granted capability. Revocation stays exclusively
-- through admin_set_service_provider_capability(user, false), unchanged.
CREATE OR REPLACE FUNCTION public.sync_service_provider_capability_on_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.status = 'approved' THEN
    UPDATE public.users
       SET is_service_provider = true
     WHERE id = NEW.user_id
       AND is_service_provider = false;
  END IF;
  RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION public.sync_service_provider_capability_on_approval() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.sync_service_provider_capability_on_approval() TO authenticated, project_admin;

DROP TRIGGER IF EXISTS trg_sync_service_provider_capability ON public.service_provider_requests;
CREATE TRIGGER trg_sync_service_provider_capability
  AFTER INSERT OR UPDATE OF status ON public.service_provider_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_service_provider_capability_on_approval();

-- ── Repair path for existing desynced accounts (requirement: show exactly
-- which rows are affected before changing anything; touch only those
-- rows) ────────────────────────────────────────────────────────────────
-- Dry-run: admin-only read of every account currently in the broken state
-- this migration fixes going forward. Run this first.
CREATE OR REPLACE FUNCTION public.list_service_provider_capability_desync()
 RETURNS TABLE(user_id uuid, request_id uuid, request_status text, is_service_provider boolean, approved_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT u.id, r.id, r.status, u.is_service_provider, r.reviewed_at
  FROM public.service_provider_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE r.status = 'approved' AND u.is_service_provider = false;
$function$
;

REVOKE ALL ON FUNCTION public.list_service_provider_capability_desync() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.list_service_provider_capability_desync() TO authenticated, project_admin;

-- The actual repair: grants is_service_provider ONLY to accounts matching
-- the exact same condition listed above -- never a broader sweep, never an
-- unrelated user. Idempotent (safe to run repeatedly; a clean system
-- returns 0 every time after the first run) and logged to admin_logs as
-- one auditable batch action, same convention as every other admin
-- capability change in this codebase.
CREATE OR REPLACE FUNCTION public.backfill_service_provider_capability_desync()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ids uuid[];
  v_count integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT array_agg(u.id) INTO v_ids
  FROM public.service_provider_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE r.status = 'approved' AND u.is_service_provider = false;

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.users
     SET is_service_provider = true
   WHERE id = ANY(v_ids)
     AND is_service_provider = false;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'service_provider_capability_backfill', NULL,
    jsonb_build_object('user_ids', v_ids, 'count', v_count),
    public.actor_role()
  );

  RETURN v_count;
END;
$function$
;

REVOKE ALL ON FUNCTION public.backfill_service_provider_capability_desync() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.backfill_service_provider_capability_desync() TO authenticated, project_admin;
