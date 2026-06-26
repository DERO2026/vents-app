CREATE TABLE IF NOT EXISTS organizer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note text,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organizer_requests ENABLE ROW LEVEL SECURITY;

-- Users can view and insert their own requests
CREATE POLICY organizer_requests_select_own
  ON organizer_requests FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY organizer_requests_insert_own
  ON organizer_requests FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Admins can see and update all requests
CREATE POLICY organizer_requests_admin_select
  ON organizer_requests FOR SELECT TO authenticated
  USING (is_admin());

CREATE POLICY organizer_requests_admin_update
  ON organizer_requests FOR UPDATE TO authenticated
  USING (is_admin());

GRANT SELECT, INSERT ON organizer_requests TO authenticated;
GRANT UPDATE ON organizer_requests TO authenticated;
