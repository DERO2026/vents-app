-- Fix _vc_deduct: empty search_path caused "relation vc_transactions does not exist"
-- when called from purchase_badge. Recreate with schema-qualified table references.
CREATE OR REPLACE FUNCTION public._vc_deduct(
  p_user_id  uuid,
  p_amount   integer,
  p_reason   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_balance integer;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_balance
  FROM public.vc_transactions
  WHERE user_id = p_user_id AND status = 'active';

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient Vents Cents balance';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at)
  VALUES (p_user_id, -p_amount, 'spend', 'spent', now());
END;
$$;
