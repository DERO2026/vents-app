-- Fix confirmed production issue: a suspended/banned/soft-deleted user could
-- reinstate themselves via a direct client-side UPDATE on public.users,
-- because protect_admin_tier_status_columns() unconditionally returned NEW
-- for any self-targeted update (`OLD.id = auth.uid()`), before the
-- status/banned_until/deleted_at columns were even inspected. The
-- update_own_user RLS policy (`auth.uid() = id`) has no column allow-list,
-- so nothing else stood between a banned account and un-banning itself:
--
--   supabase.from('users').update({ status: 'active', banned_until: null }).eq('id', myId)
--
-- would satisfy RLS, hit this trigger, and immediately RETURN NEW before the
-- root-account check, the sub-admin block, or the audit-log insert ever ran.
-- This defeated admin_suspend_user/admin_soft_delete_user entirely, with no
-- admin_logs trail, since a self-targeted call skipped the logging branch too.
--
-- The self-exemption existed for exactly one legitimate reason:
-- delete_own_account() (0004_functions.sql) is itself a self-targeted
-- UPDATE on these same columns (status='deleted', deleted_at=now()), run as
-- SECURITY DEFINER but still with auth.uid() = the caller's own id, so it
-- needed the trigger to let its own update through.
--
-- Fix: narrow the self-exemption from "any self-targeted update" to "the
-- exact transition delete_own_account() performs, and only when
-- delete_own_account() itself signals it via a transaction-local flag".
-- Every other self-targeted attempt to change status/banned_until/
-- deleted_at/deleted_by/reason -- in particular a banned user trying to
-- reinstate themselves -- is now rejected outright. Ordinary self-service
-- profile updates (name, avatar, bio, phone, email, etc.) that touch none
-- of these columns are unaffected, and every existing admin moderation path
-- (admin_suspend_user, admin_unsuspend_user, admin_soft_delete_user,
-- admin_reinstate_user) is untouched since none of them target their own
-- account (they already self-block at the RPC level) and none of this
-- logic changed for the non-self branch.

CREATE OR REPLACE FUNCTION public.protect_admin_tier_status_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
  v_action text;
BEGIN
  -- No moderation-controlled column is actually changing: ordinary
  -- self-service profile updates always pass through untouched, self or
  -- otherwise -- this trigger has nothing to say about them.
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.banned_until IS NOT DISTINCT FROM OLD.banned_until
     AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
     AND NEW.deleted_by IS NOT DISTINCT FROM OLD.deleted_by
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason THEN
    RETURN NEW;
  END IF;

  IF OLD.id = auth.uid() THEN
    -- The ONLY legitimate self-service transition touching these columns
    -- is delete_own_account()'s own status='deleted' + deleted_at=now()
    -- update, which sets this transaction-local flag immediately before
    -- performing it. Anything else self-targeted that touches these
    -- columns -- including a suspended/banned/deleted user trying to
    -- reinstate themselves -- is rejected.
    IF current_setting('vents.self_delete_in_progress', true) = 'true'
       AND NEW.status = 'deleted'
       AND NEW.deleted_at IS NOT NULL
       AND NEW.banned_until IS NOT DISTINCT FROM OLD.banned_until
       AND NEW.deleted_by IS NOT DISTINCT FROM OLD.deleted_by THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'You cannot change your own account status, ban, or deletion state directly';
  END IF;

  -- Root's status/banned_until/deleted_at can never be touched by anyone
  -- else, full stop.
  IF OLD.id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root account status cannot be modified';
  END IF;

  SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();

  -- Banning/suspending/deleting/restoring ANY account (not just other
  -- Admin/Sub-Admin accounts) is a Super Admin action.
  IF v_caller_role = 'sub-admin' THEN
    RAISE EXCEPTION 'Sub-Admins cannot modify account status — Super Admin (Admin/Root) required';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_action := CASE
      WHEN NEW.banned_until IS DISTINCT FROM OLD.banned_until AND NEW.banned_until IS NOT NULL THEN 'ban_user'
      WHEN NEW.banned_until IS DISTINCT FROM OLD.banned_until AND NEW.banned_until IS NULL THEN 'unban_user'
      WHEN NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN 'delete_user'
      WHEN NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NULL THEN 'restore_user'
      WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'status_change'
      ELSE NULL
    END;

    IF v_action IS NOT NULL THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), v_action, OLD.id,
        jsonb_build_object(
          'old_status', OLD.status, 'new_status', NEW.status,
          'old_banned_until', OLD.banned_until, 'new_banned_until', NEW.banned_until
        ),
        public.actor_role()
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Signal the one legitimate self-service transition to the trigger above.
-- set_config(..., true) is transaction-local: it can never leak into a
-- later, unrelated statement on a pooled connection.
CREATE OR REPLACE FUNCTION public.delete_own_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_user RECORD;
  v_wallet_note jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_user FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF v_user.status = 'deleted' THEN RAISE EXCEPTION 'Account already deleted'; END IF;

  IF v_user.email IS NOT NULL AND v_user.email <> '' THEN
    INSERT INTO public.deleted_emails (email) VALUES (lower(trim(v_user.email))) ON CONFLICT DO NOTHING;
  END IF;
  IF v_user.phone_number IS NOT NULL AND trim(v_user.phone_number) <> '' THEN
    INSERT INTO public.deleted_phones (phone) VALUES (trim(v_user.phone_number)) ON CONFLICT DO NOTHING;
  END IF;

  UPDATE public.tickets SET status = 'cancelled'
  WHERE user_id = v_uid AND status NOT IN ('active', 'used', 'cancelled');

  DELETE FROM public.blocked_users WHERE blocker_id = v_uid OR blocked_id = v_uid;

  DELETE FROM public.direct_messages WHERE sender_id = v_uid OR recipient_id = v_uid;
  DELETE FROM public.conversation_clears WHERE user_id = v_uid OR other_user_id = v_uid;

  DELETE FROM public.device_push_tokens WHERE user_id = v_uid;

  DELETE FROM public.highlights WHERE user_id = v_uid;

  DELETE FROM public.organizer_reviews WHERE reviewer_id = v_uid OR organizer_id = v_uid;

  DELETE FROM public.reports WHERE reporter_id = v_uid;

  DELETE FROM public.vc_transactions WHERE user_id = v_uid;

  DELETE FROM public.notifications WHERE user_id = v_uid;

  DELETE FROM public.saved_events WHERE user_id = v_uid;

  SELECT jsonb_build_object('balance_kobo', balance_kobo, 'pending_kobo', pending_kobo)
    INTO v_wallet_note
  FROM public.organizer_wallets WHERE organizer_id = v_uid;

  DELETE FROM public.referred_emails WHERE referrer_id = v_uid;

  PERFORM set_config('vents.self_delete_in_progress', 'true', true);

  UPDATE public.users SET
    status         = 'deleted',
    deleted_at     = now(),
    original_email = email,
    email          = 'deleted_' || v_uid || '@deleted.vents',
    username       = 'deleted_' || left(v_uid::text, 8),
    full_name      = NULL,
    avatar_url     = NULL,
    cover_url      = NULL,
    bio            = NULL,
    phone_number   = NULL
  WHERE id = v_uid;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (v_uid, 'account_deleted', v_uid, jsonb_build_object('deleted_at', now(), 'wallet_at_deletion', v_wallet_note));

  UPDATE auth.users
  SET email = 'deleted_' || v_uid || '@deleted.vents', updated_at = now()
  WHERE id = v_uid;
END; $function$;
