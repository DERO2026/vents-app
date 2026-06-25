-- Task 2: Rewrite admin_credit_vents_cents (both overloads) and admin_set_user_role
-- to use public.is_admin() as the first guard (schema-qualified, compatible with search_path='').

-- ── admin_credit_vents_cents (uuid, integer, text) → jsonb ──────────────────
CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(
  p_target_user_id uuid,
  p_amount         integer,
  p_reason         text DEFAULT 'Admin credit'
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_admin_id       uuid := (SELECT auth.uid());
  v_admin_balance  integer;
  v_target_balance integer;
BEGIN
  -- Must be called by an authenticated admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
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
    SET balance = public.vents_wallets.balance + p_amount, updated_at = now();

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

-- ── admin_credit_vents_cents (uuid, numeric, text) → text ───────────────────
CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(
  p_user_id uuid,
  p_amount  numeric,
  p_reason  text DEFAULT 'Admin transfer'
) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_admin UUID := auth.uid();
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id)
  VALUES (p_user_id, p_amount, 'credit', 'active', 'admin:' || p_reason);

  RETURN 'ok';
END;
$$;

-- ── admin_set_user_role (uuid, text) → void ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_user_role(
  p_user_id  uuid,
  p_new_role text
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_target_role text;
BEGIN
  -- Must be called by an authenticated admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Validate new role
  IF p_new_role NOT IN ('attendee', 'organizer') THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: attendee, organizer)', p_new_role;
  END IF;

  -- Root UID is immutable (also enforced by trg_lock_admin_root_role trigger)
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  -- Fetch current role for audit log
  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;

  -- Update — trigger allows this because current_user = function owner, not 'authenticated'
  UPDATE public.users SET role = p_new_role WHERE id = p_user_id;

  -- Write audit log
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (
    auth.uid(),
    'role_change',
    p_user_id,
    jsonb_build_object(
      'old_role', v_target_role,
      'new_role', p_new_role
    )
  );
END;
$$;
