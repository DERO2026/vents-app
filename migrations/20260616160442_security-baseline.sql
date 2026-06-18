-- ── referrals table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.referrals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  invitee_email text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'joined')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS referrals_referrer_invitee_idx
  ON public.referrals (referrer_id, invitee_email);

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY referrals_select ON public.referrals
  FOR SELECT USING (referrer_id = (SELECT auth.uid()));

CREATE POLICY referrals_insert ON public.referrals
  FOR INSERT WITH CHECK (
    referrer_id = (SELECT auth.uid())
    AND (
      SELECT COUNT(*) FROM public.referrals r2
      WHERE r2.referrer_id = (SELECT auth.uid())
        AND r2.created_at > now() - interval '24 hours'
    ) < 5
  );

GRANT SELECT, INSERT ON public.referrals TO authenticated;

-- ── vents_wallets table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vents_wallets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  balance    integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vents_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY wallets_select ON public.vents_wallets
  FOR SELECT USING (user_id = (SELECT auth.uid()));

GRANT SELECT ON public.vents_wallets TO authenticated;

-- ── Server-side ticket purchase function ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purchase_ticket(
  p_event_id       uuid,
  p_ticket_type    text,
  p_quantity       integer,
  p_payment_ref    text,
  p_payment_status text DEFAULT 'paid'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    uuid := (SELECT auth.uid());
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

  INSERT INTO public.tickets (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status)
  VALUES (p_event_id, v_user_id, p_quantity, p_ticket_type, v_total, p_payment_ref, p_payment_status, 'confirmed')
  RETURNING id INTO v_ticket_id;

  RETURN v_ticket_id;
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_ticket(uuid, text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purchase_ticket(uuid, text, integer, text, text) TO authenticated;
