CREATE OR REPLACE FUNCTION public.delete_own_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_user RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_user FROM users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF v_user.status = 'deleted' THEN RAISE EXCEPTION 'Account already deleted'; END IF;

  -- Block re-signup with same email / phone
  IF v_user.email IS NOT NULL AND v_user.email <> '' THEN
    INSERT INTO deleted_emails (email) VALUES (lower(trim(v_user.email))) ON CONFLICT DO NOTHING;
  END IF;
  IF v_user.phone_number IS NOT NULL AND trim(v_user.phone_number) <> '' THEN
    INSERT INTO deleted_phones (phone) VALUES (trim(v_user.phone_number)) ON CONFLICT DO NOTHING;
  END IF;

  -- Tickets: cancel pending, leave active/used/cancelled as-is
  UPDATE tickets SET status = 'cancelled'
  WHERE user_id = v_uid AND status NOT IN ('active', 'used', 'cancelled');

  -- Social graph
  DELETE FROM follows WHERE follower_id = v_uid OR following_id = v_uid;

  -- Messaging
  DELETE FROM direct_messages WHERE sender_id = v_uid OR recipient_id = v_uid;

  -- Highlights
  DELETE FROM highlights WHERE user_id = v_uid;

  -- Reviews
  DELETE FROM organizer_reviews WHERE reviewer_id = v_uid OR organizer_id = v_uid;

  -- Reports
  DELETE FROM reports WHERE reporter_id = v_uid;

  -- Vents Cents transactions
  DELETE FROM vc_transactions WHERE user_id = v_uid;

  -- Notifications
  DELETE FROM notifications WHERE user_id = v_uid;

  -- Saved events
  DELETE FROM event_saves WHERE user_id = v_uid;

  -- Wallet & financial records
  DELETE FROM organizer_wallets WHERE organizer_id = v_uid;
  DELETE FROM organizer_transactions WHERE organizer_id = v_uid;
  DELETE FROM organizer_bank_accounts WHERE organizer_id = v_uid;

  -- Prize draw entries
  DELETE FROM prize_draw_entries WHERE user_id = v_uid;

  -- Referral emails
  DELETE FROM referred_emails WHERE referred_by = v_uid OR email = v_user.email;

  -- Anonymize the public profile
  UPDATE users SET
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
  INSERT INTO admin_logs (admin_id, action, target_user_id, details)
  VALUES (v_uid, 'account_deleted', v_uid, jsonb_build_object('deleted_at', now()));

  -- Anonymize auth identity so login with original email fails
  UPDATE auth.users
  SET email = 'deleted_' || v_uid || '@deleted.vents', updated_at = now()
  WHERE id = v_uid;
END;
$$;
