-- Fix role-change trigger: allow attendee/user → organizer promotion.
-- Previous logic blocked ALL role changes once any of the role values was set,
-- including the legitimate attendee→organizer promotion path.
-- New logic: only block organizer/organiser downgrade and →admin escalation.

CREATE OR REPLACE FUNCTION public.check_user_role_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Never allow escalation to admin via normal update
  IF NEW.role = 'admin' AND (OLD.role IS DISTINCT FROM 'admin') THEN
    RAISE EXCEPTION 'Cannot escalate role to admin';
  END IF;

  -- Block downgrade: once organizer, cannot revert to attendee/user
  IF OLD.role IN ('organizer', 'organiser') AND NEW.role NOT IN ('organizer', 'organiser', 'admin') THEN
    RAISE EXCEPTION 'Organizer role cannot be downgraded';
  END IF;

  RETURN NEW;
END;
$$;
