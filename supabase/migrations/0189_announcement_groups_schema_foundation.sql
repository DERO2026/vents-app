-- Broadcast Center, Phase 1: announcement-group schema foundation.
--
-- Scope (per this task's explicit instruction): schema only. No membership
-- trigger, no new broadcast RPC, no UI. Migration 0188
-- (admin_send_broadcast authorization fix) and the existing broadcast RPCs
-- are untouched by this file.
--
-- Three new tables:
--   announcement_groups        -- fixed catalog: 'organizers', 'service_providers'.
--                                  'Everyone' is deliberately NOT a row here --
--                                  per the target design it stays
--                                  notification-only (today's
--                                  admin_send_broadcast fan-out), not a group.
--   announcement_group_members -- role-derived membership. No client
--                                  INSERT/UPDATE/DELETE at all (not even a
--                                  user's own row) -- membership must only
--                                  ever be set by a trigger synced to
--                                  users.is_organizer/is_service_provider
--                                  (a later phase, explicitly out of scope
--                                  here), never by direct client action, or
--                                  "automatically follows active role
--                                  membership" could be defeated by a user
--                                  joining/leaving on their own.
--   announcement_mutes         -- the opposite: muting IS a direct user
--                                  action, so this table allows a user to
--                                  manage (insert/select/delete) only their
--                                  own rows, one per group -- kept as its
--                                  own table (not a column on
--                                  announcement_group_members, not a shared
--                                  JSON blob) specifically so muting one
--                                  group's notifications can never affect
--                                  another's, and so it stays structurally
--                                  separate from any future general
--                                  notification-preferences feature.
--
-- Platform grant note (confirmed via 0012_fix_default_table_grants.sql's
-- own header comment): Supabase grants broad default privileges --
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/SELECT -- to anon and
-- authenticated on every new table automatically at CREATE TABLE time.
-- Every table below explicitly REVOKEs that platform default immediately
-- after creation, then GRANTs back only the exact privileges intended --
-- the same pattern 0012 established -- so "no client INSERT/UPDATE/DELETE"
-- is enforced at the grant level, not RLS alone (RLS can be bypassed by a
-- role with a broader grant; an absent grant cannot).
--
-- Admin access follows this schema's existing convention for reference/
-- membership tables (admin_logs, organizer_wallets, reports, users, etc. in
-- 0008_rls_and_policies.sql): is_admin() -- not the narrower
-- is_admin_or_root() used by mutation RPCs like admin_send_broadcast --
-- since this is read/debug visibility for Sub-Admins and Admins alike, not
-- a privileged mutation.

-- ── announcement_groups ─────────────────────────────────────────────────
CREATE TABLE public.announcement_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_groups_key_unique UNIQUE (key),
  CONSTRAINT announcement_groups_key_check CHECK (key IN ('organizers', 'service_providers'))
);

ALTER TABLE public.announcement_groups ENABLE ROW LEVEL SECURITY;

-- Not sensitive (two label rows) -- any authenticated user may read the
-- catalog; only is_admin() may write it, and in practice only this
-- migration's own seed ever does.
CREATE POLICY select_announcement_groups ON public.announcement_groups
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY admin_write_announcement_groups ON public.announcement_groups
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

REVOKE ALL ON public.announcement_groups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.announcement_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.announcement_groups TO project_admin;

-- Idempotent seed -- safe to re-run this migration file (e.g. a future
-- `db reset` replay) without creating duplicates.
INSERT INTO public.announcement_groups (key, label) VALUES
  ('organizers', 'Organizers'),
  ('service_providers', 'Service Providers')
ON CONFLICT (key) DO NOTHING;

-- ── announcement_group_members ──────────────────────────────────────────
CREATE TABLE public.announcement_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.announcement_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_group_members_unique UNIQUE (group_id, user_id)
);

ALTER TABLE public.announcement_group_members ENABLE ROW LEVEL SECURITY;

-- SELECT only: own membership rows, or is_admin() for console visibility.
-- Deliberately NO insert/update/delete POLICY at all -- there is nothing
-- for one to authorize, since no role is ever granted those privileges
-- below (a policy without a grant is dead code and invites a future,
-- mistaken GRANT being treated as already "covered").
CREATE POLICY select_announcement_group_members ON public.announcement_group_members
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_admin());

REVOKE ALL ON public.announcement_group_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.announcement_group_members TO authenticated;
-- project_admin (the elevated role this schema's existing privileged RPCs
-- run under -- see admin_set_event_trending's own grant in
-- 0182_admin_manual_trending_control.sql) gets full access: membership
-- rows are only ever meant to be written by a future SECURITY DEFINER
-- trigger/function, never by a client role directly.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.announcement_group_members TO project_admin;

CREATE INDEX idx_announcement_group_members_user_id ON public.announcement_group_members(user_id);
CREATE INDEX idx_announcement_group_members_group_id ON public.announcement_group_members(group_id);

-- Backfill from current role state. One-time, idempotent (ON CONFLICT DO
-- NOTHING against the unique (group_id, user_id) constraint) -- safe to
-- re-run. Does not touch users.is_organizer/is_service_provider or any
-- other table.
INSERT INTO public.announcement_group_members (group_id, user_id)
SELECT g.id, u.id
FROM public.users u
JOIN public.announcement_groups g ON g.key = 'organizers'
WHERE u.is_organizer = true
ON CONFLICT (group_id, user_id) DO NOTHING;

INSERT INTO public.announcement_group_members (group_id, user_id)
SELECT g.id, u.id
FROM public.users u
JOIN public.announcement_groups g ON g.key = 'service_providers'
WHERE u.is_service_provider = true
ON CONFLICT (group_id, user_id) DO NOTHING;

-- ── announcement_mutes ───────────────────────────────────────────────────
CREATE TABLE public.announcement_mutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.announcement_groups(id) ON DELETE CASCADE,
  muted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_mutes_unique UNIQUE (user_id, group_id)
);

ALTER TABLE public.announcement_mutes ENABLE ROW LEVEL SECURITY;

-- Unlike group_members, muting is a direct user action -- a user manages
-- their own mute rows exactly like saved_service_providers/saved_events
-- manage their own saves (0118_saved_service_providers.sql): own-row
-- SELECT/INSERT/DELETE, no UPDATE (a mute is binary -- insert to mute,
-- delete to unmute). is_admin() additionally gets SELECT for support/
-- debugging visibility, matching this schema's existing admin-read
-- convention; admins do not get to mute/unmute on a user's behalf.
CREATE POLICY select_announcement_mutes ON public.announcement_mutes
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_admin());

CREATE POLICY insert_announcement_mutes ON public.announcement_mutes
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY delete_announcement_mutes ON public.announcement_mutes
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.announcement_mutes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.announcement_mutes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.announcement_mutes TO project_admin;

CREATE INDEX idx_announcement_mutes_user_id ON public.announcement_mutes(user_id);
CREATE INDEX idx_announcement_mutes_group_id ON public.announcement_mutes(group_id);
