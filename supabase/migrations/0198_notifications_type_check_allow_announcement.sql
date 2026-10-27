-- 0198: notifications_type_check allows 'announcement'; drop dead send_event_reminders().
--
-- Bug: admin_send_announcement (0191) inserts type = 'announcement' for the
-- 'organizers' and 'service_providers' audiences, but notifications_type_check
-- (0005, unchanged since) only allows
--   reminder, booking, promo, social, broadcast, message, sale, event_update
-- so every role-scoped send fails with
--   new row for relation "notifications" violates check constraint
--   "notifications_type_check"
-- and rolls back. Latent in production: no admin has sent one yet (no
-- 'announcement_sent' admin_logs row, no matching Postgres log line since
-- 0191 was applied on 2026-10-24), but both announcement groups have
-- members, so the first send would fail. The 'everyone' audience uses
-- 'broadcast' and is unaffected.
--
-- Fix (owner decision): keep 'announcement' as a distinct type, as 0191
-- intended -- a role-scoped send must not be labelled "sent to everyone" --
-- and add it to the allow-list. All eight existing values are kept; nothing
-- else is added. The VENTS Earn recruiter types were already fixed the
-- other way by 0197 (both functions now insert 'social'), so they are not
-- added here.
--
-- Also drops send_event_reminders() (0004). It inserts type =
-- 'event_reminder', which this constraint rejects too, and it is dead:
-- no app/API caller, EXECUTE only for project_admin, and re-confirmed in
-- production before writing this file -- no pg_depend rows reference it,
-- no other function/view/trigger/policy mentions it, and pg_cron is not
-- installed (no cron schema). The live reminder path is
-- run_event_reminder_sweep(), which inserts 'reminder'.
--
-- Production: apply with the Supabase MCP apply_migration tool (production
-- migration history uses timestamp versions that do not match these
-- filenames), not `supabase db push`.

ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK ((type = ANY (ARRAY['reminder'::text, 'booking'::text, 'promo'::text, 'social'::text, 'broadcast'::text, 'message'::text, 'sale'::text, 'event_update'::text, 'announcement'::text])));

DROP FUNCTION public.send_event_reminders();
