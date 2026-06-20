-- Admin function to credit Vents Cents to any user.
-- Restricted to ROOT_UID only; anyone else gets 'unauthorized' back.
CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(
  p_user_id  UUID,
  p_amount   NUMERIC,
  p_reason   TEXT DEFAULT 'Admin transfer'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin UUID := auth.uid();
BEGIN
  IF v_admin IS NULL OR v_admin::TEXT <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RETURN 'unauthorized';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id)
  VALUES (p_user_id, p_amount, 'credit', 'active', 'admin:' || p_reason);

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_credit_vents_cents(UUID, NUMERIC, TEXT) TO authenticated;