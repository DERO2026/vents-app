-- Fixes public read access to the direct_messages storage bucket.
--
-- Prior state (set in 0018_events_dm_highlights_storage_policies.sql,
-- carried over verbatim from InsForge): the "direct_messages" bucket is
-- `public = true`, and its SELECT policy (storage_objects_dm_select) is
-- `TO public USING (bucket_id = 'direct_messages')` -- no owner or
-- conversation-participant check at all. 0018's own comment at the time
-- explicitly noted "the real access boundary there is an unguessable
-- object key, not RLS." That was never actually true in practice: object
-- keys are `dm-<timestamp>-<uuid>.<ext>` (confirmed via live
-- storage.objects), served from a public bucket via getPublicUrl(), which
-- are stable, permanently-accessible, unauthenticated URLs embedded
-- directly in direct_messages.image_url and sent client-side -- not a
-- secret, and not something this app ever treated as one (the stored URL
-- is plain text in the DB and visible in network traffic). Every photo,
-- voice note, or location-share image sent through 1:1 direct messaging
-- is therefore readable by anyone with the URL, with no authentication
-- and no check that the requester is a participant in that conversation.
--
-- Fix: make the bucket private, and replace the SELECT policy with one
-- that authorizes a read only when the requester is the sender or
-- recipient of a direct_messages row whose image_url references this
-- exact object (confirmed live: direct_messages.image_url is stored as
-- `https://<project>.supabase.co/storage/v1/object/public/direct_messages/<key>`,
-- i.e. always ends with `/` || the object's own name -- so this can be
-- checked with a LIKE suffix match against storage.objects.name with no
-- schema change and no change to the existing key-naming scheme), OR the
-- requester is the object's own uploader (owner_id) -- covering the
-- window between upload and the send_direct_message RPC call that
-- creates the owning row (the client uploads the file first, then calls
-- send_direct_message with the resulting URL -- see ConversationScreen.tsx
-- sendImageMessage), before any direct_messages row referencing it exists
-- yet.
--
-- INSERT/UPDATE/DELETE policies on this bucket (storage_objects_dm_insert/
-- update/delete) already correctly scope to the uploader (owner_id =
-- auth.uid()) and are unchanged here -- SELECT was the only gap.
--
-- Client-side effect: since the bucket is no longer public,
-- getPublicUrl() no longer serves a working URL for GETs. The client
-- (ConversationScreen.tsx) switches to createSignedUrl() for displaying
-- images, while continuing to store the same getPublicUrl()-shaped string
-- in direct_messages.image_url as before (that string is just a URL
-- constructed client-side from the key -- it has no dependency on the
-- bucket's actual public/private flag, and this migration does not alter
-- any already-stored row). This migration only changes server-side
-- storage access control; it does not touch direct_messages RLS,
-- send_direct_message, or any other bucket.

UPDATE storage.buckets SET public = false WHERE id = 'direct_messages';

DROP POLICY IF EXISTS storage_objects_dm_select ON storage.objects;

CREATE POLICY storage_objects_dm_select ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'direct_messages'
    AND (
      owner_id = (SELECT auth.uid())::text
      OR EXISTS (
        SELECT 1
        FROM public.direct_messages dm
        WHERE dm.image_url LIKE '%/' || storage.objects.name
          AND (dm.sender_id = (SELECT auth.uid()) OR dm.recipient_id = (SELECT auth.uid()))
      )
    )
  );
