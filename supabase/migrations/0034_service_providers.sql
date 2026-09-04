-- Service Provider profile/listing table -- Stage 1 of the Services feature
-- (schema only; no Services screens yet). Deliberately a separate table
-- from `users`/`service_provider_requests`, keyed 1:1 by user_id, so the
-- two approval layers stay conceptually distinct per the approved plan:
--   1. `service_provider_requests` + `users.is_service_provider` (0033) =
--      "is this account allowed to act as a provider at all" (capability).
--   2. `service_providers.status` here = "is this specific listing visible
--      in Services discovery" (listing). A user can hold the capability
--      without ever publishing a listing, and -- per the approved v1
--      decision -- a listing can go straight from draft to `approved` on
--      save, with no separate admin listing-review queue.
-- Does NOT touch users.role, organizer_requests, organizer_verification_
-- requests, check_user_role_update(), or anything from 0033 -- all
-- existing Organizer and Service Provider *capability* architecture is
-- untouched by this migration.

CREATE TABLE IF NOT EXISTS public.service_providers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  business_name text NOT NULL,
  -- Free-text category, following the exact convention events.category /
  -- events.categories already use (no CHECK/enum in the DB -- the allowed
  -- list of 4 initial categories is enforced client-side, same as event
  -- categories are today).
  category text NOT NULL,
  description text,
  -- Plain free-text location for v1 (e.g. "Lekki, Lagos"), matching the
  -- simplicity of users.state -- no geo/lat-lng/place_id in this stage.
  location text,
  -- Same array-of-URLs convention as events.gallery_urls.
  photo_urls text[] NOT NULL DEFAULT '{}'::text[],
  starting_price numeric,
  -- ISO 4217 currency code (e.g. 'NGN', 'USD', 'GBP'). Stored explicitly
  -- per-row rather than assumed from the provider's account country --
  -- VENTS is global and a provider's business currency need not match
  -- users.country. Client defaults this from the provider's account
  -- country at setup time but the provider can change it.
  starting_price_currency text,
  services_offered text[] NOT NULL DEFAULT '{}'::text[],
  offers_home_service boolean NOT NULL DEFAULT false,
  offers_delivery boolean NOT NULL DEFAULT false,
  offers_same_day boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_providers_pkey PRIMARY KEY (id),
  -- One listing per account for v1 -- matches is_service_provider being a
  -- single boolean rather than a list of provider identities.
  CONSTRAINT service_providers_user_id_key UNIQUE (user_id),
  CONSTRAINT service_providers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT service_providers_status_check CHECK (status = ANY (ARRAY['draft'::text, 'approved'::text, 'rejected'::text])),
  CONSTRAINT service_providers_starting_price_check CHECK (starting_price IS NULL OR starting_price >= 0),
  -- ISO 4217 codes are 3 uppercase letters. Not validated against the full
  -- currency list in the DB (that list lives client-side, see
  -- src/lib/currencies.ts) -- this only guards the shape.
  CONSTRAINT service_providers_currency_format_check CHECK (starting_price_currency IS NULL OR starting_price_currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS idx_service_providers_category ON public.service_providers (category);
CREATE INDEX IF NOT EXISTS idx_service_providers_status ON public.service_providers (status);
CREATE INDEX IF NOT EXISTS idx_service_providers_created_at ON public.service_providers (created_at DESC);

ALTER TABLE public.service_providers ENABLE ROW LEVEL SECURITY;

-- Public discovery: only approved listings are visible to anyone (anon
-- included, same as events' public browse). Draft/rejected listings are
-- never exposed outside their owner/admin.
CREATE POLICY service_providers_public_select_approved ON public.service_providers
  FOR SELECT
  TO anon, authenticated
  USING (status = 'approved');

-- Owner can always see their own listing regardless of status (so they can
-- view/edit a draft or a rejected listing).
CREATE POLICY service_providers_select_own ON public.service_providers
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY service_providers_admin_select ON public.service_providers
  FOR SELECT
  TO authenticated
  USING (is_admin());

-- Only an approved Service Provider (users.is_service_provider = true) may
-- create their own listing -- this is the enforcement point for "only
-- approved Service Providers can create/update their own provider
-- profile." A plain attendee/organizer with no capability grant cannot
-- insert a row here at all, regardless of what the client sends.
CREATE POLICY service_providers_insert_own ON public.service_providers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.is_service_provider = true
    )
  );

-- Same capability gate on UPDATE -- if the capability is ever revoked
-- (admin_set_service_provider_capability(p_enabled := false)), the owner
-- immediately loses the ability to edit their listing too, even though
-- the row (and any prior 'approved' status) still exists.
CREATE POLICY service_providers_update_own ON public.service_providers
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.is_service_provider = true
    )
  )
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.is_service_provider = true
    )
  );

CREATE POLICY service_providers_admin_update ON public.service_providers
  FOR UPDATE
  TO authenticated
  USING (is_admin());

CREATE POLICY service_providers_delete_own ON public.service_providers
  FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY service_providers_admin_delete ON public.service_providers
  FOR DELETE
  TO authenticated
  USING (is_admin());

-- Table-level grants -- mirrors service_provider_requests' grant shape
-- (0033): RLS policies above are the real boundary, these grants just
-- allow the roles the policies are written for to reach the table at all.
GRANT DELETE, INSERT, SELECT, UPDATE ON public.service_providers TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.service_providers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.service_providers TO project_admin;

-- No generic updated_at trigger exists elsewhere in this schema (existing
-- code sets `updated_at = now()` explicitly inside each UPDATE statement
-- issued by trusted functions) -- but service_providers is updated
-- directly by the client via RLS, not through a function, so a trigger is
-- the only reliable way to keep this column honest against a client that
-- forgets (or lies about) it.
CREATE OR REPLACE FUNCTION public.set_service_providers_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION public.set_service_providers_updated_at() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.set_service_providers_updated_at() TO anon, authenticated, project_admin;

CREATE TRIGGER trg_set_service_providers_updated_at
  BEFORE UPDATE ON public.service_providers
  FOR EACH ROW EXECUTE FUNCTION public.set_service_providers_updated_at();
