-- Enforce username immutability at the database level.
--
-- Every path that can currently write to users.username was audited:
--   - handle_new_user() trigger (0025) -- sets it once at signup, from
--     auth.users.raw_user_meta_data, via INSERT (not UPDATE, so this
--     trigger never applies to it).
--   - AuthScreen.tsx's post-confirmation completion writes
--     (fetchProfileAndSucceed, the pending-verification fallback, and
--     App.tsx's hydrateAuth orphaned-profile recovery) -- these are the
--     legitimate "finish setting up the account" writes and must keep
--     working; they only ever set username from NULL/unset, or re-send
--     the same value the row already has.
--   - SettingsScreen.tsx's Profile Details "Save" -- lets an authenticated
--     user change username to any new available value at any time. This
--     is the actual gap: frontend-only, nothing stops the same request
--     being replayed directly against the Data API.
--   - delete_own_account() (0004_functions.sql) -- SECURITY DEFINER,
--     renames username to 'deleted_<uid>' as part of account deletion.
--     Must keep working.
--
-- Mirrors the existing check_user_role_update() pattern exactly: blocks
-- direct changes from the 'authenticated' role, but SECURITY DEFINER
-- functions (which run as their owner, not 'authenticated') bypass it --
-- so delete_own_account()'s rename is unaffected. The OLD.username IS
-- NULL exception is what keeps initial signup completion working: a
-- brand-new row (or one where migration 0025's uniqueness-collision
-- fallback left username unset) can still have it set for the first
-- time; only an actual change to an already-set username is blocked.
CREATE OR REPLACE FUNCTION public.check_username_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.username IS NOT NULL AND OLD.username IS DISTINCT FROM NEW.username THEN
    RAISE EXCEPTION 'Username cannot be changed after it has been set';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE TRIGGER trg_check_username_update BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION check_username_immutable();
