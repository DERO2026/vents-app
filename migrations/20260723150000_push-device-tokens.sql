-- ── Native push: device token registry ──────────────────────────────────────
-- Stores the FCM device tokens the app registers after login, so the backend
-- (api/push/send) can deliver notifications to a user's devices. One row per
-- (user, token); re-registering the same token just refreshes last_seen.

CREATE TABLE IF NOT EXISTS public.device_push_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token       text NOT NULL,
  platform    text NOT NULL DEFAULT 'android',
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user ON public.device_push_tokens(user_id);

ALTER TABLE public.device_push_tokens ENABLE ROW LEVEL SECURITY;
-- No direct table access from clients; all writes go through the RPCs below,
-- and sends run server-side with the service role. (No policies = deny all.)

-- Upsert a token for the calling user. A token can move between users (device
-- handed over / re-login), so conflict on the unique token re-points ownership.
CREATE OR REPLACE FUNCTION public.register_push_token(p_user_id uuid, p_token text, p_platform text DEFAULT 'android')
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  -- Only the authenticated user may register a token for themselves.
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized to register a token for this user';
  END IF;
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RAISE EXCEPTION 'Empty push token';
  END IF;

  INSERT INTO public.device_push_tokens (user_id, token, platform, last_seen)
  VALUES (p_user_id, p_token, COALESCE(NULLIF(p_platform, ''), 'android'), now())
  ON CONFLICT (token) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        last_seen = now();
END; $fn$;

-- Drop every token for the calling user (logout).
CREATE OR REPLACE FUNCTION public.remove_push_tokens_for_user(p_user_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  DELETE FROM public.device_push_tokens WHERE user_id = p_user_id;
END; $fn$;
