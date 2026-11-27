-- 0220 production precheck. READ ONLY. Generated from
-- supabase/migrations/0220_ticket_payment_integrity.sql (the same anchors, the
-- same "exactly once" rule), by scripts/ops/gen-0220-precheck.py. Do not edit
-- by hand: regenerate.
--
-- Reports, for each of the four functions 0220 patches and each text anchor
-- it replaces: OK (found exactly once: 0220 would patch it), ALREADY PATCHED,
-- MISSING FUNCTION, or BLOCKED (0220 would refuse: the live function differs).
-- Reads only function definitions. Never writes. Not run against production
-- without the owner's approval.
--
-- Tested locally: scripts/local-pg-test/run-0220-precheck-verification.sh
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SELECT 'public.purchase_ticket(uuid,text,jsonb,text,text)'::text AS function, i AS anchor,
       CASE WHEN to_regprocedure('public.purchase_ticket(uuid,text,jsonb,text,text)') IS NULL THEN 'MISSING FUNCTION'
            WHEN position('[0220]' IN d.def) > 0 THEN 'ALREADY PATCHED'
            WHEN (length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]) = 1 THEN 'OK'
            ELSE 'BLOCKED (anchor found ' || ((length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]))::text || ' times)' END AS status
  FROM (SELECT CASE WHEN to_regprocedure('public.purchase_ticket(uuid,text,jsonb,text,text)') IS NULL THEN '' ELSE pg_get_functiondef(to_regprocedure('public.purchase_ticket(uuid,text,jsonb,text,text)')) END AS def) d,
       (SELECT ARRAY[
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
  ] AS p) x,
       generate_subscripts(x.p, 1) AS i
UNION ALL
SELECT 'public.generate_ticket_token(uuid)'::text AS function, i AS anchor,
       CASE WHEN to_regprocedure('public.generate_ticket_token(uuid)') IS NULL THEN 'MISSING FUNCTION'
            WHEN position('[0220]' IN d.def) > 0 THEN 'ALREADY PATCHED'
            WHEN (length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]) = 1 THEN 'OK'
            ELSE 'BLOCKED (anchor found ' || ((length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]))::text || ' times)' END AS status
  FROM (SELECT CASE WHEN to_regprocedure('public.generate_ticket_token(uuid)') IS NULL THEN '' ELSE pg_get_functiondef(to_regprocedure('public.generate_ticket_token(uuid)')) END AS def) d,
       (SELECT ARRAY[
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
  ] AS p) x,
       generate_subscripts(x.p, 1) AS i
UNION ALL
SELECT 'public.verify_entry_pass(text,uuid,text,text)'::text AS function, i AS anchor,
       CASE WHEN to_regprocedure('public.verify_entry_pass(text,uuid,text,text)') IS NULL THEN 'MISSING FUNCTION'
            WHEN position('[0220]' IN d.def) > 0 THEN 'ALREADY PATCHED'
            WHEN (length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]) = 1 THEN 'OK'
            ELSE 'BLOCKED (anchor found ' || ((length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]))::text || ' times)' END AS status
  FROM (SELECT CASE WHEN to_regprocedure('public.verify_entry_pass(text,uuid,text,text)') IS NULL THEN '' ELSE pg_get_functiondef(to_regprocedure('public.verify_entry_pass(text,uuid,text,text)')) END AS def) d,
       (SELECT ARRAY[
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
  ] AS p) x,
       generate_subscripts(x.p, 1) AS i
UNION ALL
SELECT 'public.manual_check_in(uuid,uuid,text,text)'::text AS function, i AS anchor,
       CASE WHEN to_regprocedure('public.manual_check_in(uuid,uuid,text,text)') IS NULL THEN 'MISSING FUNCTION'
            WHEN position('[0220]' IN d.def) > 0 THEN 'ALREADY PATCHED'
            WHEN (length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]) = 1 THEN 'OK'
            ELSE 'BLOCKED (anchor found ' || ((length(d.def) - length(replace(d.def, x.p[i][1], ''))) / length(x.p[i][1]))::text || ' times)' END AS status
  FROM (SELECT CASE WHEN to_regprocedure('public.manual_check_in(uuid,uuid,text,text)') IS NULL THEN '' ELSE pg_get_functiondef(to_regprocedure('public.manual_check_in(uuid,uuid,text,text)')) END AS def) d,
       (SELECT ARRAY[
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
  ] AS p) x,
       generate_subscripts(x.p, 1) AS i
ORDER BY 1, 2;
ROLLBACK;
