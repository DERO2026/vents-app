-- Production media pipeline — metadata store.
--
-- Binary image/video data is NEVER stored in Postgres. All media lives in the
-- S3-compatible InsForge Storage buckets (avatars / events / direct_messages /
-- highlights / verification-docs), uploaded directly from the client with a
-- JWT-signed request (Storage RLS authorizes the write). This table records
-- only the METADATA for each uploaded asset so the app can lazy-load
-- thumbnails, know intrinsic dimensions (no layout shift), and manage/delete
-- assets by key.

CREATE TABLE IF NOT EXISTS public.media_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url           text NOT NULL,          -- full-size object URL (public bucket)
  storage_key   text,                   -- object key (required for delete/download)
  thumbnail_url text,                    -- responsive thumbnail object URL
  thumbnail_key text,
  width         integer,                 -- intrinsic width of the stored full image
  height        integer,                 -- intrinsic height
  file_size     bigint,                  -- bytes of the stored full asset
  mime_type     text,
  user_id       uuid REFERENCES public.users(id)  ON DELETE SET NULL,
  event_id      uuid REFERENCES public.events(id) ON DELETE CASCADE,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_user     ON public.media_assets (user_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_event    ON public.media_assets (event_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_uploaded ON public.media_assets (uploaded_at DESC);

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

-- Insert only as yourself.
CREATE POLICY media_insert_own ON public.media_assets
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Read is public: these rows back public event fliers / avatars, and carry no
-- sensitive data (URLs already point at public buckets, plus dimensions/size).
CREATE POLICY media_select_all ON public.media_assets
  FOR SELECT TO anon, authenticated
  USING (true);

-- Only the uploader (or an admin) may delete their asset metadata.
CREATE POLICY media_delete_own ON public.media_assets
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_admin());
