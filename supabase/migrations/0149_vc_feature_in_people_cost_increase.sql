-- VENTS Cents: the "People" reward/cost -- identified by tracing every
-- "150 VC" reference in the codebase to a single authoritative source:
-- feature_in_people_vc(), the spend-cost function behind the "Featured in
-- People" feature (appear at the top of the People section in Explore for
-- 3 days). This is NOT a reward campaign in vc_reward_campaigns (that table
-- only models earn campaigns); it is a hardcoded spend amount passed
-- directly to _vc_deduct(). Confirmed by a prior migration's own title
-- (fix-feature-in-people-cost-150.sql) that this is where the 150 VC price
-- point has lived since it was introduced.
--
-- Changes the cost from 150 VC to 1,500 VC. No other behavior changes:
-- still a plain VC spend (_vc_deduct), still never touches
-- vc_lifetime_earned, still never touches the system pool (ordinary
-- spending was never pool-accounted -- only issuance is), still the same
-- 3-day featured-duration logic.
CREATE OR REPLACE FUNCTION public.feature_in_people_vc()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  PERFORM public._vc_deduct(v_uid, 1500, 'Featured in People (3 days)');

  UPDATE public.users
  SET vc_featured_until = GREATEST(COALESCE(vc_featured_until, now()), now()) + INTERVAL '3 days'
  WHERE id = v_uid;
END;
$function$;
