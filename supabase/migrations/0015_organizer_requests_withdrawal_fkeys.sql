-- Adds foreign keys on organizer_requests and organizer_withdrawal_requests
-- that exist on InsForge but were missing from this schema's original
-- migration (same category of gap as 0014_conversation_requests_fkeys.sql
-- - references to auth.users specifically were dropped during the
-- original FK migration pass). Discovered read-only during the "10 missing
-- tables" data migration.

ALTER TABLE public.organizer_requests
  ADD CONSTRAINT organizer_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.organizer_requests
  ADD CONSTRAINT organizer_requests_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES auth.users (id);

ALTER TABLE public.organizer_withdrawal_requests
  ADD CONSTRAINT organizer_withdrawal_requests_organizer_id_fkey
  FOREIGN KEY (organizer_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.organizer_withdrawal_requests
  ADD CONSTRAINT organizer_withdrawal_requests_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES auth.users (id);
