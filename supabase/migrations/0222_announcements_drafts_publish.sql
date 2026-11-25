-- 0222: Announcements Centre -- stored announcements with draft -> publish.
--
-- What already existed (unchanged by this file):
--   * notifications (0002) + NotificationsScreen: per-user feed, read/unread,
--     unread badge, realtime, push delivery (type-agnostic: every row with
--     push_sent = false is pushed, push_data rides along -- 0162).
--   * announcement_groups / announcement_group_members / announcement_mutes
--     (0189) kept in sync with users.is_organizer/is_service_provider (0190).
--   * admin_send_announcement(audience, title, body) (0191, type fix 0198):
--     immediate fan-out into notifications. Left in place untouched --
--     installed native app builds still call it.
--
-- What was missing, added here:
--   * A stored announcement record, so an admin can write a DRAFT, come
--     back and EDIT it, and PUBLISH it later. Before this, an announcement
--     only existed as N copies inside recipients' notifications.
--   * A link from each delivered notification back to its announcement
--     (push_data = {type:'announcement', announcementId}), so a push tap or
--     an in-app tap opens the announcement reader.
--
-- Design decisions:
--   * Delivery reuses the notifications table and its push pipeline -- no
--     second notification system. The fan-out is the same three static
--     branches as 0191 (same populations, same mute anti-joins, same types:
--     'broadcast' for everyone, 'announcement' for role audiences), so
--     recipients see an announcement exactly as before.
--   * Published announcements are IMMUTABLE. Recipients already received
--     the text (in-app and by push); silently rewriting it afterwards would
--     misrepresent what was sent. A correction is a new announcement.
--   * Users never read this table. Recipients read their own notification
--     rows (existing RLS); this table holds drafts that must never leak, so
--     only is_admin_or_root() can SELECT it, and nobody can write it except
--     through the SECURITY DEFINER functions below.
--   * Authorization matches 0191: is_admin_or_root() (Super Admin tier;
--     Sub-Admins excluded) for every function, checked first.
--   * Publish is race-safe and idempotent: the row is locked FOR UPDATE and
--     must still be a draft, so two concurrent publishes cannot double-send.
--
-- Production: NOT applied by this change. Apply only with owner approval.

CREATE TABLE public.announcements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  body         text NOT NULL,
  audience     text NOT NULL,
  status       text NOT NULL DEFAULT 'draft',
  created_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  recipients   integer,
  CONSTRAINT announcements_audience_check CHECK (audience IN ('everyone', 'organizers', 'service_providers')),
  CONSTRAINT announcements_status_check CHECK (status IN ('draft', 'published')),
  CONSTRAINT announcements_title_len CHECK (char_length(title) BETWEEN 1 AND 80),
  CONSTRAINT announcements_body_len CHECK (char_length(body) BETWEEN 1 AND 500),
  CONSTRAINT announcements_published_shape CHECK (
    (status = 'draft' AND published_at IS NULL AND recipients IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND recipients IS NOT NULL)
  )
);

CREATE INDEX idx_announcements_status_updated ON public.announcements (status, updated_at DESC);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_announcements_admin ON public.announcements
  FOR SELECT TO authenticated
  USING (public.is_admin_or_root());

-- Platform default grants are broad (see 0012); close them, then grant back
-- SELECT only. No client role can INSERT/UPDATE/DELETE -- only the
-- SECURITY DEFINER functions below write this table.
REVOKE ALL ON public.announcements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.announcements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.announcements TO project_admin;

