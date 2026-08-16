-- Adds the requester_id/recipient_id foreign keys on conversation_requests
-- that exist on InsForge (FOREIGN KEY ... REFERENCES auth.users(id) ON
-- DELETE CASCADE) but were missing from this schema's original migration.
-- Discovered read-only during the conversation_requests data migration.

ALTER TABLE public.conversation_requests
  ADD CONSTRAINT conversation_requests_requester_id_fkey
  FOREIGN KEY (requester_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.conversation_requests
  ADD CONSTRAINT conversation_requests_recipient_id_fkey
  FOREIGN KEY (recipient_id) REFERENCES auth.users (id) ON DELETE CASCADE;
