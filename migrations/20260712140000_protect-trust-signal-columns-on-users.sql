-- Zero-trust gap found during Phase 3 audit: the users table's
-- update_own_user RLS policy ("auth.uid() = id") has no column-level
-- restriction, so any authenticated user can PATCH their own row directly
-- and set is_verified = true, or set vc_badge / vc_featured_until, even
-- though the app's actual intent is that these are ONLY ever granted by
-- admin_approve_organizer_verification() (admin-gated) or
-- purchase_badge() / feature_in_people_vc() (paid-with-VC RPCs). A user
-- could otherwise self-grant a fake "verified organizer" checkmark or a
-- badge they never paid for with a single unauthenticated-of-intent table
-- write, bypassing every check those RPCs perform.
--
-- Same bypass pattern already used by check_user_role_update(): all three
-- legitimate setters (admin_approve_organizer_verification, purchase_badge,
-- feature_in_people_vc) are SECURITY DEFINER, so they run as the function
-- owner, not 'authenticated' -- this trigger only blocks direct
-- REST/SDK table writes from a normal user session, not RPC-mediated ones.
CREATE OR REPLACE FUNCTION public.protect_trust_signal_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.is_verified IS DISTINCT FROM NEW.is_verified THEN
    RAISE EXCEPTION 'is_verified can only be changed via organizer verification approval';
  END IF;
  IF OLD.vc_badge IS DISTINCT FROM NEW.vc_badge THEN
    RAISE EXCEPTION 'vc_badge can only be changed via purchase_badge()';
  END IF;
  IF OLD.vc_featured_until IS DISTINCT FROM NEW.vc_featured_until THEN
    RAISE EXCEPTION 'vc_featured_until can only be changed via feature_in_people_vc()';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_trust_signal_columns ON public.users;
CREATE TRIGGER trg_protect_trust_signal_columns
  BEFORE UPDATE OF is_verified, vc_badge, vc_featured_until ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.protect_trust_signal_columns();
