-- Update purchase_badge to support all 6 tiers: bronze, silver, gold, platinum, elite, legend
CREATE OR REPLACE FUNCTION public.purchase_badge(p_badge_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_uid        uuid    := auth.uid();
  v_cost       integer;
  v_tier_order text[]  := ARRAY['bronze','silver','gold','platinum','elite','legend'];
  v_current_idx integer;
  v_new_idx     integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_badge_type NOT IN ('bronze','silver','gold','platinum','elite','legend') THEN
    RAISE EXCEPTION 'Invalid badge type: %', p_badge_type;
  END IF;

  v_cost := CASE p_badge_type
    WHEN 'bronze'   THEN 300
    WHEN 'silver'   THEN 800
    WHEN 'gold'     THEN 2000
    WHEN 'platinum' THEN 5000
    WHEN 'elite'    THEN 12000
    WHEN 'legend'   THEN 25000
    ELSE 0
  END;

  SELECT array_position(v_tier_order, vc_badge) INTO v_current_idx
  FROM public.users WHERE id = v_uid;

  v_new_idx := array_position(v_tier_order, p_badge_type);

  IF v_current_idx IS NOT NULL AND v_new_idx < v_current_idx THEN
    RAISE EXCEPTION 'Cannot downgrade badge';
  END IF;

  PERFORM public._vc_deduct(v_uid, v_cost, 'Badge: ' || p_badge_type);

  UPDATE public.users SET vc_badge = p_badge_type WHERE id = v_uid;

  INSERT INTO public.vc_bonuses (user_id, bonus_type) VALUES (v_uid, 'badge_' || p_badge_type)
  ON CONFLICT (user_id, bonus_type) DO UPDATE SET granted_at = now();
END;
$$;
