-- 0220: ticket payment integrity (OEL-01, P0). No ticket for a paid tier can
-- be used for entry without a confirmed payment.
--
-- The defect (repository versions; production bodies unverified):
--   * purchase_ticket (0124) is granted to anon and authenticated. For a paid
--     tier it inserted the tickets as status 'active', payment_status
--     'pending' -- without any payment -- so anyone could mint unpaid
--     tickets by calling it directly. (The app itself only uses it, through
--     purchase_ticket_with_tokens, for free orders; paid orders go through
--     create_pending_purchase -> Paystack or VENTS Wallet.)
--   * generate_ticket_token (0024) signed an entry pass for any ticket its
--     owner holds, paid or not.
--   * verify_entry_pass and manual_check_in (0147) admitted any 'active'
--     ticket; neither looked at payment_status.
--   Together: free entry to a paid event.
--
-- This migration, and nothing else:
--   1. purchase_ticket: refuses a ticket whose effective price (tier price
--      less any promo) is above zero. Free tiers and 100%-promo tickets are
--      unchanged (issued 'paid' at N0, as before).
--   2. generate_ticket_token: signs only an 'active', 'paid' ticket; for any
--      other ticket it returns NULL (no pass) instead of raising, so the
--      purchase functions that call it mid-transaction never abort.
--   3. verify_entry_pass, manual_check_in: refuse a ticket whose
--      payment_status is not 'paid' (reason 'not_paid', logged as 'invalid'),
--      before the duplicate check. Row lock, HMAC/expiry/holder checks,
--      atomic check-in, duplicate detection and the scan log are unchanged.
--
-- Unchanged: create_pending_purchase, finalize_pending_purchase,
-- confirm_ticket_payment(_via_wallet), refunds, transfers, cancellation
-- (0218/0219), fees, earnings, grants. Moves no money and changes no row:
-- existing pending tickets stay as they are (they simply stop admitting
-- anyone); what to do about them, and whether pending tickets should hold
-- inventory, is an open business decision (docs/ticket-integrity-0220.md).
--
-- Each function is patched in place from its live definition, anchored on
-- its expected text (each anchor must match exactly once) and marked
-- [0220]; drift refuses the whole migration. One transaction; idempotent.
-- Rollback: supabase/rollback/undo_0220.sql.

DO $pre$
BEGIN
  IF to_regprocedure('public.purchase_ticket(uuid,text,jsonb,text,text)') IS NULL
     OR to_regprocedure('public.generate_ticket_token(uuid)') IS NULL
     OR to_regprocedure('public.verify_entry_pass(text,uuid,text,text)') IS NULL
     OR to_regprocedure('public.manual_check_in(uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '0220: a ticket purchase or check-in function is missing; refusing';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION pg_temp.vents_0220_patch(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  IF position('[0220]' IN v_def) > 0 THEN
    RAISE NOTICE '0220: % already patched', p_sig;
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION '0220: % is not the expected version (anchor % not found exactly once); refusing to patch', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END;
$h$;

SELECT pg_temp.vents_0220_patch('public.purchase_ticket(uuid,text,jsonb,text,text)', ARRAY[
    ARRAY[$a$  v_effective := v_unit_price * (1 - v_discount_pct / 100);
  v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;$a$, $a$  v_effective := v_unit_price * (1 - v_discount_pct / 100);
  -- [0220] Only a ticket that costs nothing (free tier, or a 100% promo) is
  -- issued here. A paid ticket is bought only through checkout:
  -- create_pending_purchase -> Paystack or VENTS Wallet -> finalize/confirm,
  -- which create it already paid. This call charges nobody, so it must never
  -- create a paid-tier ticket (it used to create one as 'pending').
  IF v_effective > 0 THEN
    RAISE EXCEPTION 'Paid tickets are bought through checkout (card or VENTS Wallet); nothing was charged and no ticket was issued';
  END IF;
  v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;$a$]
  ]);

SELECT pg_temp.vents_0220_patch('public.generate_ticket_token(uuid)', ARRAY[
    ARRAY[$a$  v_sig        text;
BEGIN$a$, $a$  v_sig        text;
  v_status     text;  -- [0220]
  v_payment    text;  -- [0220]
BEGIN$a$],
    ARRAY[$a$  SELECT t.user_id, t.event_id, e.event_date
    INTO v_owner, v_event_id, v_event_date$a$, $a$  SELECT t.user_id, t.event_id, e.event_date, t.status, t.payment_status  -- [0220]
    INTO v_owner, v_event_id, v_event_date, v_status, v_payment$a$],
    ARRAY[$a$  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Not authorized to sign this ticket';
  END IF;$a$, $a$  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Not authorized to sign this ticket';
  END IF;
  -- [0220] An entry pass only for a ticket that is active and paid: never a
  -- pending (unpaid), failed, refunded or cancelled one. Returns NULL (no
  -- pass) rather than raising, because finalize_pending_purchase and
  -- purchase_ticket_with_tokens call this inside the purchase transaction
  -- while a ticket is still pending (wallet checkout); an exception there
  -- would abort a legitimate purchase. Entry is refused at check-in anyway.
  IF v_status IS DISTINCT FROM 'active' OR v_payment IS DISTINCT FROM 'paid' THEN
    RETURN NULL;
  END IF;$a$]
  ]);

SELECT pg_temp.vents_0220_patch('public.verify_entry_pass(text,uuid,text,text)', ARRAY[
    ARRAY[$a$  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title$a$, $a$  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id, t.payment_status,  -- [0220]
         e.organizer_id, e.title AS event_title$a$],
    ARRAY[$a$  IF v_ticket.checked_in THEN$a$, $a$  -- [0220] Entry needs a confirmed payment: a pending, failed or refunded
  -- ticket never checks in, whatever QR it carries.
  IF v_ticket.payment_status IS DISTINCT FROM 'paid' THEN
    v_reason := 'not_paid';
    v_message := 'This ticket has no confirmed payment (' || COALESCE(v_ticket.payment_status, 'unknown') || '); it cannot be used for entry.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN$a$]
  ]);

SELECT pg_temp.vents_0220_patch('public.manual_check_in(uuid,uuid,text,text)', ARRAY[
    ARRAY[$a$  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id, e.title AS event_title$a$, $a$  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id, t.payment_status, e.title AS event_title$a$],
    ARRAY[$a$  IF v_ticket.checked_in THEN$a$, $a$  -- [0220] Entry needs a confirmed payment: a pending, failed or refunded
  -- ticket never checks in, whatever QR it carries.
  IF v_ticket.payment_status IS DISTINCT FROM 'paid' THEN
    v_reason := 'not_paid';
    v_message := 'This ticket has no confirmed payment (' || COALESCE(v_ticket.payment_status, 'unknown') || '); it cannot be used for entry.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN$a$]
  ]);
