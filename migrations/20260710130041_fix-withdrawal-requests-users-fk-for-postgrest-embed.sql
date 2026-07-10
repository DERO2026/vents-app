-- Fix "Could not find a relationship between organizer_withdrawal_requests
-- and users" in the admin Payouts tab ("All" requests view).
--
-- organizer_withdrawal_requests.organizer_id already has a FK
-- (organizer_withdrawal_requests_organizer_id_fkey), but it points to
-- auth.users(id), not public.users(id). The client query embeds via
-- `users!organizer_withdrawal_requests_organizer_id_fkey(...)`, which
-- PostgREST can only satisfy if the named constraint connects to the
-- public.users relation being embedded — it doesn't, since it targets a
-- different schema's table entirely. Adding a second FK on the same
-- column, pointing at public.users(id), gives PostgREST a real
-- relationship to resolve that embed against. Postgres allows multiple FKs
-- on one column to different tables; this doesn't touch or replace the
-- existing auth.users FK.

ALTER TABLE public.organizer_withdrawal_requests
  ADD CONSTRAINT organizer_withdrawal_requests_organizer_id_public_users_fkey
  FOREIGN KEY (organizer_id) REFERENCES public.users(id);
