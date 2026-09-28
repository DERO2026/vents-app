-- New: "Saved" in Profile currently covers events only (saved_events,
-- 0000-something baseline). There is no way for a customer to bookmark a
-- service provider at all -- ServiceProviderProfileScreen.tsx's own comment
-- notes the export's heart icon was deliberately left unwired because "no
-- real save/favorite provider capability exists in the backend". This adds
-- that capability, mirroring saved_events' shape/RLS exactly so the two
-- behave identically from the client's point of view.
CREATE TABLE public.saved_service_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES public.service_providers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_user_saved_provider UNIQUE (user_id, provider_id)
);

ALTER TABLE public.saved_service_providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_saved_service_providers ON public.saved_service_providers
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY insert_saved_service_providers ON public.saved_service_providers
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY delete_saved_service_providers ON public.saved_service_providers
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Own-rows lookups by user_id (SELECT/DELETE) and the SavedScreen batch
-- fetch by provider_id both benefit from an index -- saved_events has no
-- equivalent because it predates this project's later indexing passes, but
-- there's no reason to repeat that gap here.
CREATE INDEX idx_saved_service_providers_user_id ON public.saved_service_providers(user_id);
CREATE INDEX idx_saved_service_providers_provider_id ON public.saved_service_providers(provider_id);
