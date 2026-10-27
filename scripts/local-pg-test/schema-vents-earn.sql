-- Minimal hand-approximated schema covering only the tables/functions that
-- migration 0193 (VENTS Earn Stage 1: recruiter partnerships) touches:
-- users, events, service_providers, notifications, plus stub replacements
-- for is_admin()/check_rate_limit()/auth.uid().
--
-- This is NOT the real production schema -- it is a deliberately minimal
-- approximation for exercising 0193's PL/pgSQL functions and RLS policies
-- against a real local Postgres engine (not a JS reimplementation or a
-- regex match against the migration text), to catch defects neither of
-- those can: CHECK-constraint violations under real writes, PL/pgSQL
-- control-flow bugs, and actual RLS enforcement under a non-superuser
-- role.
--
-- Unlike schema.sql (used for migration 0192), auth.uid() here is backed
-- by a session GUC (`test.uid`) so each psql statement/transaction can
-- impersonate a different caller with a plain `SET test.uid = '...';`,
-- and is_admin() mirrors the real public.is_admin() by checking
-- public.users.role for the current auth.uid().
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT current_setting('test.uid', true)::uuid $$;

CREATE TABLE public.users (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL DEFAULT 'user',
  -- Admin Console capability flags (admin_set_organizer_capability /
  -- admin_set_service_provider_capability) and soft delete; read by 0196.
  is_organizer        boolean NOT NULL DEFAULT false,
  is_service_provider boolean NOT NULL DEFAULT false,
  deleted_at          timestamptz
);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'sub-admin')) $$;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_attempts integer, p_window_seconds integer) RETURNS void LANGUAGE sql AS
$$ SELECT NULL $$;

CREATE TABLE public.events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  title        text
);

CREATE TABLE public.service_providers (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  status  text NOT NULL DEFAULT 'approved'
);

CREATE TABLE public.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid,
  type       text,
  title      text,
  body       text,
  read       boolean DEFAULT false,
  icon       text,
  push_data  jsonb,
  created_at timestamptz DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
-- Test-only convenience: let the 'authenticated' role see the seed rows
-- in these support tables (RLS is not enabled on them, only on
-- recruiters/recruiter_partnerships, which 0193 itself locks down).
GRANT SELECT ON public.users, public.events, public.service_providers TO authenticated;
GRANT SELECT, INSERT ON public.notifications TO authenticated;
