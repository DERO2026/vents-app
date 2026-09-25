-- VENTS Wallet payments -- Tickets + Services, spending against the
-- customer user_wallets balance introduced in 0065_user_wallets.sql.
--
-- Deliberately a SEPARATE payment path from the existing Paystack/card
-- flow, not a modification of it:
--   - Tickets: existing entry points (create_pending_purchase,
--     finalize_pending_purchase, confirm_ticket_payment) are untouched in
--     their logic; confirm_ticket_payment only gains one field write
--     (payment_method = 'paystack') so refund logic can later tell paystack
--     and wallet purchases apart without guessing from frontend state.
--   - Services: same shape -- create_service_booking is untouched;
--     confirm_service_booking_payment only gains the same field write.
--
-- New wallet-specific confirm functions (confirm_ticket_payment_via_wallet,
-- confirm_service_booking_payment_via_wallet) do the Paystack-equivalent
-- job -- verify the server-authoritative total, debit the wallet, grant
-- the ticket/booking, credit the organizer/provider earnings wallet -- all
-- as one atomic transaction, with no Paystack round-trip since the "proof
-- of payment" here is the wallet balance itself, checked and debited under
-- a row lock in the same statement.
--
-- Unlike the Paystack confirm functions (project_admin-only, driven by a
-- server-verified Paystack API call), these are granted directly to
-- `authenticated` and scoped to auth.uid() -- there is no external payment
-- processor to call out to, so the caller spending their OWN wallet balance
-- is its own authorization, exactly like every other self-scoped wallet RPC
-- in 0065 (get_my_wallet, initiate_wallet_deposit).
--
-- Scope decision: wallet payment applies to the ticket/booking OWNER
-- spending their own wallet balance only. "Someone Else Pays" (a distinct
-- payer_id completing payment on someone else's behalf) continues to use
-- Paystack only in this pass -- tickets.user_id is always the recipient,
-- never the payer, so there is no reliable server-side link from a pending
-- purchase's payer_id through to a ticket row for a wallet-debit target,
-- and extending Someone-Else-Pays to Wallet was not audited. This keeps
-- today's real-money change minimal and low-risk; can be revisited later.

-- ---------------------------------------------------------------------
-- payment_method columns -- nullable, no backfill. Existing paid rows
-- predate this column entirely and are left NULL (unknown/legacy) rather
-- than assumed to be 'paystack' -- refund logic (unchanged in this pass)
-- already assumes a Paystack-refundable payment for any row without an
-- explicit wallet marker, so NULL behaves identically to 'paystack' for
-- every existing row's refund path. Only this migration's two new/updated
-- confirm functions ever write a value here.
-- ---------------------------------------------------------------------
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS payment_method text
    CONSTRAINT tickets_payment_method_check CHECK (payment_method IN ('paystack', 'wallet'));

ALTER TABLE public.service_bookings
  ADD COLUMN IF NOT EXISTS payment_method text
    CONSTRAINT service_bookings_payment_method_check CHECK (payment_method IN ('paystack', 'wallet'));

-- ---------------------------------------------------------------------
-- Idempotency guard for wallet-paid spends -- mirrors
-- user_wallet_transactions_deposit_ref_idx (0065) exactly, scoped to
-- type='spend' instead of 'deposit'. Guarantees at most one spend ledger
-- row per payment_ref/booking payment_ref, so two concurrent wallet-pay
-- calls for the same purchase can debit at most once between them.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS user_wallet_transactions_spend_ref_idx
  ON public.user_wallet_transactions (reference_id)
  WHERE (type = 'spend' AND reference_id IS NOT NULL);

-- ---------------------------------------------------------------------
-- confirm_ticket_payment: unchanged logic, only now also records
-- payment_method = 'paystack' on the same UPDATE that flips payment_status
-- -- required for refund compatibility (see header comment), not a
-- behavior change to the payment flow itself.
-- ---------------------------------------------------------------------
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
  v_event_id        uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
  v_holder_name     text;
  v_holder_email    text;
  v_holder_phone    text;
  v_metadata        jsonb;
BEGIN
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
  IF p_amount_kobo < v_expected_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', payment_method = 'paystack'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;

    SELECT holder_name, holder_email, holder_phone
      INTO v_holder_name, v_holder_email, v_holder_phone
      FROM public.tickets WHERE id = v_first_ticket_id;

    v_metadata := jsonb_build_object(
      'event_title', v_event_title,
      'ticket_type', v_ticket_type,
      'quantity', v_ticket_count,
      'gross_kobo', v_credit_kobo,
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_credit_kobo),
      'paystack_reference', p_reference,
      'buyer_name', v_holder_name,
      'buyer_email', v_holder_email,
      'buyer_phone', v_holder_phone
    );

    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id,
      v_metadata
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

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️',
    jsonb_build_object('eventId', v_event_id, 'ticketId', v_first_ticket_id)
  );

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_organizer_id,
      'sale',
      'New sale! 💰',
      v_ticket_count || 'x ' || v_ticket_type || ' sold for ' || v_event_title || '.',
      false,
      '💰',
      jsonb_build_object('eventId', v_event_id, 'screen', 'sales-analytics')
    );
  END IF;

  RETURN 'confirmed';
