-- ── Revert the `tickets` bucket allowlist entry ──────────────────────────────
-- The dedicated `tickets` storage bucket (added in 20260726093000) turned out
-- to be blocked by the storage gateway independent of this RLS policy — a
-- fresh bucket's authenticated-write access appears to be gated by something
-- outside what's editable via Postgres RLS from here (verified: an identical
-- predicate correctly permits writes to `events`, and the policy text for
-- `tickets` was confirmed correct in pg_catalog, yet uploads still 403'd).
-- The bucket has been deleted and ticket QR images are hosted in the
-- already-functional `events` bucket instead. Revert the allowlist so it
-- doesn't reference a bucket that no longer exists.

DROP POLICY IF EXISTS storage_objects_owner_insert ON storage.objects;
CREATE POLICY storage_objects_owner_insert ON storage.objects
  FOR INSERT
  WITH CHECK (bucket = ANY (ARRAY['avatars'::text, 'events'::text]) AND auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS storage_objects_owner_update ON storage.objects;
CREATE POLICY storage_objects_owner_update ON storage.objects
  FOR UPDATE
  USING (bucket = ANY (ARRAY['avatars'::text, 'events'::text]) AND uploaded_by = (auth.uid())::text)
  WITH CHECK (bucket = ANY (ARRAY['avatars'::text, 'events'::text]) AND uploaded_by = (auth.uid())::text);

DROP POLICY IF EXISTS storage_objects_owner_delete ON storage.objects;
CREATE POLICY storage_objects_owner_delete ON storage.objects
  FOR DELETE
  USING (bucket = ANY (ARRAY['avatars'::text, 'events'::text]) AND uploaded_by = (auth.uid())::text);
