-- Real per-user social handles (Instagram/X/TikTok) backing the "Connected
-- Accounts" settings screen. Distinct from the existing static "Follow
-- VENTS on Instagram/X/TikTok" resource links in SettingsScreen, which
-- point at VENTS' own corporate accounts and are untouched by this
-- migration -- these columns are the user's own handles, shown on their
-- public organizer profile.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS instagram_handle text,
  ADD COLUMN IF NOT EXISTS x_handle text,
  ADD COLUMN IF NOT EXISTS tiktok_handle text;

ALTER TABLE public.users
  ADD CONSTRAINT users_instagram_handle_format CHECK (instagram_handle IS NULL OR instagram_handle ~ '^[A-Za-z0-9._]{1,30}$'),
  ADD CONSTRAINT users_x_handle_format CHECK (x_handle IS NULL OR x_handle ~ '^[A-Za-z0-9_]{1,15}$'),
  ADD CONSTRAINT users_tiktok_handle_format CHECK (tiktok_handle IS NULL OR tiktok_handle ~ '^[A-Za-z0-9._]{1,24}$');

COMMENT ON COLUMN public.users.instagram_handle IS 'User''s own Instagram handle (no leading @), shown on their public organizer profile.';
COMMENT ON COLUMN public.users.x_handle IS 'User''s own X/Twitter handle (no leading @), shown on their public organizer profile.';
COMMENT ON COLUMN public.users.tiktok_handle IS 'User''s own TikTok handle (no leading @), shown on their public organizer profile.';

-- Extend the existing input-validation trigger function so these new
-- columns get the same length ceiling and injection-pattern rejection as
-- every other free-text profile field (full_name, bio).
CREATE OR REPLACE FUNCTION public.validate_users_input()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.full_name IS NOT NULL AND length(NEW.full_name) > 100 THEN
    RAISE EXCEPTION 'Full name must be 100 characters or fewer';
  END IF;
  IF NEW.bio IS NOT NULL AND length(NEW.bio) > 500 THEN
    RAISE EXCEPTION 'Bio must be 500 characters or fewer';
  END IF;

  PERFORM public.reject_injection_patterns('full_name', NEW.full_name);
  PERFORM public.reject_injection_patterns('bio', NEW.bio);
  PERFORM public.reject_injection_patterns('instagram_handle', NEW.instagram_handle);
  PERFORM public.reject_injection_patterns('x_handle', NEW.x_handle);
  PERFORM public.reject_injection_patterns('tiktok_handle', NEW.tiktok_handle);

  RETURN NEW;
END;
$function$
;
