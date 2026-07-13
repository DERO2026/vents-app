-- upsert_privacy_settings() has been broken since the blanket SECURITY
-- DEFINER search_path lockdown (migrations/20260625063035_lock-secdef-search-path.sql:36
-- set it to search_path = '') without schema-qualifying its table reference,
-- unlike _vc_deduct() which got a matching follow-up fix
-- (20260626043234_fix-vc-deduct-search-path.sql) that this function never
-- received. Every call has been failing with "relation
-- \"user_privacy_settings\" does not exist" (42P01) -- confirmed live via a
-- real authenticated RPC call -- even though the table itself is fine.
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
  INSERT INTO public.user_privacy_settings(user_id, profile_visible, can_message, show_in_search, show_attended_events)
  VALUES (auth.uid(), p_profile_visible, p_can_message, p_show_in_search, p_show_attended_events)
  ON CONFLICT (user_id) DO UPDATE SET
    profile_visible = EXCLUDED.profile_visible,
    can_message = EXCLUDED.can_message,
    show_in_search = EXCLUDED.show_in_search,
    show_attended_events = EXCLUDED.show_attended_events,
    updated_at = now();
END;
$$;
