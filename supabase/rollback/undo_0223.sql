-- Undo 0223 only (supabase/migrations/0223_announcement_internal_test_audience.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0223';
--   \i supabase/rollback/undo_0223.sql
-- Restores admin_save_announcement_draft and admin_publish_announcement to
-- their exact 0222 bodies (grants are kept by CREATE OR REPLACE), restores
-- 0222's audience CHECK, and drops the three recipient functions and
-- public.announcement_test_recipients. 0222's announcements table, drafts
-- and published history for the three production audiences are untouched.
--
-- Survives the undo: notifications already delivered to internal test
-- recipients (public.notifications is not touched) and the admin_logs
-- entries for recipient changes and publishes.
-- Lost: the recipient allowlist, and any announcements rows with audience
-- 'internal_test' -- 0222's CHECK cannot hold them, so the undo refuses
-- while any exist unless
--   SET vents.rollback_discard_internal_test = 'yes';
-- is also set, in which case only those rows are deleted.
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0223' THEN
    RAISE EXCEPTION 'undo_0223 refused: set vents.rollback_confirm = ''undo-0223'' to confirm';
  END IF;
  IF to_regclass('public.announcements') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.announcements WHERE audience = 'internal_test')
     AND current_setting('vents.rollback_discard_internal_test', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'undo_0223 refused: % internal_test announcement(s) would be deleted. Set vents.rollback_discard_internal_test = ''yes'' to proceed',
      (SELECT count(*) FROM public.announcements WHERE audience = 'internal_test');
  END IF;
END
$undo$;

DELETE FROM public.announcements WHERE audience = 'internal_test';

ALTER TABLE public.announcements DROP CONSTRAINT announcements_audience_check;
ALTER TABLE public.announcements ADD CONSTRAINT announcements_audience_check
  CHECK (audience IN ('everyone', 'organizers', 'service_providers'));

-- The 0222 bodies, verbatim (supabase/migrations/0222_announcements_drafts_publish.sql).

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
  IF NOT COALESCE(public.is_admin_or_root(), false) THEN
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
  IF NOT COALESCE(public.is_admin_or_root(), false) THEN
    RAISE EXCEPTION 'Only admins can publish announcements';
  END IF;

  SELECT * INTO v_ann FROM public.announcements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Announcement not found'; END IF;
  IF v_ann.status <> 'draft' THEN
    RAISE EXCEPTION 'Announcement is already published';
  END IF;

  -- Same limiter as 0191, own key: stops a runaway client loop.
  PERFORM public.check_rate_limit('admin_publish_announcement:' || v_admin_id::text, 10, 300);

  -- type/announcementId: new builds open this announcement's reader.
  -- screen: older builds, which do not know 'announcement', fall back to
  -- their existing 'notifications' route instead of doing nothing.
  v_push := jsonb_build_object('type', 'announcement', 'announcementId', v_ann.id::text, 'screen', 'notifications');

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

DROP FUNCTION IF EXISTS public.admin_list_announcement_test_recipients();
DROP FUNCTION IF EXISTS public.admin_remove_announcement_test_recipient(uuid);
DROP FUNCTION IF EXISTS public.admin_add_announcement_test_recipient(uuid);
DROP TABLE IF EXISTS public.announcement_test_recipients;
