-- 0197: notifications_type_check allows the types live functions already insert.
--
-- Bug: notifications_type_check (0005, unchanged since) only allows
--   reminder, booking, promo, social, broadcast, message, sale, event_update
-- but three live SECURITY DEFINER functions insert other types, so every
-- call that reaches the INSERT fails with
--   new row for relation "notifications" violates check constraint
--   "notifications_type_check"
-- and rolls back the whole RPC:
--   - admin_send_announcement (0191), 'organizers' / 'service_providers'
--     audiences: type = 'announcement'. Latent -- no admin had sent a
--     role-scoped announcement yet (no 'announcement_sent' admin_logs row,
--     no matching Postgres log line since 0191 was applied), but both
--     announcement groups have members, so the first send would fail.
--   - invite_recruiter_partnership (0193/0196): type = 'recruiter_invitation'.
--     Live failure -- confirmed in Postgres logs (2026-10-27 20:21:38 UTC,
--     PostgREST call, SQLSTATE 23514), and recruiter_partnerships has zero
--     rows: no VENTS Earn invite has ever been created, because the
--     partnership INSERT and the notification INSERT share one transaction.
--   - respond_to_recruiter_invitation (0193): type =
--     'recruiter_invitation_response'. Unreachable until invites work, then
--     would fail the same way.
--
-- Fix (owner decision: extend the constraint rather than re-type the
-- inserts): keep every existing allowed value and add exactly those three.
-- 'announcement' stays distinct from 'broadcast' on purpose (0191: a
-- role-scoped send must not be labelled "sent to everyone"); the recruiter
-- types stay distinct so the client can tell VENTS Earn notifications apart
-- without parsing push_data. No other loosening -- the constraint is still
-- an explicit allow-list.
--
-- Also drops send_event_reminders() (0004): it inserts type =
-- 'event_reminder' (also rejected by this constraint), has no callers in
-- app code, no pg_cron job (pg_cron is not installed), no pg_depend
-- dependents, and is EXECUTE-able only by project_admin. The real reminder
-- path is run_event_reminder_sweep(), which uses type = 'reminder'.
--
-- Production: apply with the Supabase MCP apply_migration tool (production
-- migration history uses timestamp versions that do not match these
-- filenames), not `supabase db push`.

ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK ((type = ANY (ARRAY['reminder'::text, 'booking'::text, 'promo'::text, 'social'::text, 'broadcast'::text, 'message'::text, 'sale'::text, 'event_update'::text, 'announcement'::text, 'recruiter_invitation'::text, 'recruiter_invitation_response'::text])));

DROP FUNCTION IF EXISTS public.send_event_reminders();
