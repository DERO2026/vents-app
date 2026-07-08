-- Adds a minimum-required client version to the existing app_config
-- singleton row. Client compares its own build version against this on
-- launch; if the client is older, it shows a blocking update screen.
-- Defaults to the current shipped version so nothing is force-updated
-- until an admin deliberately raises it after a future release.
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS min_client_version text NOT NULL DEFAULT '1.1.0';

UPDATE public.app_config SET min_client_version = '1.1.0' WHERE min_client_version IS NULL;
