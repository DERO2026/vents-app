-- Tighten check_user_role_update to block ALL direct role changes via REST
-- for authenticated users. Only SECURITY DEFINER functions (promote_to_organizer,
-- admin_set_user_role) are allowed to change roles — they run as function owner,
-- so current_user <> 'authenticated' inside them.

CREATE OR REPLACE FUNCTION public.check_user_role_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- SECURITY DEFINER functions run as their owner (not 'authenticated'),
  -- so they bypass this check entirely.
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  -- Block ALL direct role changes via REST for authenticated users.
  -- Promotion must go through promote_to_organizer() or admin_set_user_role().
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    RAISE EXCEPTION 'Role changes must go through the proper promotion or admin function';
  END IF;

  RETURN NEW;
END;
$$;
