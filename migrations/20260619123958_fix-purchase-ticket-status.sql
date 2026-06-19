-- Fix purchase_ticket() to use status='active' (matching tickets_status_check constraint)
-- The function was previously inserting 'confirmed' which violates the constraint

DROP FUNCTION IF EXISTS public.purchase_ticket(uuid, text, integer, text, text, boolean);

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

  v_vc_naira_per_1000    integer;
  v_vc_min_price         integer;
  v_vc_max_pct           integer;
  v_spendable_vc         integer := 0;
  v_max_vc_discount_ngn  numeric := 0;
  v_max_vc_to_use        integer := 0;
  v_vc_to_use            integer := 0;
  v_vc_discount_ngn      numeric := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity < 1 OR p_quantity > 10 THEN
    RAISE EXCEPTION 'Quantity must be between 1 and 10';
  END IF;

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

  -- VC REDEMPTION
  IF p_use_vents_cents THEN
    SELECT vc_naira_per_1000, vc_min_ticket_price, vc_max_redemption_pct
    INTO   v_vc_naira_per_1000, v_vc_min_price, v_vc_max_pct
    FROM   public.app_config
    LIMIT  1;

    IF v_unit_price >= v_vc_min_price THEN
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

      SELECT COALESCE(balance, 0) INTO v_spendable_vc
      FROM   public.vents_wallets
      WHERE  user_id = v_user_id;

      IF v_spendable_vc > 0 THEN
        v_max_vc_discount_ngn := floor(v_total * v_vc_max_pct / 100.0);
        v_max_vc_to_use       := floor(v_max_vc_discount_ngn / v_vc_naira_per_1000::numeric * 1000)::integer;
        v_vc_to_use           := LEAST(v_spendable_vc, v_max_vc_to_use);
        v_vc_discount_ngn     := floor(v_vc_to_use / 1000.0 * v_vc_naira_per_1000);
        v_total               := GREATEST(0, v_total - v_vc_discount_ngn);
      END IF;
    END IF;
  END IF;

  -- Insert ticket with correct status='active'
  INSERT INTO public.tickets (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status)
  VALUES (p_event_id, v_user_id, p_quantity, p_ticket_type, v_total, p_payment_ref, p_payment_status, 'active')
  RETURNING id INTO v_ticket_id;

  -- Deduct VC atomically
  IF v_vc_to_use > 0 THEN
    UPDATE public.vents_wallets
    SET balance    = GREATEST(0, balance - v_vc_to_use),
        updated_at = now()
    WHERE user_id  = v_user_id;

    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at, expires_at)
    VALUES (v_user_id, v_vc_to_use, 'spend', 'spent', v_ticket_id, now(), null);
  END IF;

  RETURN v_ticket_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purchase_ticket(uuid, text, integer, text, text, boolean) TO authenticated;
