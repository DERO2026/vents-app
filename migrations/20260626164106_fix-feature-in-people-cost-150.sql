-- Change Featured in People cost from 1500 VC to 150 VC
CREATE OR REPLACE FUNCTION public.feature_in_people_vc()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  PERFORM public._vc_deduct(v_uid, 150, 'Featured in People (3 days)');

  UPDATE public.users
  SET vc_featured_until = GREATEST(COALESCE(vc_featured_until, now()), now()) + INTERVAL '3 days'
  WHERE id = v_uid;
END;
$$;
