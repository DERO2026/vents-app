-- storage_objects_owner_insert only checked bucket IN (...) — unlike its own
-- UPDATE/DELETE siblings on the same table, it never constrained
-- uploaded_by = auth.uid(). A client could insert a storage.objects row
-- claiming uploaded_by = someone else's id (metadata forgery), even though
-- the legitimate upload flow (src/lib/mediaPipeline.ts) already always sets
-- it to the real uploader — this just makes the database enforce what the
-- app already does, for symmetry with UPDATE/DELETE.
DROP POLICY IF EXISTS storage_objects_owner_insert ON storage.objects;

CREATE POLICY storage_objects_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket IN ('avatars', 'events') AND uploaded_by = auth.uid()::text);
