-- 0200: revoke anon EXECUTE on Realtime trigger functions.
--
-- These functions are invoked by triggers and do not need to be callable by
-- anonymous clients. Keep the existing grants for postgres, authenticated,
-- and project_admin unchanged.

REVOKE EXECUTE ON FUNCTION public.notify_new_direct_message() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_new_notification() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_vc_update() FROM anon;
