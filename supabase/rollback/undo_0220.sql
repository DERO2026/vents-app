-- Undo 0220 only (supabase/migrations/0220_ticket_payment_integrity.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0220';
--   \i supabase/rollback/undo_0220.sql
-- Restores the exact pre-0220 text of purchase_ticket, generate_ticket_token,
-- verify_entry_pass and manual_check_in. This RE-OPENS the OEL-01 hole
-- (unpaid paid-tier tickets that pass check-in): run it only on an owner
-- decision. Changes no ticket, scan or check-in row.
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0220' THEN
    RAISE EXCEPTION 'undo_0220 refused: set vents.rollback_confirm = ''undo-0220'' to confirm';
  END IF;
END
$undo$;

CREATE OR REPLACE FUNCTION pg_temp.vents_0220_unpatch(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  IF position('[0220]' IN v_def) = 0 THEN
    RAISE NOTICE 'undo_0220: % is not patched', p_sig;
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION 'undo_0220: % has unexpected [0220] text (anchor % not found exactly once); refusing', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  IF position('[0220]' IN v_def) > 0 THEN
    RAISE EXCEPTION 'undo_0220: % still carries [0220] text after restoring; refusing', p_sig;
  END IF;
  EXECUTE v_def;
END;
$h$;

SELECT pg_temp.vents_0220_unpatch('public.purchase_ticket(uuid,text,jsonb,text,text)', ARRAY[
    ARRAY[$a$  v_effective := v_unit_price * (1 - v_discount_pct / 100);
  -- [0220] Only a ticket that costs nothing (free tier, or a 100% promo) is
  -- issued here. A paid ticket is bought only through checkout:
  -- create_pending_purchase -> Paystack or VENTS Wallet -> finalize/confirm,
  -- which create it already paid. This call charges nobody, so it must never
  -- create a paid-tier ticket (it used to create one as 'pending').
  IF v_effective > 0 THEN
    RAISE EXCEPTION 'Paid tickets are bought through checkout (card or VENTS Wallet); nothing was charged and no ticket was issued';
  END IF;
  v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;$a$, $a$  v_effective := v_unit_price * (1 - v_discount_pct / 100);
  v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;$a$]
  ]);

SELECT pg_temp.vents_0220_unpatch('public.generate_ticket_token(uuid)', ARRAY[
    ARRAY[$a$  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN
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
  END IF;$a$, $a$  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Not authorized to sign this ticket';
  END IF;$a$],
    ARRAY[$a$  SELECT t.user_id, t.event_id, e.event_date, t.status, t.payment_status  -- [0220]
    INTO v_owner, v_event_id, v_event_date, v_status, v_payment$a$, $a$  SELECT t.user_id, t.event_id, e.event_date
    INTO v_owner, v_event_id, v_event_date$a$],
    ARRAY[$a$  v_sig        text;
  v_status     text;  -- [0220]
  v_payment    text;  -- [0220]
BEGIN$a$, $a$  v_sig        text;
BEGIN$a$]
  ]);

SELECT pg_temp.vents_0220_unpatch('public.verify_entry_pass(text,uuid,text,text)', ARRAY[
    ARRAY[$a$  -- [0220] Entry needs a confirmed payment: a pending, failed or refunded
  -- ticket never checks in, whatever QR it carries.
  IF v_ticket.payment_status IS DISTINCT FROM 'paid' THEN
    v_reason := 'not_paid';
    v_message := 'This ticket has no confirmed payment (' || COALESCE(v_ticket.payment_status, 'unknown') || '); it cannot be used for entry.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN$a$, $a$  IF v_ticket.checked_in THEN$a$],
    ARRAY[$a$  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id, t.payment_status,  -- [0220]
         e.organizer_id, e.title AS event_title$a$, $a$  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title$a$]
  ]);

SELECT pg_temp.vents_0220_unpatch('public.manual_check_in(uuid,uuid,text,text)', ARRAY[
    ARRAY[$a$  -- [0220] Entry needs a confirmed payment: a pending, failed or refunded
  -- ticket never checks in, whatever QR it carries.
  IF v_ticket.payment_status IS DISTINCT FROM 'paid' THEN
    v_reason := 'not_paid';
    v_message := 'This ticket has no confirmed payment (' || COALESCE(v_ticket.payment_status, 'unknown') || '); it cannot be used for entry.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN$a$, $a$  IF v_ticket.checked_in THEN$a$],
    ARRAY[$a$  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id, t.payment_status, e.title AS event_title$a$, $a$  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id, e.title AS event_title$a$]
  ]);
