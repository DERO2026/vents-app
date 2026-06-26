-- Fix handle_new_user: read role from raw_user_meta_data instead of hardcoding 'attendee'
-- Only allows 'attendee' or 'organizer' — never elevates to admin/root via metadata.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := CASE
    WHEN NEW.raw_user_meta_data->>'role' = 'organizer' THEN 'organizer'
    ELSE 'attendee'
  END;
  INSERT INTO public.users (id, email, role)
  VALUES (NEW.id, NEW.email, v_role);
  RETURN NEW;
END;
$$;
