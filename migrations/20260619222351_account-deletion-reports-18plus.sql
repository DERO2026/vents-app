-- ═══════════════════════════════════════════════════════
-- Section 2: Account deletion (Apple/Google requirement)
-- ═══════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS original_email text;

CREATE TABLE IF NOT EXISTS deleted_emails (
  email      text PRIMARY KEY,
  deleted_at timestamptz DEFAULT now()
);
GRANT SELECT ON deleted_emails TO authenticated, anon;

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

  IF v_user.email IS NOT NULL AND v_user.email <> '' THEN
    INSERT INTO deleted_emails (email) VALUES (lower(trim(v_user.email))) ON CONFLICT DO NOTHING;
  END IF;

  UPDATE tickets SET status = 'cancelled'
  WHERE user_id = v_uid AND status NOT IN ('active', 'used', 'cancelled');

  UPDATE users SET
    status        = 'deleted',
    deleted_at    = now(),
    original_email = email,
    email         = 'deleted_' || v_uid || '@deleted.vents',
    username      = 'deleted_' || left(v_uid::text, 8),
    full_name     = NULL,
    avatar_url    = NULL,
    cover_url     = NULL,
    bio           = NULL,
    phone_number  = NULL
  WHERE id = v_uid;

  INSERT INTO admin_logs (admin_id, action, target_user_id, details)
  VALUES (v_uid, 'account_deleted', v_uid, jsonb_build_object('deleted_at', now()));
END;
$$;

GRANT EXECUTE ON FUNCTION delete_own_account() TO authenticated;

-- ═══════════════════════════════════════════════════════
-- Section 3: Content reporting (Apple UGC requirement)
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('event', 'user')),
  target_id   uuid NOT NULL,
  reason      text NOT NULL CHECK (char_length(trim(reason)) > 0),
  details     text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reports_insert" ON reports FOR INSERT WITH CHECK (auth.uid() = reporter_id);
CREATE POLICY "reports_select_own" ON reports FOR SELECT USING (auth.uid() = reporter_id);
CREATE POLICY "reports_admin_all" ON reports FOR ALL USING (
  EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND (role = 'admin' OR id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'))
);

GRANT INSERT, SELECT ON reports TO authenticated;

CREATE INDEX IF NOT EXISTS reports_reporter_idx ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS reports_target_idx   ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS reports_status_idx   ON reports(status);

-- ═══════════════════════════════════════════════════════
-- Section 6d: 18+ event field
-- ═══════════════════════════════════════════════════════
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_18_plus boolean NOT NULL DEFAULT false;
