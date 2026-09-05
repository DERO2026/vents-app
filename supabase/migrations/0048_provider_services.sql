-- Service catalog for approved Service Providers -- Stage 2 of Services
-- (0033/0034/0036/0044/0045 were capability + listing; this adds the
-- individual priced offerings under a listing). Deliberately a separate
-- table from service_providers, keyed by provider_id (the LISTING's own
-- id), not user_id directly -- ownership for writes is resolved through
-- that FK to service_providers.user_id, exactly mirroring how
-- service_providers itself resolves ownership through users.is_service_
-- provider. This shape is also what the next stage needs: a future
-- booking_requests table references provider_services(id) directly
-- (Service -> Booking Request -> Provider Accepts -> Paystack Payment ->
-- VENTS Commission -> Provider Payout), so this migration does not
-- introduce anything that stage would need to restructure.
--
-- Does NOT touch service_providers, service_provider_requests, users.role,
-- organizer_verification_requests, or any existing payment/wallet/Paystack
-- architecture -- purely additive. No booking/payment logic exists here at
-- all (is_active is a publish/unpublish toggle only, not availability
-- scheduling).

CREATE TABLE IF NOT EXISTS public.provider_services (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  price numeric NOT NULL,
  -- ISO 4217 code, same convention/format as service_providers.starting_
  -- price_currency (0034) -- stored per-service, not assumed from the
  -- listing, since a provider's individual services could reasonably use
  -- a different currency than their listing's displayed "starting price".
  currency text NOT NULL,
  duration_minutes integer,
  -- Free text, no DB enum -- same convention as service_providers.category
  -- and events.category (client-enforced list). Optional: defaults to the
  -- provider's listing category at creation time in the client, but a
  -- service can diverge from it.
  category text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_services_pkey PRIMARY KEY (id),
  CONSTRAINT provider_services_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.service_providers(id) ON DELETE CASCADE,
  CONSTRAINT provider_services_price_check CHECK (price >= 0),
  CONSTRAINT provider_services_currency_format_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT provider_services_duration_check CHECK (duration_minutes IS NULL OR duration_minutes > 0)
);

CREATE INDEX IF NOT EXISTS idx_provider_services_provider_id ON public.provider_services (provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_services_is_active ON public.provider_services (is_active);

ALTER TABLE public.provider_services ENABLE ROW LEVEL SECURITY;

-- Public discovery: only an ACTIVE service under an APPROVED listing is
-- ever visible to anon/authenticated -- same two-layer visibility rule
-- service_providers itself already enforces for the listing (status =
-- 'approved'), applied down to the individual service level too. A
-- provider whose listing is later un-approved (or a service toggled
-- inactive) disappears from public view immediately, with no separate
-- admin action needed.
CREATE POLICY provider_services_public_select ON public.provider_services
  FOR SELECT
  TO anon, authenticated
  USING (
    is_active = true
    AND EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = provider_id AND sp.status = 'approved')
  );

-- Owner can always see their own services regardless of active status (so
-- they can view/edit/re-activate a paused one).
CREATE POLICY provider_services_select_own ON public.provider_services
  FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = provider_id AND sp.user_id = (SELECT auth.uid())));

CREATE POLICY provider_services_admin_select ON public.provider_services
  FOR SELECT
  TO authenticated
  USING (is_admin());

-- Only an approved Service Provider (users.is_service_provider = true) may
-- create/edit services under THEIR OWN listing -- the same capability gate
-- service_providers_insert_own/update_own (0034) already enforce for the
-- listing itself, applied here too so a revoked capability immediately
-- blocks new/edited services, not just the listing.
CREATE POLICY provider_services_insert_own ON public.provider_services
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.service_providers sp
      JOIN public.users u ON u.id = sp.user_id
      WHERE sp.id = provider_id AND sp.user_id = (SELECT auth.uid()) AND u.is_service_provider = true
    )
  );

CREATE POLICY provider_services_update_own ON public.provider_services
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.service_providers sp
      JOIN public.users u ON u.id = sp.user_id
      WHERE sp.id = provider_id AND sp.user_id = (SELECT auth.uid()) AND u.is_service_provider = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.service_providers sp
      JOIN public.users u ON u.id = sp.user_id
      WHERE sp.id = provider_id AND sp.user_id = (SELECT auth.uid()) AND u.is_service_provider = true
    )
  );

CREATE POLICY provider_services_delete_own ON public.provider_services
  FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = provider_id AND sp.user_id = (SELECT auth.uid())));

-- Admin/Sub-Admin manage services across ANY provider -- is_admin() covers
-- both roles plus root (0004_functions.sql), mirroring the exact bypass
-- shape service_providers_admin_insert/update/delete (0045) already use,
-- so Admin/Sub-Admin have the same reach over individual services as they
-- do over the listing itself, without needing the capability flag.
CREATE POLICY provider_services_admin_insert ON public.provider_services
  FOR INSERT
  TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY provider_services_admin_update ON public.provider_services
  FOR UPDATE
  TO authenticated
  USING (is_admin());

CREATE POLICY provider_services_admin_delete ON public.provider_services
  FOR DELETE
  TO authenticated
  USING (is_admin());

-- Table-level grants -- RLS policies above are the real boundary; mirrors
-- service_providers' own grant shape (0034).
GRANT DELETE, INSERT, SELECT, UPDATE ON public.provider_services TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.provider_services TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_services TO project_admin;

-- Own updated_at trigger, not shared with service_providers' (isolated on
-- purpose, same reasoning 0034 gives for its own trigger function).
CREATE OR REPLACE FUNCTION public.set_provider_services_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION public.set_provider_services_updated_at() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.set_provider_services_updated_at() TO anon, authenticated, project_admin;

CREATE TRIGGER trg_set_provider_services_updated_at
  BEFORE UPDATE ON public.provider_services
  FOR EACH ROW EXECUTE FUNCTION public.set_provider_services_updated_at();
