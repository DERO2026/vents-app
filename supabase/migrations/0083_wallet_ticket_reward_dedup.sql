-- ============================================================================
-- Wallet-path ticket-reward integrity (companion to root migrations/
-- 20260808120000_ticket-reward-integrity.sql, "VENTS Cents Batch C").
-- ============================================================================
-- Finding: confirm_ticket_payment_via_wallet (0075) has the exact same
-- unbacked-ON-CONFLICT bug as confirm_ticket_payment() (the Paystack/card
-- path, fixed in the root migrations/ tree's 20260808120000). Its VC insert:
--
--   INSERT INTO public.vc_transactions (user_id, amount, type, status,
--     reference_id, earned_at)
--   VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
--   ON CONFLICT DO NOTHING;
--
-- has no unique/exclusion constraint backing it, so a retried/duplicate call
-- to confirm_ticket_payment_via_wallet for the same order (e.g. after a
-- partial refund reopens the "not fully paid" gate, mirroring the exact
-- scenario documented in 20260808120000) inserts a second, fully redundant
-- 50 VC row.
--
-- Reference-id derivation is IDENTICAL to the card path: both functions run
-- the same query shape --
--   SELECT ..., min(t.id::text)::uuid, ...
--     FROM public.tickets t JOIN public.events e ON e.id = t.event_id
--    WHERE t.payment_ref = <the one payment reference for this order>
--    GROUP BY t.user_id, e.organizer_id, e.id
-- -- against the SAME `tickets` table, grouped by the SAME per-order
-- identity (payment_ref), producing v_first_ticket_id = min(ticket id) for
-- that order. Ticket ids are UUID primary keys on a single shared table, so
-- they cannot collide across genuinely different orders regardless of which
-- payment path created them, and v_first_ticket_id is stable across retries
-- of the SAME order (the ticket rows for a payment_ref are created once, by
-- finalize_pending_purchase/purchase_ticket, before either confirm path is
-- ever called, and are never re-created).
--
-- Consequence: the partial unique index the card-path fix already created
-- on the shared `vc_transactions` table --
--   vc_transactions_ticket_reward_dedup_idx
--     ON vc_transactions (user_id, reference_id)
--     WHERE type = 'earn' AND reference_id IS NOT NULL
-- -- already fully protects THIS writer too, with no schema change needed:
-- it is keyed on (user_id, reference_id) irrespective of which function
-- performs the insert, and both functions compute reference_id the same
-- correct, order-stable way. No second/overlapping index is created here.
--
-- Fix (this migration): re-point confirm_ticket_payment_via_wallet's VC
-- insert at that existing arbiter, exactly as the card path was fixed.
-- Every other line of the function (wallet debit, insufficient-balance
-- check, organizer credit, promo redemption, notifications, error
-- hardening from 0075) is reproduced byte-for-byte unchanged.
--
-- No changes to: the 50 VC amount, referral logic, cash-out, Feature Me,
-- badges, profile completion, wallet debit/refund amounts, ticket pricing,
-- or organizer payouts.
-- ============================================================================

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

  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Pending purchase not found for reference%' THEN
      RAISE WARNING 'confirm_ticket_payment_via_wallet: finalize_pending_purchase failed unexpectedly for %: %', p_payment_ref, SQLERRM;
      RAISE;
    END IF;
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

  IF v_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not authorized for this payment reference';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_kobo INTO v_wallet_balance
    FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;

  IF v_wallet_balance < v_expected_kobo THEN
    RETURN 'insufficient_balance:' || v_wallet_balance::text || ':' || v_expected_kobo::text;
  END IF;

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
    -- Fix: reference_id is v_first_ticket_id -- deterministic per
    -- payment_ref group (the qualifying order), identical derivation to
    -- confirm_ticket_payment() (card path). ON CONFLICT now explicitly
    -- targets the shared vc_transactions_ticket_reward_dedup_idx partial
    -- unique index (created by the root migrations/ tree's
    -- 20260808120000_ticket-reward-integrity.sql), so a retried/duplicate
    -- wallet confirmation -- whether from a client retry, a concurrent
    -- duplicate call, or a re-confirmation after a partial refund reopened
    -- the "not fully paid" gate above -- is a guaranteed, database-enforced
    -- no-op instead of relying solely on the already_paid short-circuit.
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT (user_id, reference_id) WHERE type = 'earn' DO NOTHING;
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
