-- Direct messaging between users (attendees ↔ organizers)
-- The existing 'messages' table is for broadcast/realtime channels, not DMs.

CREATE TABLE IF NOT EXISTS direct_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_id     uuid REFERENCES events(id) ON DELETE SET NULL,
  body         text NOT NULL CHECK (char_length(body) > 0 AND char_length(body) <= 2000),
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dm_sender_idx    ON direct_messages(sender_id,    created_at DESC);
CREATE INDEX IF NOT EXISTS dm_recipient_idx ON direct_messages(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dm_thread_idx    ON direct_messages(
  LEAST(sender_id, recipient_id),
  GREATEST(sender_id, recipient_id),
  created_at DESC
);

ALTER TABLE direct_messages ENABLE ROW LEVEL SECURITY;

-- Users can see messages where they are sender or recipient
CREATE POLICY dm_own ON direct_messages
  FOR ALL TO authenticated
  USING (
    sender_id    = auth.uid()
    OR recipient_id = auth.uid()
  )
  WITH CHECK (sender_id = auth.uid());

GRANT SELECT, INSERT, UPDATE(read_at) ON direct_messages TO authenticated;
