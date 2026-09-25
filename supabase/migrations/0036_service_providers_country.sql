-- Replaces the free-text-location country guess (src/lib/serviceProviders.ts's
-- filterProvidersByCountryName, Stage 2) with a real structured column, so
-- the Services discovery-country filter can query directly instead of
-- substring-matching `location`.
--
-- NOT NULL is satisfied via DEFAULT '' rather than inventing a country for
-- rows that predate this column (there are none in production yet, but the
-- same rule holds for any row saved before a provider's onboarding form is
-- completed/updated once that stage ships): '' is not a real ISO 3166-1
-- alpha-2 code, so service_providers_country_format_check below accepts it
-- as an explicit "not yet set" sentinel, and the discovery query's country
-- filter (`country = <iso>`) naturally never matches '' -- such a row is
-- safely excluded from country-specific discovery, not force-fed a guessed
-- country. Provider onboarding (not built yet) will populate this from the
-- provider's account country (users.country) by default, editable by the
-- provider -- this migration only adds the column and its constraint.

ALTER TABLE public.service_providers ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT '';

ALTER TABLE public.service_providers
  ADD CONSTRAINT service_providers_country_format_check
  CHECK (country = '' OR country ~ '^[A-Z]{2}$');

CREATE INDEX IF NOT EXISTS idx_service_providers_country ON public.service_providers (country);
