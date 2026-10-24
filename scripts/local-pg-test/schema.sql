-- Minimal hand-approximated schema covering only the tables/functions that
-- migration 0192 (platform fee accounting) touches: tickets, events,
-- organizer_transactions, organizer_wallets, notifications, promo_codes,
-- admin_logs, service_bookings/service_providers, auth.users, plus stub
-- replacements for is_admin()/award_vc_reward()/check_rate_limit()/auth.uid().
--
-- This is NOT the real production schema -- it is a deliberately minimal
-- approximation for exercising a migration's PL/pgSQL functions against a
-- real local Postgres engine (not a JS reimplementation), to catch SQL-level
-- defects (e.g. CTE-scope bugs) that text/regex assertions and JS
-- simulations cannot. Extend it when testing a migration that touches
-- tables not listed here.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.award_vc_reward(p_user_id uuid, p_action text, p_reference_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT NULL $$;
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_limit int, p_window int) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  title text,
  event_date timestamptz,
  status text DEFAULT 'live'
);

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id),
  user_id uuid NOT NULL,
  payer_id uuid,
  quantity integer NOT NULL DEFAULT 1,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  payment_ref text,
  payment_status text DEFAULT 'pending',
  amount numeric DEFAULT 0,
  ticket_type text,
  checked_in boolean DEFAULT false,
  checked_in_at timestamptz,
  scanner_id uuid,
  holder_name text,
  holder_email text,
  promo_code text,
  discount_percentage numeric DEFAULT 0,
  refund_id text,
  refund_reason text,
  refund_initiated_by uuid,
  holder_phone text,
  payment_method text
  -- platform_fee_kobo / platform_fee_absorbed_kobo / qualifying_status are
  -- added by migration 0192 itself via ALTER TABLE -- not pre-declared here.
);

CREATE TABLE public.service_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
);

CREATE TABLE public.service_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  provider_id uuid NOT NULL REFERENCES public.service_providers(id),
  status text DEFAULT 'pending_payment',
  scheduled_date date,
  scheduled_time time,
  location text,
  customer_notes text,
  currency text NOT NULL DEFAULT 'NGN',
  subtotal_kobo bigint NOT NULL DEFAULT 0,
  fee_kobo bigint NOT NULL DEFAULT 0,
  total_kobo bigint NOT NULL DEFAULT 0,
  payment_ref text,
  payment_status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  payment_method text,
  refund_reason text,
  refund_initiated_by uuid,
  refund_id text
);

CREATE TABLE public.promo_codes (
  code text PRIMARY KEY,
  uses integer DEFAULT 0
);

CREATE TABLE public.organizer_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  type text NOT NULL,
  amount_kobo bigint NOT NULL,
  description text,
  ticket_sale_id uuid,
  created_at timestamptz DEFAULT now(),
  withdrawal_request_id uuid,
  metadata jsonb
);

CREATE TABLE public.organizer_wallets (
  organizer_id uuid PRIMARY KEY,
  balance_kobo bigint NOT NULL DEFAULT 0,
  total_earned_kobo bigint NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  type text,
  title text,
  body text,
  read boolean DEFAULT false,
  icon text,
  push_data jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.admin_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid,
  action text NOT NULL,
  target_user_id uuid,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_role text
);

-- credit_organizer_wallet and confirm_ticket_payment are NOT stubbed here --
-- the migration under test provides the real bodies via CREATE OR REPLACE,
-- which is the whole point of this harness: exercise the real SQL.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='project_admin') THEN CREATE ROLE project_admin; END IF;
END $$;
