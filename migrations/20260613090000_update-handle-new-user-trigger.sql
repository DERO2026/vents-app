-- Update handle_new_user trigger to parse json from NEW.profile->>'name'
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  profile_json JSON;
  parsed_name TEXT;
  parsed_role TEXT;
  parsed_username TEXT;
  parsed_phone TEXT;
  parsed_state TEXT;
  name_val TEXT;
BEGIN
  name_val := COALESCE(NEW.profile->>'name', NEW.profile->>'full_name');
  
  IF name_val LIKE '{%}' THEN
    BEGIN
      profile_json := name_val::json;
      parsed_name := profile_json->>'name';
      parsed_role := profile_json->>'role';
      parsed_username := profile_json->>'username';
      parsed_phone := profile_json->>'phone_number';
      parsed_state := profile_json->>'state';
    EXCEPTION WHEN OTHERS THEN
      parsed_name := name_val;
      parsed_role := COALESCE(NEW.profile->>'role', 'user');
      parsed_username := NEW.profile->>'username';
      parsed_phone := NEW.profile->>'phone_number';
      parsed_state := NEW.profile->>'state';
    END;
  ELSE
    parsed_name := name_val;
    parsed_role := COALESCE(NEW.profile->>'role', 'user');
    parsed_username := NEW.profile->>'username';
    parsed_phone := NEW.profile->>'phone_number';
    parsed_state := NEW.profile->>'state';
  END IF;

  IF parsed_role IS NULL THEN
    parsed_role := 'user';
  END IF;

  INSERT INTO public.users (id, email, full_name, role, avatar_url, username, phone_number, state)
  VALUES (
    NEW.id,
    NEW.email,
    parsed_name,
    parsed_role,
    NEW.profile->>'avatar_url',
    parsed_username,
    parsed_phone,
    parsed_state
  )
  ON CONFLICT (id) DO UPDATE
  SET
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    username = EXCLUDED.username,
    phone_number = EXCLUDED.phone_number,
    state = EXCLUDED.state;
  RETURN NEW;
END;
$$;
