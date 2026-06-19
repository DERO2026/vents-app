-- ============================================================
-- VENTS CENTS PAYMENT SYSTEM
-- ============================================================
-- 1. Add VC config to app_config (single source of truth for rate/limits)
-- 2. Create vc_transactions table (per-credit expiry tracking)
-- 3. Migrate existing vents_wallets balances into vc_transactions
-- 4. get_my_vc_balance() — expires stale rows, returns spendable balance
-- 5. purchase_ticket() — updated to deduct VC when p_use_vents_cents=true
-- ============================================================

-- 1. VC config columns on app_config
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_naira_per_1000      integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS vc_min_ticket_price    integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS vc_max_redemption_pct  integer NOT NULL DEFAULT 50;

-- 2. vc_transactions: one row per credit or debit event
CREATE TABLE IF NOT EXISTS public.vc_transactions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount       integer     NOT NULL CHECK (amount > 0),
  type         text        NOT NULL CHECK (type IN ('earn', 'spend', 'refund', 'referral')),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'expired', 'spent', 'cancelled')),
  reference_id uuid,
  earned_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vc_transactions_user_id_idx ON public.vc_transactions (user_id);
CREATE INDEX IF NOT EXISTS vc_transactions_status_expires_idx ON public.vc_transactions (user_id, status, expires_at);

-- RLS on vc_transactions: users can only read their own rows; all writes go through SECURITY DEFINER functions
ALTER TABLE public.vc_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY vc_transactions_select ON public.vc_transactions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies for authenticated — all mutations via SECURITY DEFINER RPCs only

-- 3. Migrate existing wallet balances into vc_transactions
--    Give them earned_at = now() so they expire 12 months from today
INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at, expires_at)
SELECT
  user_id,
  balance,
  'earn',
  'active',
  now(),
  now() + interval '12 months'
FROM public.vents_wallets
WHERE balance > 0
ON CONFLICT DO NOTHING;

