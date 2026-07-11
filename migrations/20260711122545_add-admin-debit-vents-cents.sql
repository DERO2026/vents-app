-- Admin-facing Vents Cents debit/claw-back utility. Reuses the existing
-- _vc_deduct() ledger-tracked helper (already used by spend flows) so the
-- transaction shows up correctly in the VC ledger as a 'spend'/'spent' row.
CREATE OR REPLACE FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text DEFAULT 'Admin debit'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  PERFORM public._vc_deduct(p_user_id, p_amount, p_reason);

  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Adjusted',
    p_amount || ' Vents Cents have been removed from your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (auth.uid(), 'admin_vc_debit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason));

  RETURN jsonb_build_object('debited', p_amount, 'target_balance', v_balance);
END;
$function$;
