-- Fix storage RLS policies: column is named "bucket", not "bucket_id"
-- The broken policies were preventing all uploads to events/avatars buckets.

DROP POLICY IF EXISTS storage_objects_public_read   ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_insert  ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_update  ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_delete  ON storage.objects;

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Public read: anyone can read files in avatars or events
CREATE POLICY storage_objects_public_read ON storage.objects
  FOR SELECT TO public
  USING (bucket IN ('avatars', 'events'));

-- Authenticated upload
CREATE POLICY storage_objects_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket IN ('avatars', 'events'));

-- Authenticated update own files
CREATE POLICY storage_objects_owner_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket IN ('avatars', 'events') AND uploaded_by = auth.uid()::text)
  WITH CHECK (bucket IN ('avatars', 'events') AND uploaded_by = auth.uid()::text);

-- Authenticated delete own files
CREATE POLICY storage_objects_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket IN ('avatars', 'events') AND uploaded_by = auth.uid()::text);
