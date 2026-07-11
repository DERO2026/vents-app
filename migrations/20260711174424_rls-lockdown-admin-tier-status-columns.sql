-- CRITICAL SECURITY FIX — Root/Admin-tier hijack prevention.
--
-- The users table's admin_update_users RLS policy only gates on the
-- CALLER being admin-tier (is_admin()), with no restriction on the TARGET
-- row — so a Sub-Admin could suspend, ban, or soft-delete Root or another
-- Admin via a plain PATCH, since only the `role` column was ever protected
-- (check_user_role_update / lock_admin_root_role triggers).
--
-- RLS policies can't express "reject only if these specific columns
-- changed" (WITH CHECK only sees the proposed NEW row, not an OLD-vs-NEW
-- diff) — a BEFORE UPDATE trigger is the correct, standard Postgres tool
-- for that, and this project already uses exactly that pattern on this
-- same table (check_user_role_update, lock_admin_root_role) for the same
-- kind of column-specific protection. This trigger is enforced at the
-- database layer unconditionally — no UI path can route around it.

CREATE OR REPLACE FUNCTION public.protect_admin_tier_status_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
BEGIN
  -- SECURITY DEFINER RPCs run as their owner (not 'authenticated'), so they
  -- bypass this check — mirrors check_user_role_update's existing convention.
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  -- Root's status/banned_until/deleted_at can never be touched by anyone
  -- via a direct table update, full stop.
  IF OLD.id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root account status cannot be modified';
  END IF;

  -- Sub-Admins cannot touch status/banned_until/deleted_at on any
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

-- Column-scoped trigger: only fires when an UPDATE statement actually
-- targets status/banned_until/deleted_at, so it can't interfere with any
-- other column update (e.g. avatar_url, bio, interests) on any account.
CREATE TRIGGER trg_protect_admin_tier_status_columns
  BEFORE UPDATE OF status, banned_until, deleted_at ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_admin_tier_status_columns();
