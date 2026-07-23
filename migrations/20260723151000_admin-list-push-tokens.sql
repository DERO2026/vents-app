-- ── Server-side read of a user's push tokens (for api/push/send) ─────────────
-- The device_push_tokens table is RLS deny-all. The send endpoint needs to read
-- a target user's tokens; expose that only through a SECURITY DEFINER RPC gated
-- to Super Admins (is_super_admin), matching who can trigger a broadcast/send.
-- Also returns platform so the sender can shape per-platform payloads.

CREATE OR REPLACE FUNCTION public.admin_list_push_tokens(p_user_id uuid)
  RETURNS TABLE(token text, platform text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  RETURN QUERY
  SELECT t.token, t.platform
  FROM public.device_push_tokens t
  WHERE t.user_id = p_user_id;
END; $fn$;

-- Prune a token the FCM API reported as permanently invalid (UNREGISTERED).
CREATE OR REPLACE FUNCTION public.admin_prune_push_token(p_token text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  DELETE FROM public.device_push_tokens WHERE token = p_token;
END; $fn$;
