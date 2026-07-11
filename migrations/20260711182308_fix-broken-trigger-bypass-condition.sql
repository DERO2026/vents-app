-- CRITICAL FIX — protect_admin_tier_status_columns was a complete no-op.
--
-- Live re-verification (signed in as the real Sub-Admin account and
-- attempting to suspend Root) proved the trigger never actually blocked
-- anything: the previous version copied the "IF current_user <> 'authenticated'
-- THEN RETURN NEW" bypass convention from the pre-existing
-- check_user_role_update trigger, assuming InsForge switches to a Postgres
-- role literally named 'authenticated' for end-user requests (the
-- Supabase convention this pattern was written for). It does not — InsForge
-- runs all queries, authenticated or not, as a single shared role
-- ('project_admin' in this project), and identifies the caller purely via
-- auth.uid(). So current_user was NEVER 'authenticated', the bypass always
-- fired, and the trigger always let every update through.
--
-- (The pre-existing check_user_role_update trigger has this exact same
-- flaw and is therefore also a no-op — but that one was never load-bearing:
-- admin_set_user_role's own internal is_admin()/ROOT_UID/target-role checks
-- are the real protection for role changes, so its trigger being a no-op
-- doesn't reopen a vulnerability. This new trigger had no such RPC-level
-- backstop — status/ban/delete/reinstate all go through raw client-side
-- table updates — so its bypass being broken meant zero protection.)
--
-- Fix: replace the broken bypass with one that actually reflects how this
-- backend works — allow a user to act on their OWN row (auth.uid() = OLD.id,
-- needed so delete_own_account's self-service status/deleted_at update
-- keeps working), and otherwise always enforce the Root/Sub-Admin checks
-- unconditionally.

CREATE OR REPLACE FUNCTION public.protect_admin_tier_status_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
BEGIN
  -- Acting on your own account is always allowed — this trigger exists to
  -- stop OTHERS from altering a Root/Admin-tier account, not to restrict
  -- self-service actions like delete_own_account.
  IF auth.uid() IS NOT NULL AND OLD.id = auth.uid() THEN
    RETURN NEW;
  END IF;

  -- Root's status/banned_until/deleted_at can never be touched by anyone
  -- else, full stop.
  IF OLD.id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root account status cannot be modified';
  END IF;

  -- Sub-Admins cannot touch status/banned_until/deleted_at on any OTHER
  -- Admin/Sub-Admin-tier account. Full Admins/Root retain this ability.
  IF OLD.role IN ('admin', 'sub-admin') THEN
    SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();
    IF v_caller_role = 'sub-admin' THEN
      RAISE EXCEPTION 'Sub-Admins cannot modify status of Admin/Sub-Admin accounts';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