END;
$function$
;

-- ---------------------------------------------------------------------
-- confirm_service_booking_payment: same treatment -- payment_method =
-- 'paystack' added to the existing UPDATE, nothing else changed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_service_booking_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking public.service_bookings;
  v_provider_user_id uuid;
BEGIN
  SELECT * INTO v_booking FROM public.service_bookings WHERE payment_ref = p_reference FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_booking.payment_status = 'paid' THEN
    RETURN 'already_paid';
  END IF;
  IF p_amount_kobo < v_booking.total_kobo THEN
    RETURN 'amount_mismatch:' || v_booking.total_kobo || ':' || p_amount_kobo;
  END IF;

  UPDATE public.service_bookings
     SET payment_status = 'paid', status = 'confirmed', payment_method = 'paystack', updated_at = now()
   WHERE id = v_booking.id;

  SELECT user_id INTO v_provider_user_id FROM public.service_providers WHERE id = v_booking.provider_id;

  PERFORM public.credit_provider_wallet_for_booking(v_provider_user_id, v_booking.subtotal_kobo, v_booking.id, 'Service booking payment');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_booking.customer_id, 'booking', 'Booking confirmed', 'Your service booking has been paid and confirmed.');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_provider_user_id, 'booking', 'New service booking', 'You have a new paid service booking. Check your bookings for details.');

  RETURN 'confirmed';
END;
$function$
;

-- ---------------------------------------------------------------------
-- confirm_ticket_payment_via_wallet -- the Wallet-pay equivalent of the
-- Paystack ?action=verify -> finalizeAndConfirmPurchase path. Client-
-- callable directly (authenticated, self-scoped to auth.uid()); no
-- external payment processor call needed since the wallet balance itself,
-- checked and debited under a row lock in this same transaction, IS the
-- proof of payment.
--
-- Returns one of:
--   'not_found'                         -- no pending purchase for this ref
--   'already_paid'                      -- idempotent no-op, tickets exist and are paid
--   'insufficient_balance:<have>:<need>' -- caller's wallet can't cover it
--   'confirmed'                         -- ticket(s) granted, wallet debited
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment_via_wallet(p_payment_ref text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid             uuid := auth.uid();
  v_user_id         uuid;
  v_total_amount    numeric;
  v_discount_pct    numeric;
  v_promo_code      text;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_id        uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
  v_holder_name     text;
  v_holder_email    text;
  v_holder_phone    text;
  v_metadata        jsonb;
  v_wallet_balance  bigint;
  v_tx_id           uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Recovery/creation step, mirroring finalizeAndConfirmPurchase.ts's own
  -- reasoning: creates the ticket row(s) from the pending_purchases intent
  -- if they don't already exist yet. finalize_pending_purchase is project_
  -- admin-only by grant (0058), but this call runs inside a SECURITY
  -- DEFINER function -- it executes with this function's own (definer)
  -- privileges, not the calling authenticated role's, so the grant
  -- restriction is not bypassed, only correctly not applicable to an
  -- internal call the same way it already isn't for every other SECURITY
  -- DEFINER function in this schema that calls another one. A payment_ref
  -- with no pending_purchases row (unexpected here -- Wallet-pay always
  -- starts from a real ticket purchase intent) raises 'not found', which
  -- is expected/non-fatal, same as the Paystack path.
  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM 1 FROM public.tickets WHERE payment_ref = p_payment_ref FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_payment_ref
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  -- Wallet payment is scoped to the ticket owner spending their own
  -- balance only (see this migration's header comment on Someone Else
  -- Pays) -- a caller asking about someone else's tickets is rejected
  -- outright rather than silently no-op'd, since unlike the Paystack path
  -- there is no separate ownership check happening one layer up in the API
  -- route (this RPC IS the entry point here).
  IF v_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not authorized for this payment reference';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;

  -- Lazy-create the caller's wallet row (mirrors get_my_wallet, 0065)
  -- before locking it -- a brand-new wallet with zero balance is a normal,
  -- expected state here, not an error.
  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_kobo INTO v_wallet_balance
    FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;

  IF v_wallet_balance < v_expected_kobo THEN
    RETURN 'insufficient_balance:' || v_wallet_balance::text || ':' || v_expected_kobo::text;
  END IF;

  -- Idempotency: at most one 'spend' ledger row per payment_ref
  -- (user_wallet_transactions_spend_ref_idx above). A second concurrent
  -- call that lost the ticket-row lock race above already returned
  -- 'already_paid' before reaching here, so this is defense-in-depth, not
  -- the primary guard.
  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id)
  VALUES (v_uid, 'spend', v_expected_kobo, 'Ticket purchase: ' || v_ticket_type, p_payment_ref)
  ON CONFLICT (reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN 'already_paid';
  END IF;

  UPDATE public.user_wallets
     SET balance_kobo = balance_kobo - v_expected_kobo, updated_at = now()
   WHERE user_id = v_uid;

  UPDATE public.tickets
     SET payment_status = 'paid', payment_method = 'wallet'
   WHERE payment_ref = p_payment_ref AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;

    SELECT holder_name, holder_email, holder_phone
      INTO v_holder_name, v_holder_email, v_holder_phone
      FROM public.tickets WHERE id = v_first_ticket_id;

    v_metadata := jsonb_build_object(
      'event_title', v_event_title,
      'ticket_type', v_ticket_type,
      'quantity', v_ticket_count,
      'gross_kobo', v_credit_kobo,
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_credit_kobo),
      'wallet_reference', p_payment_ref,
      'buyer_name', v_holder_name,
      'buyer_email', v_holder_email,
      'buyer_phone', v_holder_phone
    );

    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale (Wallet): ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id,
      v_metadata
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

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️',
    jsonb_build_object('eventId', v_event_id, 'ticketId', v_first_ticket_id)
  );

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_organizer_id,
      'sale',
      'New sale! 💰',
      v_ticket_count || 'x ' || v_ticket_type || ' sold for ' || v_event_title || '.',
      false,
      '💰',
      jsonb_build_object('eventId', v_event_id, 'screen', 'sales-analytics')
    );
  END IF;

  RETURN 'confirmed';
