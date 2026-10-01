-- Authentication end-to-end reconciliation audit: user deletion /
-- re-registration gaps.
--
-- FINDING 1 (CRITICAL, live-proven): neither delete_own_account nor
-- admin_soft_delete_user cleared is_organizer/is_service_provider. A
-- still-valid session token (issued before deletion, not yet expired) for
-- a deleted account retained full organizer/provider capability for the
-- remainder of its lifetime. Live-verified against a real production
-- account (in a rolled-back transaction, no residue): pre-fix, the same
-- still-authenticated session could insert a live, ticket-sellable event
-- after delete_own_account() had already run, because the events RLS
-- policy checks is_organizer() (which only reads the capability flag),
-- not deletion status. Separately, a genuinely stale deleted account
-- already live in production (deleted well before this fix, via a path
-- that predates it) was found with is_organizer still true and its
-- original email still unmasked -- real evidence the gap was not merely
-- theoretical. Fixed by clearing both capability flags as part of
-- deletion in both paths. Post-fix, the identical event insert attempt on
-- the same now-deleted session fails with "new row violates row-level
-- security policy for table events".
--
-- FINDING 2: admin_soft_delete_user never rewrote auth.users.email or
-- public.users.email the way delete_own_account does -- an admin-deleted
-- user's original email stayed on both rows (masked only in the UI, not
-- released), so that email could NOT be reused to create a genuinely new
-- account after an admin deletion, inconsistent with self-deletion and
-- with the product requirement that a deleted user's email must be able
-- to register again. Fixed by applying the same email-release treatment
-- delete_own_account already uses. Live-verified post-fix: both the
-- public.users row and the auth.users row show the masked
-- "deleted_<uid>@deleted.vents" address after admin_soft_delete_user runs.
--
-- Also added SET search_path TO '' to admin_soft_delete_user, which was
-- missing it -- every other SECURITY DEFINER function in this codebase
-- pins it; defense-in-depth hygiene, not a proven exploit.
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
    status             = 'deleted',
    deleted_at         = now(),
    original_email     = email,
    email              = 'deleted_' || v_uid || '@deleted.vents',
    username           = 'deleted_' || left(v_uid::text, 8),
    full_name          = NULL,
    avatar_url         = NULL,
    cover_url          = NULL,
    bio                = NULL,
    phone_number       = NULL,
    is_organizer       = false,
    is_service_provider = false
  WHERE id = v_uid;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (v_uid, 'account_deleted', v_uid, jsonb_build_object('deleted_at', now(), 'wallet_at_deletion', v_wallet_note));

  UPDATE auth.users
  SET email = 'deleted_' || v_uid || '@deleted.vents', updated_at = now()
  WHERE id = v_uid;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_soft_delete_user(p_user_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user RECORD;
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN RAISE EXCEPTION 'Root account cannot be deleted'; END IF;
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot delete your own account this way — use Settings > Delete Account instead'; END IF;

  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF v_user.status = 'deleted' THEN RAISE EXCEPTION 'Account already deleted'; END IF;

  IF v_user.email IS NOT NULL AND v_user.email <> '' THEN
    INSERT INTO public.deleted_emails (email) VALUES (lower(trim(v_user.email))) ON CONFLICT DO NOTHING;
  END IF;
  IF v_user.phone_number IS NOT NULL AND trim(v_user.phone_number) <> '' THEN
    INSERT INTO public.deleted_phones (phone) VALUES (trim(v_user.phone_number)) ON CONFLICT DO NOTHING;
  END IF;

  UPDATE public.users SET
    status              = 'deleted',
    deleted_at          = now(),
    deleted_by          = auth.uid(),
    reason              = p_reason,
    original_email      = email,
    email               = 'deleted_' || p_user_id || '@deleted.vents',
    username            = 'deleted_' || left(p_user_id::text, 8),
    phone_number        = NULL,
    is_organizer        = false,
    is_service_provider = false
  WHERE id = p_user_id;

  UPDATE auth.users
  SET email = 'deleted_' || p_user_id || '@deleted.vents', updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'delete_user', p_user_id, jsonb_build_object('reason', p_reason), public.actor_role());
END;
$function$;
