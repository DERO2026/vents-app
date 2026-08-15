-- Adds storage.objects RLS policies for the "events", "direct_messages",
-- and "highlights" buckets, equivalent to InsForge's
-- storage_objects_owner_*/storage_objects_dm_*/storage_objects_highlights_*
-- policies - same pattern as 0017_avatars_storage_policies.sql, extending
-- coverage to the next three buckets. Column names again translated from
-- InsForge's own storage.objects schema (bucket/uploaded_by) to Supabase's
-- native one (bucket_id/owner_id) - not a literal copy.
--
-- events: public bucket, same owner-based model as avatars (InsForge
-- actually shares one combined policy across avatars+events for
-- read/update/delete/insert - written here as separate per-bucket
-- policies instead, to avoid touching the avatars policies already added).
--
-- direct_messages: public bucket on InsForge too (confirmed via
-- `insforge storage buckets`) - SELECT has NO owner/participant
-- restriction on InsForge's own policy (storage_objects_dm_select is
-- `bucket = 'direct_messages'` with no further qual), so this preserves
-- that as-is rather than inventing a stricter participant check InsForge
-- itself never enforced. The real access boundary there is an unguessable
-- object key, not RLS - matching, not improving on, the source system.
--
-- highlights: public bucket, same shape as direct_messages (unrestricted
-- SELECT, owner-restricted insert/update/delete).
--
-- Still not covered after this: verification-docs (private bucket,
-- needs its own review since it holds sensitive ID documents - not
-- carried over here, flagged as a separate follow-up).

-- ── events ──────────────────────────────────────────────────────────────
CREATE POLICY storage_objects_events_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'events' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_events_select ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'events');

CREATE POLICY storage_objects_events_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'events' AND owner_id = (SELECT auth.uid())::text)
  WITH CHECK (bucket_id = 'events' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_events_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'events' AND owner_id = (SELECT auth.uid())::text);

-- ── direct_messages ─────────────────────────────────────────────────────
CREATE POLICY storage_objects_dm_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'direct_messages');

CREATE POLICY storage_objects_dm_select ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'direct_messages');

CREATE POLICY storage_objects_dm_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'direct_messages' AND owner_id = (SELECT auth.uid())::text)
  WITH CHECK (bucket_id = 'direct_messages' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_dm_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'direct_messages' AND owner_id = (SELECT auth.uid())::text);

-- ── highlights ──────────────────────────────────────────────────────────
CREATE POLICY storage_objects_highlights_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'highlights');

CREATE POLICY storage_objects_highlights_select ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'highlights');

CREATE POLICY storage_objects_highlights_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'highlights' AND owner_id = (SELECT auth.uid())::text)
  WITH CHECK (bucket_id = 'highlights' AND owner_id = (SELECT auth.uid())::text);

CREATE POLICY storage_objects_highlights_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'highlights' AND owner_id = (SELECT auth.uid())::text);
