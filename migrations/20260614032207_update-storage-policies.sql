-- Drop the existing owner policies to replace them with bucket-specific ones
DROP POLICY IF EXISTS storage_objects_owner_insert ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_update ON storage.objects;
DROP POLICY IF EXISTS storage_objects_owner_delete ON storage.objects;

-- 1. Create owner-restricted policies for the 'events' bucket
CREATE POLICY storage_objects_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket = 'events' AND uploaded_by = (SELECT auth.jwt() ->> 'sub'));

CREATE POLICY storage_objects_owner_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket = 'events' AND uploaded_by = (SELECT auth.jwt() ->> 'sub'))
  WITH CHECK (bucket = 'events' AND uploaded_by = (SELECT auth.jwt() ->> 'sub'));

CREATE POLICY storage_objects_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket = 'events' AND uploaded_by = (SELECT auth.jwt() ->> 'sub'));

-- 2. Create authenticated policies for the 'avatars' bucket (allowing insert/update for any authenticated user)
CREATE POLICY storage_objects_avatars_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket = 'avatars');

CREATE POLICY storage_objects_avatars_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket = 'avatars')
  WITH CHECK (bucket = 'avatars');

CREATE POLICY storage_objects_avatars_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket = 'avatars' AND uploaded_by = (SELECT auth.jwt() ->> 'sub'));
