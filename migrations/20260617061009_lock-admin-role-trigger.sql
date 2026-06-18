-- Permanent DB-level lock: the ROOT admin account role can never be changed
-- by any code path, regardless of which trigger or UPDATE path runs.
CREATE OR REPLACE FUNCTION public.lock_admin_root_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If this is the root admin account, force role back to 'admin' on any UPDATE
  IF NEW.id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' AND NEW.role <> 'admin' THEN
    NEW.role := 'admin';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_admin_root_role ON public.users;
CREATE TRIGGER trg_lock_admin_root_role
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.lock_admin_root_role();
