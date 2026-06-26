-- Fix _vc_deduct: insert p_amount (positive) not -p_amount to satisfy amount > 0 constraint
CREATE OR REPLACE FUNCTION public._vc_deduct(
  p_user_id uuid,
  p_amount  integer,
  p_reason  text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_balance integer;
BEGIN
  SELECT COALESCE(balance, 0) INTO v_balance
  FROM public.vents_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient Vents Cents balance';
  END IF;

  UPDATE public.vents_wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE user_id = p_user_id;

  -- amount must be > 0; type 'spend', status 'spent'
  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at, reference_id)
  VALUES (p_user_id, p_amount, 'spend', 'spent', now(), gen_random_uuid());
END;
$$;

-- Fix admin_credit_vents_cents (numeric overload): type 'credit' is invalid; use 'earn'
DROP FUNCTION IF EXISTS public.admin_credit_vents_cents(uuid, numeric, text);

CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(
  p_user_id uuid,
  p_amount  numeric,
  p_reason  text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (p_user_id, p_amount::integer, 'earn', 'active', gen_random_uuid(), now());

  INSERT INTO public.vents_wallets (user_id, balance)
  VALUES (p_user_id, p_amount::integer)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.vents_wallets.balance + p_amount::integer, updated_at = now();

  RETURN 'ok';
END;
$$;
