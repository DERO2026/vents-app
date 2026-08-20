-- Fix: delete_own_account() referenced referred_emails.referred_by and
-- referred_emails.email, neither of which exist (real columns are
-- email_hash, referrer_id, created_at). This meant account deletion threw
-- 'column "referred_by" does not exist' and failed outright for every
-- single user -- discovered incidentally while verifying the username
-- immutability trigger (0028), unrelated to it, but confirmed as a
-- genuine, currently-live production bug via the same test pass.
--
-- referrer_id is the correct replacement for "rows where this user was
-- the referrer". The "OR email = v_user.email" half can't be faithfully
-- reproduced here -- referred_emails only ever stores a hash of the
-- referred email (email_hash), computed client-side, and this function
-- has no access to that hashing algorithm to recompute it from
-- v_user.email. Dropped rather than left broken or guessed at; the
-- referrer_id cleanup (the half that matters for "did I use my referral
-- slots" bookkeeping) is preserved.
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
END; $function$
;
