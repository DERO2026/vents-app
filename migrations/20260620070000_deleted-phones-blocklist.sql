-- deleted_phones blocklist: mirrors deleted_emails for phone-number-based re-signup blocking.
-- delete_own_account() stores the user's phone_number here before anonymizing.
-- AuthScreen checks this table before calling signUp() when phone is provided.

CREATE TABLE IF NOT EXISTS deleted_phones (
  phone      text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- Only service-role / SECURITY DEFINER functions can write; nobody can read their own row
ALTER TABLE deleted_phones ENABLE ROW LEVEL SECURITY;

-- No SELECT policy → authenticated users cannot probe the blocklist
-- INSERT is handled exclusively through SECURITY DEFINER delete_own_account()
-- Deny all direct DML from authenticated / anon roles
REVOKE ALL ON deleted_phones FROM authenticated, anon;

-- Update delete_own_account() to also record phone_number in deleted_phones
CREATE OR REPLACE FUNCTION delete_own_account()
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

  -- Block re-signup with the same email
  IF v_user.email IS NOT NULL AND v_user.email <> '' THEN
    INSERT INTO deleted_emails (email) VALUES (lower(trim(v_user.email))) ON CONFLICT DO NOTHING;
  END IF;

  -- Block re-signup with the same phone number
  IF v_user.phone_number IS NOT NULL AND trim(v_user.phone_number) <> '' THEN
    INSERT INTO deleted_phones (phone) VALUES (trim(v_user.phone_number)) ON CONFLICT DO NOTHING;
  END IF;

  -- Cancel any pending tickets
  UPDATE tickets SET status = 'cancelled'
  WHERE user_id = v_uid AND status NOT IN ('active', 'used', 'cancelled');

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

  -- Write audit log
  INSERT INTO admin_logs (admin_id, action, target_user_id, details)
  VALUES (v_uid, 'account_deleted', v_uid, jsonb_build_object('deleted_at', now()));

  -- Anonymize the auth identity so login with the original email fails at the auth layer
  UPDATE auth.users
  SET email = 'deleted_' || v_uid || '@deleted.vents', updated_at = now()
  WHERE id = v_uid;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_own_account() TO authenticated;
