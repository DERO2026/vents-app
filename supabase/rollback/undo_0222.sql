-- Undo 0222 only (supabase/migrations/0222_announcements_drafts_publish.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0222';
--   \i supabase/rollback/undo_0222.sql
-- Drops exactly what 0222 created: the three admin functions and the
-- public.announcements table (its policy and index go with it). Touches no
-- other table, function, grant or data.
--
-- What survives the undo (by design):
--   * Notifications already delivered by admin_publish_announcement stay in
--     every recipient's feed (public.notifications is not touched). They
--     keep push_data {type:'announcement', announcementId, screen}; the app
--     still opens them in the announcement reader from the notification row
--     itself, so nothing breaks for recipients.
--   * admin_send_announcement (0191) is untouched; the admin panel detects
--     the missing table and falls back to it automatically.
-- What is lost:
--   * Unpublished drafts, and the stored history of published announcements
--     (the admin_logs 'announcement_published' entries remain).
-- If any drafts exist the undo also requires
--   SET vents.rollback_discard_drafts = 'yes';
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0222' THEN
    RAISE EXCEPTION 'undo_0222 refused: set vents.rollback_confirm = ''undo-0222'' to confirm';
  END IF;
  IF to_regclass('public.announcements') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.announcements WHERE status = 'draft')
       AND current_setting('vents.rollback_discard_drafts', true) IS DISTINCT FROM 'yes' THEN
      RAISE EXCEPTION 'undo_0222 refused: % unpublished draft(s) would be discarded. Set vents.rollback_discard_drafts = ''yes'' to proceed',
        (SELECT count(*) FROM public.announcements WHERE status = 'draft');
    END IF;
  END IF;
END
$undo$;

DROP FUNCTION IF EXISTS public.admin_publish_announcement(uuid);
DROP FUNCTION IF EXISTS public.admin_delete_announcement_draft(uuid);
DROP FUNCTION IF EXISTS public.admin_save_announcement_draft(uuid, text, text, text);
DROP TABLE IF EXISTS public.announcements;
