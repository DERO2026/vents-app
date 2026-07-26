-- ── Allow authenticated uploads to the new `tickets` storage bucket ──────────
-- The bucket was created (public-read) for hosting per-attendee QR images, but
-- writes to storage.objects are gated by a SEPARATE RLS policy that hardcodes
-- which buckets an authenticated uploader may write to — `tickets` was never
-- added to that allowlist, so every QR upload attempt got a 403 and the
-- ticket-confirmation email silently fell back to a text-only code. Extend the
-- existing owner insert/update/delete policies (same shape already used for
-- avatars/events) to include `tickets`.

DROP POLICY IF EXISTS storage_objects_owner_insert ON storage.objects;
CREATE POLICY storage_objects_owner_insert ON storage.objects
  FOR INSERT
  WITH CHECK (bucket = ANY (ARRAY['avatars'::text, 'events'::text, 'tickets'::text]) AND auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS storage_objects_owner_update ON storage.objects;
CREATE POLICY storage_objects_owner_update ON storage.objects
  FOR UPDATE
  USING (bucket = ANY (ARRAY['avatars'::text, 'events'::text, 'tickets'::text]) AND uploaded_by = (auth.uid())::text)
  WITH CHECK (bucket = ANY (ARRAY['avatars'::text, 'events'::text, 'tickets'::text]) AND uploaded_by = (auth.uid())::text);

DROP POLICY IF EXISTS storage_objects_owner_delete ON storage.objects;
CREATE POLICY storage_objects_owner_delete ON storage.objects
  FOR DELETE
  USING (bucket = ANY (ARRAY['avatars'::text, 'events'::text, 'tickets'::text]) AND uploaded_by = (auth.uid())::text);
