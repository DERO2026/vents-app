-- Adds storage.objects RLS policies for the "verification-docs" bucket,
-- equivalent to InsForge's storage_objects_verification_docs_* policies -
-- same translation pattern as 0017/0018 (InsForge's bucket/uploaded_by
-- columns -> Supabase's native bucket_id/owner_id), completing coverage
-- of all 5 storage buckets.
--
-- Unlike avatars/events/direct_messages/highlights, this bucket holds
-- sensitive ID documents (CAC certificates, business registration docs)
-- and is NOT public - matching InsForge exactly, there is no public SELECT
-- policy here. Read access is restricted to the uploader themselves OR an
-- admin (via is_admin(), already migrated as part of the earlier function
-- migration and confirmed present/SECURITY DEFINER before writing this).

CREATE POLICY storage_objects_verification_docs_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'verification-docs');

CREATE POLICY storage_objects_verification_docs_select ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'verification-docs' AND (owner_id = (SELECT auth.uid())::text OR is_admin()));

CREATE POLICY storage_objects_verification_docs_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'verification-docs' AND owner_id = (SELECT auth.uid())::text)
  WITH CHECK (bucket_id = 'verification-docs' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_verification_docs_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'verification-docs' AND owner_id = (SELECT auth.uid())::text);
