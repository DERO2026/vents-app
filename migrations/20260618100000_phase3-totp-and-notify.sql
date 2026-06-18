-- Phase 3: TOTP 2FA columns + follow-notification helper function

-- 3.1 TOTP columns on users table
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS totp_secret TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- 3.6 Helper: insert a notification for another user (follows, ticket confirmations)
-- Runs as SECURITY DEFINER so the caller (user A) can insert a notification
-- for user B without violating the user_id = auth.uid() RLS policy.
CREATE OR REPLACE FUNCTION public.notify_user(
  p_user_id UUID,
  p_type    TEXT,
  p_title   TEXT,
  p_body    TEXT,
  p_icon    TEXT DEFAULT '🔔'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body, icon)
  VALUES (p_user_id, p_type, p_title, p_body, p_icon);
END;
$$;

REVOKE ALL ON FUNCTION public.notify_user(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_user(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
