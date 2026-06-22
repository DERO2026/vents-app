-- organizer_wallets: one row per organizer, tracks balance in kobo (₦ × 100)
CREATE TABLE IF NOT EXISTS public.organizer_wallets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  balance_kobo bigint NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
  total_earned_kobo bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- organizer_transactions: ledger of credits and debits
CREATE TABLE IF NOT EXISTS public.organizer_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('credit','debit','payout')),
  amount_kobo    bigint NOT NULL CHECK (amount_kobo > 0),
  description    text,
  ticket_sale_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- organizer_bank_accounts: payout destination
CREATE TABLE IF NOT EXISTS public.organizer_bank_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id   uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  bank_name      text NOT NULL,
  account_number text NOT NULL,
  account_name   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- organizer_withdrawal_requests: tracks withdrawal requests for admin approval
CREATE TABLE IF NOT EXISTS public.organizer_withdrawal_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid')),
  bank_account_id uuid REFERENCES public.organizer_bank_accounts(id),
  admin_note      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_org_txns_organizer ON public.organizer_transactions(organizer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_org_withdraw_organizer ON public.organizer_withdrawal_requests(organizer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_org_withdraw_status ON public.organizer_withdrawal_requests(status);

-- RLS
ALTER TABLE public.organizer_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_withdrawal_requests ENABLE ROW LEVEL SECURITY;

-- Helper: is caller an admin?
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- organizer_wallets policies
CREATE POLICY "organizer_wallets_own_read" ON public.organizer_wallets
  FOR SELECT USING (organizer_id = auth.uid() OR public.is_admin());

CREATE POLICY "organizer_wallets_admin_write" ON public.organizer_wallets
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- organizer_transactions policies
CREATE POLICY "org_txns_own_read" ON public.organizer_transactions
  FOR SELECT USING (organizer_id = auth.uid() OR public.is_admin());

CREATE POLICY "org_txns_admin_write" ON public.organizer_transactions
  FOR INSERT WITH CHECK (public.is_admin());

-- organizer_bank_accounts policies
CREATE POLICY "org_bank_own" ON public.organizer_bank_accounts
  FOR ALL USING (organizer_id = auth.uid() OR public.is_admin())
  WITH CHECK (organizer_id = auth.uid() OR public.is_admin());

-- organizer_withdrawal_requests policies
CREATE POLICY "org_withdraw_own_read" ON public.organizer_withdrawal_requests
  FOR SELECT USING (organizer_id = auth.uid() OR public.is_admin());

CREATE POLICY "org_withdraw_own_insert" ON public.organizer_withdrawal_requests
  FOR INSERT WITH CHECK (organizer_id = auth.uid());

CREATE POLICY "org_withdraw_admin_update" ON public.organizer_withdrawal_requests
  FOR UPDATE USING (public.is_admin());

-- Grants
GRANT SELECT, INSERT, UPDATE ON public.organizer_wallets TO authenticated;
GRANT SELECT, INSERT ON public.organizer_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizer_bank_accounts TO authenticated;
GRANT SELECT, INSERT ON public.organizer_withdrawal_requests TO authenticated;
GRANT UPDATE ON public.organizer_withdrawal_requests TO authenticated;

-- RPC: credit_organizer_wallet
CREATE OR REPLACE FUNCTION public.credit_organizer_wallet(
  p_organizer_id   uuid,
  p_amount_kobo    bigint,
  p_description    text DEFAULT NULL,
  p_ticket_sale_id uuid DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo)
  VALUES (p_organizer_id, p_amount_kobo, p_amount_kobo)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo      = organizer_wallets.balance_kobo + p_amount_kobo,
        total_earned_kobo = organizer_wallets.total_earned_kobo + p_amount_kobo,
        updated_at        = now();

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id);
END;
$$;

-- RPC: request_organizer_payout
CREATE OR REPLACE FUNCTION public.request_organizer_payout(
  p_amount_kobo     bigint,
  p_bank_account_id uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_balance      bigint;
  v_request_id   uuid;
BEGIN
  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT balance_kobo INTO v_balance
  FROM public.organizer_wallets
  WHERE organizer_id = v_organizer_id;

  IF v_balance IS NULL OR v_balance < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo - p_amount_kobo, updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description)
  VALUES (v_organizer_id, 'payout', p_amount_kobo, 'Withdrawal request');

  INSERT INTO public.organizer_withdrawal_requests (organizer_id, amount_kobo, bank_account_id)
  VALUES (v_organizer_id, p_amount_kobo, p_bank_account_id)
  RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.credit_organizer_wallet TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_organizer_payout TO authenticated;
