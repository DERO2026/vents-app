-- CRITICAL FIX — CheckoutScreen.tsx's promo code field applied a flat 10%
-- discount to ANY non-empty text with zero server-side verification. The
-- amount check added in the multi-attendee migration (confirm_ticket_payment)
-- reconciles the webhook's charged total against price*1.05, with no
-- awareness of a discount at all -- so a client-supplied discount was fully
-- attacker-controlled and not caught by that reconciliation. Closing this
-- with a real promo_codes table validated exclusively through
-- SECURITY DEFINER RPCs (no public SELECT policy -- codes are never
-- browsable), enforced both at "Apply" time and again inside purchase_ticket
-- itself (defense against a code expiring/maxing out between the two), and
-- folded into confirm_ticket_payment's amount reconciliation so a discounted
-- charge is still verified correctly.

CREATE TABLE IF NOT EXISTS public.promo_codes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL UNIQUE,
  discount_percentage  numeric NOT NULL CHECK (discount_percentage > 0 AND discount_percentage <= 100),
  max_uses             integer,
  current_uses         integer NOT NULL DEFAULT 0,
  expires_at           timestamptz,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies at all: codes are looked up only through the
-- SECURITY DEFINER functions below, never via a direct client SELECT --
-- otherwise any signed-in user could list every valid code and its
-- remaining uses straight off the table.

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS promo_code text;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS discount_percentage numeric NOT NULL DEFAULT 0;

-- Read-only pre-check the frontend calls when the user hits "Apply", so it
-- can show real-time valid/invalid feedback before payment. Does NOT
-- increment current_uses -- applying a code isn't the same as spending it,
-- since the purchase might still be abandoned.
CREATE OR REPLACE FUNCTION public.validate_promo_code(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_promo public.promo_codes;
BEGIN
  IF p_code IS NULL OR trim(p_code) = '' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'Enter a promo code.');
  END IF;

  SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = upper(trim(p_code));

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'Invalid promo code.');
  END IF;

  IF NOT v_promo.is_active THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code is no longer active.');
  END IF;

  IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code has expired.');
  END IF;

  IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code has reached its usage limit.');
  END IF;

  RETURN jsonb_build_object('valid', true, 'discount_percentage', v_promo.discount_percentage);
END;
$function$;

-- purchase_ticket now re-validates the code itself (never trusts that the
-- earlier "Apply" check is still true by the time payment happens) and
-- records the resolved discount on every row it inserts, so
-- confirm_ticket_payment can reconstruct exactly what should have been
-- charged. `amount` keeps storing the ticket's undiscounted face value
-- (unchanged organizer-credit semantics -- the platform absorbs the
-- discount, not the organizer); discount_percentage records what was
-- actually applied.
CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id      uuid := auth.uid();
  v_event        record;
  v_ticket_obj   jsonb;
  v_unit_price   numeric;
  v_discount_pct numeric := 0;
  v_effective    numeric;
  v_status       text;
  v_attendee     jsonb;
  v_ticket_id    uuid;
  v_ticket_ids   uuid[] := ARRAY[]::uuid[];
  v_count        integer;
  v_promo        public.promo_codes;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  SELECT price, ticket_types INTO v_event
  FROM public.events
  WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  IF v_event.ticket_types IS NOT NULL AND jsonb_array_length(v_event.ticket_types) > 0 THEN
    SELECT tt INTO v_ticket_obj
    FROM jsonb_array_elements(v_event.ticket_types) AS tt
    WHERE tt->>'name' = p_ticket_type
    LIMIT 1;

    IF v_ticket_obj IS NULL THEN
      RAISE EXCEPTION 'Ticket type not found';
    END IF;

    v_unit_price := (v_ticket_obj->>'price')::numeric;
  ELSE
    v_unit_price := COALESCE(v_event.price, 0);
  END IF;

  IF p_promo_code IS NOT NULL AND trim(p_promo_code) <> '' THEN
    SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = upper(trim(p_promo_code));

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid promo code';
    END IF;
    IF NOT v_promo.is_active THEN
      RAISE EXCEPTION 'This promo code is no longer active';
    END IF;
    IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
      RAISE EXCEPTION 'This promo code has expired';
    END IF;
    IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
      RAISE EXCEPTION 'This promo code has reached its usage limit';
    END IF;

    v_discount_pct := v_promo.discount_percentage;
  END IF;

  v_effective := v_unit_price * (1 - v_discount_pct / 100);
  v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;

  FOR v_attendee IN SELECT * FROM jsonb_array_elements(p_attendees)
  LOOP
    IF NULLIF(trim(v_attendee->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'Each attendee must have a name';
    END IF;

    INSERT INTO public.tickets
      (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status,
       holder_name, holder_email, promo_code, discount_percentage)
    VALUES
      (p_event_id, v_user_id, 1, p_ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
       trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''),
       CASE WHEN v_promo.id IS NOT NULL THEN upper(trim(p_promo_code)) ELSE NULL END, v_discount_pct)
    RETURNING id INTO v_ticket_id;

    v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
  END LOOP;

  -- A free (immediately-paid) ticket never goes through confirm_ticket_payment,
  -- so this is the only "payment confirmed" moment it ever gets -- spend the
  -- redemption here. Priced purchases increment inside confirm_ticket_payment
  -- instead, when the webhook actually confirms money changed hands.
  IF v_status = 'paid' AND v_promo.id IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE id = v_promo.id;
  END IF;

  RETURN v_ticket_ids;
END;
$function$;

-- confirm_ticket_payment's amount check now accounts for the discount that
-- was actually applied (stored per-row), and spends the promo redemption
-- exactly once per group purchase on the transition into 'paid'.
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
  v_total_amount    numeric;
  v_discount_pct    numeric;
  v_promo_code      text;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
BEGIN
  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, max(e.title),
         count(*), min(t.id), count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, e.organizer_id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  -- Matches CheckoutScreen.tsx: total = subtotal + subtotal*5% - subtotal*discount%
  --                                   = subtotal * (1.05 - discount%/100)
  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
  IF v_expected_kobo <> p_amount_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;
    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id
    );
  END IF;

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️'
  );

  RETURN 'confirmed';
END;
$function$;
