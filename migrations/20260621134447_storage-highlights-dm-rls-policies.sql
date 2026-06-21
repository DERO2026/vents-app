-- Fix 403 on highlights and direct_messages uploads:
-- These buckets exist but have NO RLS policies, so every upload is denied.

-- ── highlights bucket ──────────────────────────────────────────────────────
CREATE POLICY storage_objects_highlights_insert ON storage.objects
  FOR INSERT WITH CHECK (
    bucket = 'highlights' AND auth.uid() IS NOT NULL
  );

CREATE POLICY storage_objects_highlights_select ON storage.objects
  FOR SELECT USING (bucket = 'highlights');

CREATE POLICY storage_objects_highlights_update ON storage.objects
  FOR UPDATE USING (
    bucket = 'highlights' AND uploaded_by = (auth.uid())::text
  ) WITH CHECK (
    bucket = 'highlights' AND uploaded_by = (auth.uid())::text
  );

CREATE POLICY storage_objects_highlights_delete ON storage.objects
  FOR DELETE USING (
    bucket = 'highlights' AND uploaded_by = (auth.uid())::text
  );

-- ── direct_messages bucket ─────────────────────────────────────────────────
CREATE POLICY storage_objects_dm_insert ON storage.objects
  FOR INSERT WITH CHECK (
    bucket = 'direct_messages' AND auth.uid() IS NOT NULL
  );

CREATE POLICY storage_objects_dm_select ON storage.objects
  FOR SELECT USING (bucket = 'direct_messages');

CREATE POLICY storage_objects_dm_update ON storage.objects
  FOR UPDATE USING (
    bucket = 'direct_messages' AND uploaded_by = (auth.uid())::text
  ) WITH CHECK (
    bucket = 'direct_messages' AND uploaded_by = (auth.uid())::text
  );

CREATE POLICY storage_objects_dm_delete ON storage.objects
  FOR DELETE USING (
    bucket = 'direct_messages' AND uploaded_by = (auth.uid())::text
  );
