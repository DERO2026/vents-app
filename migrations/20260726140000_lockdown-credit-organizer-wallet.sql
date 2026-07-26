-- ── CRITICAL FIX: credit_organizer_wallet had zero authorization check ───────
-- Audit finding: this SECURITY DEFINER function had EXECUTE granted to PUBLIC
-- and authenticated, with NO auth.uid() check, NO admin check, and NO
-- verification that p_ticket_sale_id/p_amount_kobo correspond to anything
-- real. Any authenticated user could call it directly via RPC with an
-- arbitrary organizer_id and amount, fabricate organizer_wallets balance, and
-- cash it out via request_organizer_payout -> a real Paystack bank transfer.
--
-- Every legitimate call site (grepped across the whole repo) is an internal
-- `PERFORM public.credit_organizer_wallet(...)` from another SECURITY DEFINER
-- function (purchase_ticket, confirm_ticket_payment, purchase_ticket_with_
-- tokens, etc.), always owned by project_admin, always passing a real ticket
-- id as p_ticket_sale_id. No client or API code calls this RPC directly.
--
-- Fix, three layers:
--   1. REVOKE EXECUTE from PUBLIC/anon/authenticated entirely. Function
--      owners always retain implicit execute on their own functions
--      regardless of GRANT/REVOKE, so every existing internal PERFORM call
--      (made by other project_admin-owned SECURITY DEFINER functions)
--      keeps working with zero behavior change. Direct RPC calls from any
--      authenticated session now fail with a permission error before the
--      function body even runs.
--   2. Defense in depth INSIDE the function body: require p_ticket_sale_id,
--      verify it references a real, PAID ticket that actually belongs to
--      p_organizer_id's event (the "cryptographic tie to a verified sale"),
--      and reject non-positive amounts. This means even a future internal
--      caller (or a compromised/misused owner-level call) can't credit an
--      arbitrary amount untethered from a real sale.
--   3. Idempotency: a ticket_sale_id can only ever be credited once (checked
--      against the immutable organizer_transactions ledger, which already has
--      no UPDATE/DELETE policy for any role -- it was already an audit trail,
--      this just makes the credit path itself idempotent against retries).

CREATE OR REPLACE FUNCTION public.credit_organizer_wallet(
  p_organizer_id   uuid,
  p_amount_kobo    bigint,
  p_description    text DEFAULT NULL,
  p_ticket_sale_id uuid DEFAULT NULL
) RETURNS void
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

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.credit_organizer_wallet(uuid, bigint, text, uuid) FROM PUBLIC, anon, authenticated;
