-- Fix: organizer verification uploads failing with
--   "new row violates row-level security policy for table \"objects\""
--
-- Root cause: the "verification-docs" bucket was created (2026-07-09) with
-- ZERO storage.objects RLS policies. Every other bucket (avatars, events,
-- highlights, direct_messages) already has its own explicit per-bucket
-- policy set; verification-docs was missed. RLS is enabled by default on
-- storage.objects, so with no matching policy every INSERT was denied.
--
-- This bucket holds sensitive personal/business identity documents (CAC
-- certificates), so — unlike the public-read buckets — access is scoped to
-- the uploader (or an admin reviewing the request) only. No public or
-- cross-user visibility.

CREATE POLICY storage_objects_verification_docs_insert ON storage.objects
  FOR INSERT WITH CHECK (bucket = 'verification-docs' AND auth.uid() IS NOT NULL);

CREATE POLICY storage_objects_verification_docs_select ON storage.objects
  FOR SELECT USING (
    bucket = 'verification-docs'
    AND (uploaded_by = (auth.uid())::text OR public.is_admin())
  );

CREATE POLICY storage_objects_verification_docs_update ON storage.objects
  FOR UPDATE USING (bucket = 'verification-docs' AND uploaded_by = (auth.uid())::text)
  WITH CHECK (bucket = 'verification-docs' AND uploaded_by = (auth.uid())::text);

CREATE POLICY storage_objects_verification_docs_delete ON storage.objects
  FOR DELETE USING (bucket = 'verification-docs' AND uploaded_by = (auth.uid())::text);
