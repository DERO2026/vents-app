-- 1. Drop existing role check constraint and create a new one that supports 'organiser' spelling
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'attendee', 'organizer', 'organiser', 'admin'));

-- 2. Create trigger function to validate role updates
CREATE OR REPLACE FUNCTION public.check_user_role_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Prevent escalation to admin
  IF NEW.role = 'admin' AND (OLD.role IS DISTINCT FROM 'admin') THEN
    RAISE EXCEPTION 'Cannot escalate role to admin';
  END IF;
  
  -- Prevent role switching after it has already been set
  IF (OLD.role IN ('attendee', 'organizer', 'organiser')) AND (NEW.role IS DISTINCT FROM OLD.role) THEN
    RAISE EXCEPTION 'Role has already been set and cannot be changed';
  END IF;
  
  RETURN NEW;
END;
$$;

-- 3. Create before update trigger for role checks
DROP TRIGGER IF EXISTS trg_check_user_role_update ON public.users;
CREATE TRIGGER trg_check_user_role_update
  BEFORE UPDATE OF role ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.check_user_role_update();

-- 4. Grant update privilege on role column to authenticated users
GRANT UPDATE (role) ON public.users TO authenticated;
