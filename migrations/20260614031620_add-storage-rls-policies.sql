-- Enable RLS on storage.objects (if not already enabled)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Drop existing storage policies if they exist to prevent duplication conflicts
DROP POLICY IF EXISTS storage_objects_public_read ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_insert ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_update ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_delete ON storage.objects;

-- 1. SELECT Policy: Anyone (authenticated or anon) can read files in 'avatars' or 'events' buckets
CREATE POLICY storage_objects_public_read ON storage.objects
  FOR SELECT TO authenticated, anon
  USING (bucket IN ('avatars', 'events'));

-- 2. INSERT Policy: Authenticated users can insert their own files in 'avatars' or 'events' buckets
CREATE POLICY storage_objects_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket IN ('avatars', 'events') AND uploaded_by = (SELECT auth.jwt() ->> 'sub'));

-- 3. UPDATE Policy: Authenticated users can update their own files in 'avatars' or 'events' buckets
CREATE POLICY storage_objects_owner_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket IN ('avatars', 'events') AND uploaded_by = (SELECT auth.jwt() ->> 'sub'))
  WITH CHECK (bucket IN ('avatars', 'events') AND uploaded_by = (SELECT auth.jwt() ->> 'sub'));

-- 4. DELETE Policy: Authenticated users can delete their own files in 'avatars' or 'events' buckets
CREATE POLICY storage_objects_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket IN ('avatars', 'events') AND uploaded_by = (SELECT auth.jwt() ->> 'sub'));

-- 5. Grant permissions on storage.objects and schema usage to authenticated and anon roles
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT USAGE ON SCHEMA storage TO authenticated;

GRANT SELECT ON storage.objects TO anon;
GRANT USAGE ON SCHEMA storage TO anon;
