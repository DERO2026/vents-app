-- Admin manual Vents Cents credit.
-- Checks is_admin() server-side. Debits admin wallet, credits target wallet,
-- inserts a notification for the target user.

CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(
  p_target_user_id uuid,
  p_amount         integer,
  p_reason         text DEFAULT 'Admin credit'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id       uuid := (SELECT auth.uid());
  v_admin_balance  integer;
  v_target_balance integer;
BEGIN
  -- Must be called by an authenticated admin
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  -- Ensure admin wallet exists and has sufficient balance
  SELECT balance INTO v_admin_balance
  FROM public.vents_wallets
  WHERE user_id = v_admin_id
  FOR UPDATE;

  IF v_admin_balance IS NULL THEN
    RAISE EXCEPTION 'Admin wallet not found';
  END IF;

  IF v_admin_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient admin wallet balance';
  END IF;

  -- Debit admin wallet
  UPDATE public.vents_wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE user_id = v_admin_id;

  -- Upsert target wallet and credit
  INSERT INTO public.vents_wallets (user_id, balance)
  VALUES (p_target_user_id, p_amount)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = vents_wallets.balance + p_amount, updated_at = now();

  SELECT balance INTO v_target_balance
  FROM public.vents_wallets WHERE user_id = p_target_user_id;

  -- Notify target user
  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_target_user_id,
    'promo',
    'Vents Cents Credited',
    p_amount || ' Vents Cents have been added to your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  RETURN jsonb_build_object(
    'credited',       p_amount,
    'target_balance', v_target_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_credit_vents_cents(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_credit_vents_cents(uuid, integer, text) TO authenticated;

-- Allow admin to update wallet balances via the function (wallets table stays read-only for others)
GRANT UPDATE ON public.vents_wallets TO authenticated;
GRANT INSERT ON public.vents_wallets TO authenticated;
GRANT INSERT ON public.notifications TO authenticated;
