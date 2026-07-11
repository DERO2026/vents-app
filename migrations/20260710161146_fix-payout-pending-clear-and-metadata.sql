-- Fix: complete_organizer_payout / fail_organizer_payout resolved the
-- target withdrawal request by matching (organizer_id, amount_kobo,
-- status) instead of the specific row they had just looked up by its
-- unique id/transfer_code/paystack_reference. If an organizer has two
-- withdrawal requests for the same amount sitting in 'pending' or
-- 'processing' at the same time (not unusual — round-number withdrawals
-- repeat), resolving ONE of them via Paystack's webhook or the
-- reconciliation poll would flip BOTH matching rows to
-- 'completed'/'failed', while organizer_wallets.pending_kobo was only ever
-- decremented once. The second request is now permanently stuck in a
-- terminal status with its share of pending_kobo never released, so the
-- organizer's "Pending" balance never clears to 0. Fixed by capturing the
-- row's real id up front and matching on that alone.
--
-- Also adds organizer_transactions.metadata so a completed payout's actual
-- bank account (name, account number, account holder name) is captured
-- structurally rather than only folded into a free-text description, and
-- links the payout transaction back to its withdrawal_request_id the same
-- way the existing cancelled_payout_refund transaction already does.

ALTER TABLE public.organizer_transactions
  ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE OR REPLACE FUNCTION public.complete_organizer_payout(p_request_id text)
RETURNS TABLE (status text, organizer_email text, organizer_name text, amount_kobo bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_id uuid;
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
  v_bank_name text;
  v_account_number text;
  v_account_name text;
BEGIN
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status, b.bank_name, b.account_number, b.account_name
    INTO v_id, v_organizer_id, v_amount_kobo, v_status, v_bank_name, v_account_number, v_account_name
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status = 'completed' THEN
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_amount_kobo
    FROM public.users u WHERE u.id = v_organizer_id;
    RETURN;
  END IF;

  -- Matched by the exact row id found above — not by amount/status, which
  -- could otherwise also match a sibling request for the same amount.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'completed', updated_at = now()
  WHERE id = v_id AND status IN ('pending', 'processing');

  UPDATE public.organizer_wallets
  SET pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions
    (organizer_id, type, amount_kobo, description, withdrawal_request_id, metadata)
  VALUES (
    v_organizer_id, 'payout', v_amount_kobo,
    'Withdrawal to ' || COALESCE(v_bank_name, 'bank account') || ' — completed',
    v_id,
    jsonb_build_object('bank_name', v_bank_name, 'account_number', v_account_number, 'account_name', v_account_name)
  );

  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.complete_organizer_payout(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.fail_organizer_payout(p_request_id text, p_reason text)
RETURNS TABLE (status text, organizer_email text, organizer_name text, amount_kobo bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_id uuid;
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  SELECT id, organizer_id, amount_kobo, status INTO v_id, v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status IN ('completed', 'failed', 'rejected') THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  -- Matched by the exact row id found above (same fix as complete_organizer_payout).
  UPDATE public.organizer_withdrawal_requests
  SET status = 'failed', admin_note = COALESCE(p_reason, admin_note), updated_at = now()
  WHERE id = v_id AND status IN ('pending', 'processing');

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  RETURN QUERY
  SELECT 'failed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.fail_organizer_payout(text, text) TO anon, authenticated;
