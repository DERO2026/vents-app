-- delete_own_account() never cleared device_push_tokens, follows, or
-- conversation_clears — since the users row is anonymized in place (never
-- actually DELETEd), the ON DELETE CASCADE FKs on those tables never fire,
-- so this data survives "deletion" untouched. The push-token gap is the
-- serious one: a deleted account's device kept receiving push notifications
-- indefinitely. The other two are just stale rows (follower lists still
-- listing the anonymized account, per-user chat-clear markers).
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

  -- Block re-signup with same email / phone
  IF v_user.email IS NOT NULL AND v_user.email <> '' THEN
    INSERT INTO public.deleted_emails (email) VALUES (lower(trim(v_user.email))) ON CONFLICT DO NOTHING;
  END IF;
  IF v_user.phone_number IS NOT NULL AND trim(v_user.phone_number) <> '' THEN
    INSERT INTO public.deleted_phones (phone) VALUES (trim(v_user.phone_number)) ON CONFLICT DO NOTHING;
  END IF;

  -- Tickets: cancel pending, leave active/used/cancelled as-is
  UPDATE public.tickets SET status = 'cancelled'
  WHERE user_id = v_uid AND status NOT IN ('active', 'used', 'cancelled');

  -- Social graph
  DELETE FROM public.blocked_users WHERE blocker_id = v_uid OR blocked_id = v_uid;
  DELETE FROM public.follows WHERE follower_id = v_uid OR following_id = v_uid;

  -- Messaging
  DELETE FROM public.direct_messages WHERE sender_id = v_uid OR recipient_id = v_uid;
  DELETE FROM public.conversation_clears WHERE user_id = v_uid OR other_user_id = v_uid;

  -- Device push tokens — stop notifications from reaching this account's
  -- devices immediately. Without this a "deleted" account kept getting
  -- pushed to indefinitely.
  DELETE FROM public.device_push_tokens WHERE user_id = v_uid;

  -- Highlights
  DELETE FROM public.highlights WHERE user_id = v_uid;

  -- Reviews
  DELETE FROM public.organizer_reviews WHERE reviewer_id = v_uid OR organizer_id = v_uid;

  -- Reports
  DELETE FROM public.reports WHERE reporter_id = v_uid;

  -- Vents Cents transactions
  DELETE FROM public.vc_transactions WHERE user_id = v_uid;

  -- Notifications
  DELETE FROM public.notifications WHERE user_id = v_uid;

  -- Saved events
  DELETE FROM public.saved_events WHERE user_id = v_uid;

  -- Wallet & financial records: KEPT, not deleted (same rationale as ticket
  -- retention above) — deleting these either crashed on the
  -- organizer_withdrawal_requests -> organizer_bank_accounts FK, or
  -- silently destroyed a real balance_kobo with no payout. If there was an
  -- unclaimed balance, note it on the audit log so support can follow up.
  SELECT jsonb_build_object('balance_kobo', balance_kobo, 'pending_kobo', pending_kobo)
    INTO v_wallet_note
  FROM public.organizer_wallets WHERE organizer_id = v_uid;

  -- Referral emails
  DELETE FROM public.referred_emails WHERE referred_by = v_uid OR email = v_user.email;

  -- Anonymize the public profile
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

  -- Audit log
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (v_uid, 'account_deleted', v_uid, jsonb_build_object('deleted_at', now(), 'wallet_at_deletion', v_wallet_note));

  -- Anonymize auth identity so login with original email fails
  UPDATE auth.users
  SET email = 'deleted_' || v_uid || '@deleted.vents', updated_at = now()
  WHERE id = v_uid;
END; $function$;
