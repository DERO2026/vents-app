-- Adds storage.objects RLS policies for the "avatars" bucket, equivalent
-- to InsForge's storage_objects_avatars_insert/update/delete and
-- storage_objects_public_read policies - discovered missing entirely
-- (storage.objects had zero policies on Supabase) while migrating the
-- signup avatar upload call in AuthScreen.tsx.
--
-- Column names differ from InsForge's own storage.objects schema
-- (bucket/uploaded_by there vs. Supabase's native bucket_id/owner_id) -
-- these are NOT a literal copy, they're rewritten to Supabase's actual
-- schema while preserving the same access intent: any authenticated user
-- can upload their own avatar, anyone can read it (public bucket), and
-- only the uploader can update/delete their own file.
--
-- Scope: avatars bucket only. InsForge has 19 total storage.objects
-- policies covering also events/verification-docs/highlights/
-- direct_messages - those remain unmigrated, a separate, larger gap.

CREATE POLICY storage_objects_avatars_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_avatars_select ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'avatars');

CREATE POLICY storage_objects_avatars_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'avatars' AND owner_id = (SELECT auth.uid())::text)
  WITH CHECK (bucket_id = 'avatars' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_avatars_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'avatars' AND owner_id = (SELECT auth.uid())::text);
