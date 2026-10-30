-- Extra columns, tables and stubs the live ticket and booking money
-- functions (live-money-functions.sql) read, on top of
-- schema-vents-earn.sql + schema-representative-rewards.sql. Column names
-- and types follow production (information_schema, read-only).
-- Only what these tests touch.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email text;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS price        numeric,
  ADD COLUMN IF NOT EXISTS ticket_types jsonb,
  ADD COLUMN IF NOT EXISTS ticket_goal  integer;

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS quantity            integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ticket_type         text,
  ADD COLUMN IF NOT EXISTS payment_ref         text,
  ADD COLUMN IF NOT EXISTS payment_method      text,
  ADD COLUMN IF NOT EXISTS holder_name         text,
  ADD COLUMN IF NOT EXISTS holder_email        text,
  ADD COLUMN IF NOT EXISTS holder_phone        text,
  ADD COLUMN IF NOT EXISTS promo_code          text,
  ADD COLUMN IF NOT EXISTS payer_id            uuid,
  ADD COLUMN IF NOT EXISTS checked_in          boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS refund_reason       text,
  ADD COLUMN IF NOT EXISTS refund_initiated_by uuid,
  ADD COLUMN IF NOT EXISTS refund_id           text,
  ADD COLUMN IF NOT EXISTS created_at          timestamptz DEFAULT now();

ALTER TABLE public.pending_purchases
  ADD COLUMN IF NOT EXISTS user_id        uuid,
  ADD COLUMN IF NOT EXISTS ticket_type    text,
  ADD COLUMN IF NOT EXISTS attendees      jsonb,
  ADD COLUMN IF NOT EXISTS attendees_hash text,
  ADD COLUMN IF NOT EXISTS promo_code     text,
  ADD COLUMN IF NOT EXISTS amount_kobo    bigint,
  ADD COLUMN IF NOT EXISTS payment_ref    text UNIQUE,
  ADD COLUMN IF NOT EXISTS payer_id       uuid,
  ADD COLUMN IF NOT EXISTS created_at     timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.promo_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL,
  discount_percentage numeric NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  expires_at          timestamptz,
  max_uses            integer,
  current_uses        integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.service_bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL,
  provider_id         uuid NOT NULL REFERENCES public.service_providers(id),
  status              text NOT NULL DEFAULT 'confirmed',
  payment_status      text NOT NULL DEFAULT 'pending',
  payment_ref         text,
  payment_method      text,
  subtotal_kobo       bigint NOT NULL,
  fee_kobo            bigint NOT NULL DEFAULT 0,
  total_kobo          bigint NOT NULL,
  refund_initiated_by uuid,
  refund_reason       text,
  refund_id           text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- Stubs for live helpers outside the money path.
CREATE OR REPLACE FUNCTION public.purchases_disabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.award_vc_reward(p_user_id uuid, p_kind text, p_ref uuid, p_note text DEFAULT NULL)
  RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE OR REPLACE FUNCTION public.reverse_vc_reward(p_ref uuid, p_reason text) RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE OR REPLACE FUNCTION public.generate_ticket_token(p_ticket_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'tok' $$;

-- Live client grants for the functions these tests call as a user.
GRANT EXECUTE ON FUNCTION public.request_organizer_payout(bigint, uuid, text) TO authenticated;
CREATE OR REPLACE FUNCTION public.event_effective_end_at(p_start timestamptz, p_end timestamptz) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_end, p_start + interval '1 day') $$;
CREATE TABLE IF NOT EXISTS public.checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid, ticket_id uuid, checked_in_at timestamptz DEFAULT now()
);
-- Live get_pending_purchase_owner also resolves per-attempt Paystack refs
-- (ticket_payment_attempts); these tests use the stable payment_ref only.
CREATE OR REPLACE FUNCTION public.get_pending_purchase_owner(p_reference text)
 RETURNS TABLE(payment_ref text, owner_id uuid, payer_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS
$$ SELECT payment_ref, user_id, payer_id FROM public.pending_purchases WHERE payment_ref = p_reference LIMIT 1 $$;
-- reports, as live (0002 + 0005).
CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reporter_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('event', 'user')), target_id uuid NOT NULL,
  reason text NOT NULL, details text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.service_bookings ADD COLUMN IF NOT EXISTS scheduled_date date, ADD COLUMN IF NOT EXISTS scheduled_time time without time zone;