-- 4. get_my_vc_balance(): expire stale rows then return spendable balance
CREATE OR REPLACE FUNCTION public.get_my_vc_balance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        uuid := auth.uid();
  v_expired_amount int  := 0;
  v_balance        int  := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('spendable', 0, 'expired_this_call', 0);
  END IF;

  -- Mark expired earn rows and sum their amounts
  WITH expired AS (
    UPDATE public.vc_transactions
    SET status = 'expired'
    WHERE user_id = v_user_id
      AND type IN ('earn', 'referral')
      AND status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    RETURNING amount
  )
  SELECT COALESCE(SUM(amount), 0) INTO v_expired_amount FROM expired;

  -- Deduct expired VC from wallet balance
  IF v_expired_amount > 0 THEN
    UPDATE public.vents_wallets
    SET balance    = GREATEST(0, balance - v_expired_amount),
        updated_at = now()
    WHERE user_id = v_user_id;
  END IF;

  -- Return current wallet balance (0 if wallet row doesn't exist yet)
  SELECT COALESCE(balance, 0) INTO v_balance
  FROM public.vents_wallets
  WHERE user_id = v_user_id;

  RETURN jsonb_build_object(
    'spendable',          v_balance,
    'expired_this_call',  v_expired_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_vc_balance() TO authenticated;

-- 5. Replace purchase_ticket() with VC-aware version
--    New param: p_use_vents_cents boolean DEFAULT false
--    All VC calculation and deduction happens server-side
DROP FUNCTION IF EXISTS public.purchase_ticket(uuid, text, integer, text, text);

CREATE OR REPLACE FUNCTION public.purchase_ticket(
  p_event_id         uuid,
  p_ticket_type      text,
  p_quantity         integer,
  p_payment_ref      text,
  p_payment_status   text    DEFAULT 'paid',
  p_use_vents_cents  boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id              uuid    := auth.uid();
  v_ticket_obj           jsonb;
  v_unit_price           numeric;
  v_total                numeric;
  v_ticket_id            uuid;

  -- VC variables
  v_vc_naira_per_1000    integer;
  v_vc_min_price         integer;
  v_vc_max_pct           integer;
  v_spendable_vc         integer := 0;
  v_max_vc_discount_ngn  numeric := 0;
  v_max_vc_to_use        integer := 0;
  v_vc_to_use            integer := 0;
  v_vc_discount_ngn      numeric := 0;
BEGIN
  -- Auth guard
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Quantity guard
  IF p_quantity < 1 OR p_quantity > 10 THEN
    RAISE EXCEPTION 'Quantity must be between 1 and 10';
  END IF;

  -- Resolve ticket type and price from event
  SELECT tt INTO v_ticket_obj
  FROM public.events,
       jsonb_array_elements(ticket_types) AS tt
  WHERE id = p_event_id
    AND tt->>'name' = p_ticket_type
  LIMIT 1;

  IF v_ticket_obj IS NULL THEN
    RAISE EXCEPTION 'Ticket type not found';
  END IF;

  v_unit_price := (v_ticket_obj->>'price')::numeric;
  v_total      := v_unit_price * p_quantity;

  -- ── VC REDEMPTION (server-side only) ──────────────────────────────────
  IF p_use_vents_cents THEN
    -- Load config from single app_config row
    SELECT vc_naira_per_1000, vc_min_ticket_price, vc_max_redemption_pct
    INTO   v_vc_naira_per_1000, v_vc_min_price, v_vc_max_pct
    FROM   public.app_config
    LIMIT  1;

    -- Only apply if unit price meets minimum threshold
    IF v_unit_price >= v_vc_min_price THEN
      -- Expire stale rows first (same logic as get_my_vc_balance)
      WITH expired AS (
        UPDATE public.vc_transactions
        SET status = 'expired'
        WHERE user_id = v_user_id
          AND type IN ('earn', 'referral')
          AND status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at < now()
        RETURNING amount
      )
      UPDATE public.vents_wallets
      SET balance = GREATEST(0, balance - (SELECT COALESCE(SUM(amount), 0) FROM expired)),
          updated_at = now()
      WHERE user_id = v_user_id
        AND (SELECT COALESCE(SUM(amount), 0) FROM expired) > 0;

      -- Get spendable balance after expiry sweep
      SELECT COALESCE(balance, 0) INTO v_spendable_vc
      FROM   public.vents_wallets
      WHERE  user_id = v_user_id;

      IF v_spendable_vc > 0 THEN
        -- Max naira discount = 50% of total
        v_max_vc_discount_ngn := floor(v_total * v_vc_max_pct / 100.0);

        -- Convert to VC units, rounded down to nearest whole 1000 VC block
        v_max_vc_to_use := floor(v_max_vc_discount_ngn / v_vc_naira_per_1000::numeric * 1000)::integer;

        -- Can't use more VC than the user actually has
        v_vc_to_use := LEAST(v_spendable_vc, v_max_vc_to_use);

        -- Convert back to naira discount
        v_vc_discount_ngn := floor(v_vc_to_use / 1000.0 * v_vc_naira_per_1000);

        -- Apply discount to total (never below 0)
        v_total := GREATEST(0, v_total - v_vc_discount_ngn);
      END IF;
    END IF;
  END IF;
  -- ── END VC REDEMPTION ─────────────────────────────────────────────────

  -- Insert ticket
  INSERT INTO public.tickets (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status)
  VALUES (p_event_id, v_user_id, p_quantity, p_ticket_type, v_total, p_payment_ref, p_payment_status, 'confirmed')
  RETURNING id INTO v_ticket_id;

  -- Deduct VC from wallet and record spend row (same atomic transaction)
  IF v_vc_to_use > 0 THEN
    -- Deduct from denormalized balance
    UPDATE public.vents_wallets
    SET balance    = GREATEST(0, balance - v_vc_to_use),
        updated_at = now()
    WHERE user_id  = v_user_id;

    -- Record the spend event
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at, expires_at)
    VALUES (v_user_id, v_vc_to_use, 'spend', 'spent', v_ticket_id, now(), null);
  END IF;

  RETURN v_ticket_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purchase_ticket(uuid, text, integer, text, text, boolean) TO authenticated;
