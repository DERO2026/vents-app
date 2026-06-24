-- Fix: recipient cannot update read_at because the single ALL policy has
-- WITH CHECK (sender_id = auth.uid()), which blocks updates by the recipient.
-- Split into per-operation policies so the recipient can mark messages as read.

DROP POLICY IF EXISTS dm_own ON direct_messages;

-- SELECT: sender or recipient can see their messages
CREATE POLICY dm_select ON direct_messages FOR SELECT
  USING ((sender_id = auth.uid()) OR (recipient_id = auth.uid()));

-- INSERT: only the sender can create a message
CREATE POLICY dm_insert ON direct_messages FOR INSERT
  WITH CHECK (sender_id = auth.uid());

-- UPDATE: sender can update their own messages (e.g. deleted_by_sender);
--         recipient can update messages sent to them (e.g. read_at).
CREATE POLICY dm_update ON direct_messages FOR UPDATE
  USING ((sender_id = auth.uid()) OR (recipient_id = auth.uid()))
  WITH CHECK ((sender_id = auth.uid()) OR (recipient_id = auth.uid()));

-- DELETE: sender can delete their own messages
CREATE POLICY dm_delete ON direct_messages FOR DELETE
  USING (sender_id = auth.uid());
