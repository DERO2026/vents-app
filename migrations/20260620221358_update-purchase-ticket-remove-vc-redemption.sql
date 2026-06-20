-- Drop old signature that had p_use_vents_cents
DROP FUNCTION IF EXISTS public.purchase_ticket(uuid, text, integer, text, text, boolean);

-- Recreate without VC redemption; credits 50 VC to buyer after purchase
CREATE OR REPLACE FUNCTION public.purchase_ticket(
  p_event_id       uuid,
  p_ticket_type    text,
  p_quantity       integer,
  p_payment_ref    text,
  p_payment_status text DEFAULT 'paid'
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_ticket_obj jsonb;
  v_unit_price numeric;
  v_total      numeric;
  v_ticket_id  uuid;
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

  -- Insert ticket
  INSERT INTO public.tickets (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status)
  VALUES (p_event_id, v_user_id, p_quantity, p_ticket_type, v_total, p_payment_ref, p_payment_status, 'active')
  RETURNING id INTO v_ticket_id;

  -- Credit 50 VC to buyer for purchasing a ticket
  IF v_total > 0 THEN
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_ticket_id, now())
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_ticket_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purchase_ticket(uuid, text, integer, text, text) TO authenticated;
