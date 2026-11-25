-- 0223: Internal Test announcement audience.
--
-- Lets a Super Admin test the full announcement pipeline (draft -> publish ->
-- notifications -> push -> Announcements tab/reader) without reaching real
-- users. The three production audiences can't do that: 'everyone',
-- 'organizers' and 'service_providers' all include real customers.
--
-- What this adds (0222's three audiences are unchanged):
--   * public.announcement_test_recipients -- an explicit allowlist. RLS on,
--     no policies, no client grants: clients can neither read nor write it.
--   * Root-only management, each change written to admin_logs:
--       admin_add_announcement_test_recipient(user_id)
--       admin_remove_announcement_test_recipient(user_id)   (soft: active=false)
--     and a read for the admin panel (Super Admin tier, like publishing):
--       admin_list_announcement_test_recipients()
--   * audience 'internal_test' on public.announcements, accepted by
--     admin_save_announcement_draft and delivered by admin_publish_announcement
--     as type 'announcement' with the 📢 icon (so it lands in the
--     Announcements tab and reader like any announcement).
--
-- Safety:
--   * Recipients come ONLY from the allowlist -- never from a role, a group
--     or a flag -- so an organizer, service provider or customer receives an
--     internal test only if Root explicitly adds that account (logged).
--   * At most 10 active recipients: enforced when adding AND re-checked when
--     publishing. Publishing to an empty list is refused.
--   * Add/remove and the internal_test publish take the same transaction-
--     scoped advisory lock, so the count checked is the count delivered.
--   * Only accounts that exist, are not deleted and have status 'active' can
--     be added or receive it.
--   * admin_save_announcement_draft / admin_publish_announcement are
--     re-created from 0222 with ONLY these changes: 'internal_test' in the
--     audience allow-list, the internal_test safeguard block, and one new
--     CASE branch. The 'everyone', 'organizers' and 'service_providers'
--     branches are byte-identical to 0222 (checked by tests).
--   * Grants on the two re-created functions are preserved by CREATE OR
--     REPLACE (0222: authenticated + project_admin; anon never).
--
-- No recipients are seeded: designating the first account is a separate,
-- approved production action via admin_add_announcement_test_recipient.
--
-- Production: NOT applied by this change. Apply only with owner approval.
-- Rollback: supabase/rollback/undo_0223.sql.

CREATE TABLE public.announcement_test_recipients (
  user_id    uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  active     boolean NOT NULL DEFAULT true,
  added_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  removed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  removed_at timestamptz,
  CONSTRAINT announcement_test_recipients_removed_shape CHECK (
    (active AND removed_at IS NULL) OR (NOT active AND removed_at IS NOT NULL)
  )
);

ALTER TABLE public.announcement_test_recipients ENABLE ROW LEVEL SECURITY;
-- No policies and no client grants: only the SECURITY DEFINER functions
-- below touch this table.
REVOKE ALL ON public.announcement_test_recipients FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.announcement_test_recipients TO project_admin;

ALTER TABLE public.announcements DROP CONSTRAINT announcements_audience_check;
ALTER TABLE public.announcements ADD CONSTRAINT announcements_audience_check
  CHECK (audience IN ('everyone', 'organizers', 'service_providers', 'internal_test'));

-- ── admin_add_announcement_test_recipient ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_add_announcement_test_recipient(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_root_id uuid := auth.uid();
  v_active  int;
BEGIN
  IF NOT COALESCE(public.is_root(), false) THEN
    RAISE EXCEPTION 'Only Root can manage internal test recipients';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.announcement_test_recipients'));

  IF NOT EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = p_user_id AND u.deleted_at IS NULL AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION 'User not found or not active';
  END IF;

  IF EXISTS (SELECT 1 FROM public.announcement_test_recipients WHERE user_id = p_user_id AND active) THEN
    SELECT count(*) INTO v_active FROM public.announcement_test_recipients WHERE active;
    RETURN jsonb_build_object('success', true, 'already_active', true, 'active_recipients', v_active);
  END IF;

  SELECT count(*) INTO v_active FROM public.announcement_test_recipients WHERE active;
  IF v_active >= 10 THEN
    RAISE EXCEPTION 'Internal test audience is limited to 10 recipients';
  END IF;

  INSERT INTO public.announcement_test_recipients (user_id, active, added_by, added_at, removed_by, removed_at)
  VALUES (p_user_id, true, v_root_id, now(), NULL, NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET active = true, added_by = v_root_id, added_at = now(), removed_by = NULL, removed_at = NULL;

  v_active := v_active + 1;

  INSERT INTO public.admin_logs (id, admin_id, action, target_user_id, details, created_at)
  VALUES (gen_random_uuid(), v_root_id, 'announcement_test_recipient_added', p_user_id,
          jsonb_build_object('active_recipients', v_active), now());

  RETURN jsonb_build_object('success', true, 'already_active', false, 'active_recipients', v_active);
END;
$function$;

-- ── admin_remove_announcement_test_recipient ───────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_remove_announcement_test_recipient(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_root_id uuid := auth.uid();
  v_active  int;
BEGIN
  IF NOT COALESCE(public.is_root(), false) THEN
    RAISE EXCEPTION 'Only Root can manage internal test recipients';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.announcement_test_recipients'));

  UPDATE public.announcement_test_recipients
     SET active = false, removed_by = v_root_id, removed_at = now()
   WHERE user_id = p_user_id AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not an active internal test recipient';
  END IF;

  SELECT count(*) INTO v_active FROM public.announcement_test_recipients WHERE active;

  INSERT INTO public.admin_logs (id, admin_id, action, target_user_id, details, created_at)
  VALUES (gen_random_uuid(), v_root_id, 'announcement_test_recipient_removed', p_user_id,
          jsonb_build_object('active_recipients', v_active), now());

  RETURN jsonb_build_object('success', true, 'active_recipients', v_active);
END;
$function$;

-- ── admin_list_announcement_test_recipients ────────────────────────────────
-- The exact population an internal_test publish would reach (same filter),
-- for the admin panel's confirmation. Super Admin tier, like publishing.
CREATE OR REPLACE FUNCTION public.admin_list_announcement_test_recipients()
 RETURNS TABLE(user_id uuid, username text, added_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT COALESCE(public.is_admin_or_root(), false) THEN
    RAISE EXCEPTION 'Only admins can view internal test recipients';
  END IF;
  RETURN QUERY
    SELECT r.user_id, u.username, r.added_at
      FROM public.announcement_test_recipients r
      JOIN public.users u ON u.id = r.user_id
     WHERE r.active AND u.deleted_at IS NULL AND u.status = 'active'
     ORDER BY r.added_at;
END;
$function$;

-- ── admin_save_announcement_draft (0222 + 'internal_test' in the allow-list) ─
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

  IF p_audience IS NULL OR p_audience NOT IN ('everyone', 'organizers', 'service_providers', 'internal_test') THEN
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

-- ── admin_publish_announcement (0222 + internal_test safeguards and branch) ──
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

  -- Internal test (0223): explicitly designated accounts only. Serialized
  -- with recipient changes (same advisory lock as add/remove), then the
  -- empty-list and 10-recipient safeguards. Recipients never come from a
  -- role or a group.
  IF v_ann.audience = 'internal_test' THEN
    PERFORM pg_advisory_xact_lock(hashtext('public.announcement_test_recipients'));
    SELECT count(*) INTO v_count
      FROM public.announcement_test_recipients r
      JOIN public.users u ON u.id = r.user_id
     WHERE r.active AND u.deleted_at IS NULL AND u.status = 'active';
    IF v_count = 0 THEN
      RAISE EXCEPTION 'Internal test audience has no recipients';
    END IF;
    IF v_count > 10 THEN
      RAISE EXCEPTION 'Internal test audience exceeds the 10-recipient limit';
    END IF;
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

    WHEN 'internal_test' THEN
      -- 0223: only active, designated, non-deleted, active accounts.
      INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at, push_data)
      SELECT gen_random_uuid(), r.user_id, 'announcement', v_ann.title, v_ann.body, false, '📢', now(), v_push
      FROM public.announcement_test_recipients r
      JOIN public.users u ON u.id = r.user_id
      WHERE r.active AND u.deleted_at IS NULL AND u.status = 'active';
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

REVOKE ALL ON FUNCTION public.admin_add_announcement_test_recipient(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_announcement_test_recipient(uuid) TO authenticated, project_admin;
REVOKE ALL ON FUNCTION public.admin_remove_announcement_test_recipient(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_announcement_test_recipient(uuid) TO authenticated, project_admin;
REVOKE ALL ON FUNCTION public.admin_list_announcement_test_recipients() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_announcement_test_recipients() TO authenticated, project_admin;
