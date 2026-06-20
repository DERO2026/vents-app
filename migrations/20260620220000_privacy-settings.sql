CREATE TABLE IF NOT EXISTS public.user_privacy_settings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  profile_visible       TEXT NOT NULL DEFAULT 'everyone' CHECK (profile_visible IN ('everyone','followers','nobody')),
  can_message           TEXT NOT NULL DEFAULT 'everyone' CHECK (can_message IN ('everyone','followers','nobody')),
  show_in_search        BOOLEAN NOT NULL DEFAULT true,
  show_attended_events  BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_privacy_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY ups_own ON public.user_privacy_settings
  FOR ALL USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE ON public.user_privacy_settings TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_privacy_settings(
  p_profile_visible TEXT DEFAULT 'everyone',
  p_can_message TEXT DEFAULT 'everyone',
  p_show_in_search BOOLEAN DEFAULT true,
  p_show_attended_events BOOLEAN DEFAULT true
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO user_privacy_settings(user_id, profile_visible, can_message, show_in_search, show_attended_events)
  VALUES (auth.uid(), p_profile_visible, p_can_message, p_show_in_search, p_show_attended_events)
  ON CONFLICT (user_id) DO UPDATE SET
    profile_visible = EXCLUDED.profile_visible,
    can_message = EXCLUDED.can_message,
    show_in_search = EXCLUDED.show_in_search,
    show_attended_events = EXCLUDED.show_attended_events,
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_privacy_settings(TEXT, TEXT, BOOLEAN, BOOLEAN) TO authenticated;
