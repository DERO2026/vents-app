-- Stage 8 (Wallet transaction history/receipts): additive-only migration.
--
-- No new tables. organizer_transactions is already a proper append-only,
-- SECURITY DEFINER-only-writable ledger (see 0008_rls_and_policies.sql
-- org_txns_admin_write/org_txns_own_read) -- this migration only enriches
-- what gets written into it at credit time, so a transaction-detail/receipt
-- screen has real data to show instead of re-deriving it from live joins
-- (which would violate "financial records must remain historically
-- accurate even if an event/ticket is edited later", since events.title
-- etc. are never snapshotted anywhere today).
--
-- credit_organizer_wallet gains an optional p_metadata param (backward
-- compatible -- existing callers with no 5th arg behave identically).
-- confirm_ticket_payment now builds that metadata from data it already has
-- in scope (event title, ticket type, quantity, gross amount, the Paystack
-- reference it was called with, and the purchasing ticket's holder
-- snapshot) and passes it through. No withdrawal function is touched:
-- fail_organizer_payout/admin_reject_organizer_payout intentionally do NOT
-- gain ledger rows (no balance ever nets to zero for those -- the
-- request/refund is a no-op on total balance), per explicit product
-- decision -- organizer_withdrawal_requests.status/admin_note/updated_at
-- remains the authoritative record for failed/rejected/cancelled
-- withdrawals, read directly by the UI.

-- Adding a 5th parameter to an existing function creates a second overload
-- rather than replacing it (Postgres identifies functions by name + arg
-- types) -- drop the old 4-arg signature first so there is exactly one
-- credit_organizer_wallet, with grants matching 0011_grants.sql's
-- project_admin-only policy (a bare CREATE OR REPLACE for the new
-- signature would default to PUBLIC EXECUTE, letting anon/authenticated
-- call it directly over RPC).
DROP FUNCTION IF EXISTS public.credit_organizer_wallet(uuid, bigint, text, uuid);

CREATE OR REPLACE FUNCTION public.credit_organizer_wallet(
  p_organizer_id uuid,
  p_amount_kobo bigint,
  p_description text DEFAULT NULL::text,
  p_ticket_sale_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT NULL::jsonb
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'credit_organizer_wallet: amount must be positive';
  END IF;

  IF p_organizer_id IS NULL THEN
    RAISE EXCEPTION 'credit_organizer_wallet: organizer_id is required';
  END IF;

  IF p_ticket_sale_id IS NULL THEN
    RAISE EXCEPTION 'credit_organizer_wallet: a verified ticket_sale_id is required';
  END IF;

  SELECT t.id, e.organizer_id, t.payment_status
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_sale_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % does not exist', p_ticket_sale_id;
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_organizer_id THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % does not belong to organizer %', p_ticket_sale_id, p_organizer_id;
  END IF;

  IF v_ticket.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % is not paid (status=%)', p_ticket_sale_id, v_ticket.payment_status;
  END IF;

  -- Idempotent: a given ticket sale can only ever generate one credit.
  IF EXISTS (
    SELECT 1 FROM public.organizer_transactions
    WHERE ticket_sale_id = p_ticket_sale_id AND type = 'credit'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo)
  VALUES (p_organizer_id, p_amount_kobo, p_amount_kobo)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo      = organizer_wallets.balance_kobo + p_amount_kobo,
        total_earned_kobo = organizer_wallets.total_earned_kobo + p_amount_kobo,
        updated_at        = now();

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id, metadata)
  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id, p_metadata);
END;
$function$
;

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
     SET payment_status = 'paid'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;

    -- Snapshot buyer info off the purchasing ticket (index 0 / the
    -- purchaser, per PurchasedTicket.attendees convention) -- holder_name/
    -- email/phone are themselves already immutable per-ticket snapshots
    -- (never rewritten post-purchase), so this is safe to capture once here.
    SELECT holder_name, holder_email, holder_phone
      INTO v_holder_name, v_holder_email, v_holder_phone
      FROM public.tickets WHERE id = v_first_ticket_id;

    v_metadata := jsonb_build_object(
      'event_title', v_event_title,
      'ticket_type', v_ticket_type,
      'quantity', v_ticket_count,
      'gross_kobo', v_credit_kobo,
      -- VENTS' 5% service fee is a buyer-side surcharge added on top at
      -- checkout, never deducted from the organizer -- net paid to the
      -- organizer equals gross. buyer_fee_kobo is what the buyer paid
      -- above the base gross (v_expected_kobo, already net of any promo
      -- discount, minus v_credit_kobo) -- informational only, recorded
      -- here so the receipt UI states this accurately instead of
      -- re-deriving fee semantics later.
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
    jsonb_build_object('eventId', v_event_id)
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

-- Re-apply the same project_admin-only EXECUTE policy 0011_grants.sql set
-- for the old 4-arg signature, now against the new 5-arg one.
REVOKE ALL ON FUNCTION public.credit_organizer_wallet(uuid, bigint, text, uuid, jsonb) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.credit_organizer_wallet(uuid, bigint, text, uuid, jsonb) TO project_admin;