END;
$function$
;

REVOKE ALL ON FUNCTION public.confirm_ticket_payment_via_wallet(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment_via_wallet(text) TO authenticated;

-- ---------------------------------------------------------------------
-- confirm_service_booking_payment_via_wallet -- same shape as the ticket
-- wallet-pay function above, for the Services marketplace. No separate
-- "finalize" step is needed (unlike tickets) -- create_service_booking
-- already writes the full service_bookings/service_booking_items rows
-- synchronously, same as the existing Paystack path.
--
-- Returns one of:
--   'not_found' | 'already_paid' | 'insufficient_balance:<have>:<need>' | 'confirmed'
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_service_booking_payment_via_wallet(p_reference text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_booking public.service_bookings;
  v_provider_user_id uuid;
  v_wallet_balance bigint;
  v_tx_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_booking FROM public.service_bookings WHERE payment_ref = p_reference FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_booking.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not authorized for this booking';
  END IF;

  IF v_booking.payment_status = 'paid' THEN
    RETURN 'already_paid';
  END IF;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_kobo INTO v_wallet_balance
    FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;

  IF v_wallet_balance < v_booking.total_kobo THEN
    RETURN 'insufficient_balance:' || v_wallet_balance::text || ':' || v_booking.total_kobo::text;
  END IF;

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id)
  VALUES (v_uid, 'spend', v_booking.total_kobo, 'Service booking payment', p_reference)
  ON CONFLICT (reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN 'already_paid';
  END IF;

  UPDATE public.user_wallets
     SET balance_kobo = balance_kobo - v_booking.total_kobo, updated_at = now()
   WHERE user_id = v_uid;

  UPDATE public.service_bookings
     SET payment_status = 'paid', status = 'confirmed', payment_method = 'wallet', updated_at = now()
   WHERE id = v_booking.id;

  SELECT user_id INTO v_provider_user_id FROM public.service_providers WHERE id = v_booking.provider_id;

  PERFORM public.credit_provider_wallet_for_booking(v_provider_user_id, v_booking.subtotal_kobo, v_booking.id, 'Service booking payment (Wallet)');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_booking.customer_id, 'booking', 'Booking confirmed', 'Your service booking has been paid (VENTS Wallet) and confirmed.');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_provider_user_id, 'booking', 'New service booking', 'You have a new paid service booking. Check your bookings for details.');

  RETURN 'confirmed';
END;
$function$
;

REVOKE ALL ON FUNCTION public.confirm_service_booking_payment_via_wallet(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_service_booking_payment_via_wallet(text) TO authenticated;
