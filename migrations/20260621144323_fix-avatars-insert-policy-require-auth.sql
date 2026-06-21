-- Security fix: avatars INSERT policy had no auth requirement — any anonymous
-- request could upload. Tighten to require auth.uid() IS NOT NULL.
-- Also tighten the shared owner_insert policy (covers avatars + events) the same way.

DROP POLICY IF EXISTS storage_objects_avatars_insert ON storage.objects;
CREATE POLICY storage_objects_avatars_insert ON storage.objects
  FOR INSERT WITH CHECK (
    bucket = 'avatars' AND auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS storage_objects_owner_insert ON storage.objects;
CREATE POLICY storage_objects_owner_insert ON storage.objects
  FOR INSERT WITH CHECK (
    bucket = ANY (ARRAY['avatars'::text, 'events'::text])
    AND auth.uid() IS NOT NULL
  );
