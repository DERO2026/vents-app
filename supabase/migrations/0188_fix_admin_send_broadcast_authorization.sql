-- Fix an authorization inconsistency in admin_send_broadcast(), the live
-- function backing AdminSystemScreen.tsx's "Broadcast" action (called via
-- its thin wrapper admin_broadcast()).
--
-- The bug: this function is the ONLY admin RPC in this schema that gates
-- itself with a bespoke literal check --
--   SELECT 1 FROM public.users WHERE id = v_admin_id AND role = 'admin'
-- -- instead of calling one of the established helpers (is_admin(),
-- is_super_admin(), is_admin_or_root()) every other admin RPC uses
-- (admin_set_event_trending, approve_admin_action,
-- admin_reject_organizer_payout, etc.). Confirmed live via
-- pg_get_functiondef that this is the function's entire, exact body today
-- -- no other logic changes.
--
-- Why is_admin_or_root() (not is_admin()) is the correct replacement:
--   is_admin_or_root() == is_super_admin() == is_root() OR role = 'admin'
--   is_admin()          == is_root() OR role IN ('admin', 'sub-admin')
-- The UI already gates this action to Root only (AdminConsoleShell.render.
-- test.tsx's own comment: "Global Broadcast... is root-only"), confirming
-- the intended policy is Super-Admin-tier, not the broader is_admin() tier
-- that would additionally let Sub-Admins in. is_admin_or_root() is the
-- exact existing helper for that tier, used by admin_set_event_trending,
-- approve_admin_action, admin_reject_organizer_payout, and
-- admin_cancel_processing_payout.
--
-- Behavior change for the live, single root account
-- (c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832): NONE. That account's own
-- `users.role` is already 'admin' live, so the old check (`role = 'admin'`)
-- and the new one (`is_root() OR role = 'admin'`) resolve to the exact
-- same true/false outcome for every current user in production --
-- confirmed by querying live `public.users` for every row with
-- role IN ('admin', 'sub-admin') before writing this migration. The only
-- thing that changes is robustness: the new check still grants access if
-- the root account's own `role` column were ever changed away from
-- 'admin' (today a dead branch, matching every other Super-Admin-gated
-- RPC's own belt-and-suspenders use of is_root() OR role check). No
-- Sub-Admin, and no other new role, gains access.
--
-- Everything else -- the broadcast INSERT ... SELECT shape and its
-- `u.role <> 'admin'` recipient filter, the admin_logs audit insert, and
-- the returned jsonb shape -- is copied verbatim from the live body. This
-- migration touches only the one authorization line.

CREATE OR REPLACE FUNCTION public.admin_send_broadcast(p_title text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin_id uuid;
  v_count    int;
BEGIN
  v_admin_id := auth.uid();
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only admins can send broadcasts';
  END IF;

  INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at)
  SELECT
    gen_random_uuid(),
    u.id,
    'broadcast',
    p_title,
    p_body,
    false,
    '📢',
    now()
  FROM public.users u
  WHERE u.role <> 'admin';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.admin_logs (id, admin_id, action, target_user_id, details, created_at)
  VALUES (
    gen_random_uuid(),
    v_admin_id,
    'broadcast_sent',
    NULL,
    jsonb_build_object('title', p_title, 'body', p_body, 'recipients', v_count),
    now()
  );

  RETURN jsonb_build_object('success', true, 'recipients', v_count);
END;
$function$;
