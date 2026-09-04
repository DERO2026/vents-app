-- Storage bucket + RLS policies for Service Provider listing photos.
-- Same pattern as 0017 (avatars) / 0018 (events, direct_messages,
-- highlights) / 0019 (verification-docs): public read, owner-scoped
-- write. Unlike those buckets (migrated from an already-existing
-- InsForge bucket), "service-providers" is new and doesn't exist yet on
-- Supabase, so this migration also creates it -- `on conflict do nothing`
-- makes the insert safe to re-run.

INSERT INTO storage.buckets (id, name, public)
VALUES ('service-providers', 'service-providers', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY storage_objects_service_providers_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'service-providers' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_service_providers_select ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'service-providers');

CREATE POLICY storage_objects_service_providers_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'service-providers' AND owner_id = (SELECT auth.uid())::text)
  WITH CHECK (bucket_id = 'service-providers' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_service_providers_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'service-providers' AND owner_id = (SELECT auth.uid())::text);