-- ── admin_save_announcement_draft ──────────────────────────────────────────
-- p_id NULL creates a draft; otherwise updates that draft. Published
-- announcements cannot be edited.
CREATE OR REPLACE FUNCTION public.admin_save_announcement_draft(p_id uuid, p_audience text, p_title text, p_body text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin_id uuid := auth.uid();
  v_title    text := trim(COALESCE(p_title, ''));
  v_body     text := trim(COALESCE(p_body, ''));
  v_status   text;
  v_id       uuid;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only admins can manage announcements';
  END IF;

  IF p_audience IS NULL OR p_audience NOT IN ('everyone', 'organizers', 'service_providers') THEN
    RAISE EXCEPTION 'Invalid audience: %', p_audience;
  END IF;
  IF v_title = '' THEN RAISE EXCEPTION 'Title is required'; END IF;
  IF length(v_title) > 80 THEN RAISE EXCEPTION 'Title must be 80 characters or fewer'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'Message is required'; END IF;
  IF length(v_body) > 500 THEN RAISE EXCEPTION 'Message must be 500 characters or fewer'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.announcements (title, body, audience, status, created_by, updated_by)
    VALUES (v_title, v_body, p_audience, 'draft', v_admin_id, v_admin_id)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  SELECT status INTO v_status FROM public.announcements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Announcement not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Published announcements cannot be edited';
  END IF;

  UPDATE public.announcements
     SET title = v_title, body = v_body, audience = p_audience,
         updated_by = v_admin_id, updated_at = now()
   WHERE id = p_id;
  RETURN p_id;
END;
$function$;

-- ── admin_delete_announcement_draft ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_delete_announcement_draft(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only admins can manage announcements';
  END IF;
  SELECT status INTO v_status FROM public.announcements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Announcement not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Published announcements cannot be deleted';
  END IF;
  DELETE FROM public.announcements WHERE id = p_id;
END;
$function$;

-- ── admin_publish_announcement ─────────────────────────────────────────────
-- Delivers a draft to its audience through the existing notifications feed
-- (and therefore push), exactly like 0191's fan-out, then marks it
-- published. Runs in one transaction: either every recipient row is
-- written and the announcement is published, or nothing changes.
CREATE OR REPLACE FUNCTION public.admin_publish_announcement(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin_id uuid := auth.uid();
  v_ann      public.announcements%ROWTYPE;
  v_push     jsonb;
  v_count    int;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only admins can publish announcements';
  END IF;

  SELECT * INTO v_ann FROM public.announcements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Announcement not found'; END IF;
  IF v_ann.status <> 'draft' THEN
    RAISE EXCEPTION 'Announcement is already published';
  END IF;

  -- Same limiter as 0191, own key: stops a runaway client loop.
  PERFORM public.check_rate_limit('admin_publish_announcement:' || v_admin_id::text, 10, 300);

  v_push := jsonb_build_object('type', 'announcement', 'announcementId', v_ann.id::text);

  CASE v_ann.audience
    WHEN 'everyone' THEN
      INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at, push_data)
      SELECT gen_random_uuid(), u.id, 'broadcast', v_ann.title, v_ann.body, false, '📢', now(), v_push
      FROM public.users u
      WHERE u.role <> 'admin';

    WHEN 'organizers' THEN
      INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at, push_data)
      SELECT gen_random_uuid(), m.user_id, 'announcement', v_ann.title, v_ann.body, false, '📢', now(), v_push
      FROM public.announcement_group_members m
      JOIN public.announcement_groups g ON g.id = m.group_id AND g.key = 'organizers'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.announcement_mutes mu
        WHERE mu.user_id = m.user_id AND mu.group_id = m.group_id
      );

    WHEN 'service_providers' THEN
      INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at, push_data)
      SELECT gen_random_uuid(), m.user_id, 'announcement', v_ann.title, v_ann.body, false, '📢', now(), v_push
      FROM public.announcement_group_members m
      JOIN public.announcement_groups g ON g.id = m.group_id AND g.key = 'service_providers'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.announcement_mutes mu
        WHERE mu.user_id = m.user_id AND mu.group_id = m.group_id
      );
  END CASE;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.announcements
     SET status = 'published', published_at = now(), published_by = v_admin_id,
         recipients = v_count, updated_at = now()
   WHERE id = v_ann.id;

  INSERT INTO public.admin_logs (id, admin_id, action, target_user_id, details, created_at)
  VALUES (
    gen_random_uuid(), v_admin_id, 'announcement_published', NULL,
    jsonb_build_object('announcement_id', v_ann.id, 'audience', v_ann.audience,
                       'title', v_ann.title, 'recipients', v_count),
    now()
  );

  RETURN jsonb_build_object('success', true, 'recipients', v_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_save_announcement_draft(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_announcement_draft(uuid, text, text, text) TO authenticated, project_admin;
REVOKE ALL ON FUNCTION public.admin_delete_announcement_draft(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_announcement_draft(uuid) TO authenticated, project_admin;
REVOKE ALL ON FUNCTION public.admin_publish_announcement(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_publish_announcement(uuid) TO authenticated, project_admin;
