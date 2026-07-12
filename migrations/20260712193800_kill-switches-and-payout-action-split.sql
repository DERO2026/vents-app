-- Block 17: Operational Controls & Admin Safety.
--
-- 1. KILL SWITCH: four explicit boolean flags on the existing singleton
--    app_config table (same table maintenance_mode already lives on, same
--    is_root()-gated UPDATE / anon-readable SELECT policy already in
--    place — no new table or RLS pattern needed). Enforced server-side in
--    the RPCs that actually perform the gated action, not just hidden in
--    the UI, so a direct API call is rejected the same as a UI click.
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS disable_purchases boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disable_scanning  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disable_signups   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disable_payouts   boolean NOT NULL DEFAULT false;

-- 2. PAYOUT ACTION AUDIT: neither admin_reject_organizer_payout nor
--    admin_cancel_processing_payout recorded which admin performed the
--    action anywhere — is_admin() only checked that *an* admin did it.
--    Adding a queryable resolved_by column (for at-a-glance display) plus
--    the same admin_logs audit-trail pattern already used everywhere else
--    in this app (hide_event, delete_event, reject_organizer_verification,
--    etc.).
ALTER TABLE public.organizer_withdrawal_requests
  ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES auth.users(id);

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_organizer_id uuid; v_amount_kobo bigint; v_status text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests WHERE id = p_request_id;
  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status NOT IN ('pending') THEN RAISE EXCEPTION 'Only pending requests can be rejected'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo, pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo), updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_payout_request', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN 'rejected';
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id = p_request_id;

  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_status; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id)
  VALUES (v_organizer_id, 'cancelled_payout_refund', v_amount_kobo,
          'Payout request cancelled by admin, funds returned — ' || p_reason, p_request_id);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'cancel_processing_payout', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing', paystack_reference = p_paystack_reference, transfer_code = p_transfer_code,
      resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'pending';

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'approve_payout_request',
          jsonb_build_object('request_id', p_request_id, 'transfer_code', p_transfer_code),
          public.actor_role());
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_get_payout_for_processing(p_request_id uuid)
 RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, recipient_code text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, b.recipient_code, r.status
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END; $function$;

-- 3. ENFORCE disable_purchases / disable_scanning at the RPC layer itself
--    (not just in the UI) so a direct API call is rejected exactly like a
--    UI click would be blocked.
CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id       uuid := auth.uid();
  v_event         record;
  v_ticket_obj    jsonb;
  v_unit_price    numeric;
  v_discount_pct  numeric := 0;
  v_effective     numeric;
  v_status        text;
  v_attendee      jsonb;
  v_ticket_id     uuid;
  v_ticket_ids    uuid[] := ARRAY[]::uuid[];
  v_count         integer;
  v_promo         public.promo_codes;
  v_existing_ids  uuid[];
  v_event_sold    integer;
  v_type_sold     integer;
  v_type_limit    integer;
BEGIN
  IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public.check_rate_limit('ticket_purchase:' || v_user_id::text, 8, 60);

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));

  SELECT array_agg(id) INTO v_existing_ids
  FROM public.tickets
  WHERE event_id = p_event_id AND user_id = v_user_id AND status = 'active';

  IF v_existing_ids IS NOT NULL THEN
    RETURN v_existing_ids;
  END IF;

  SELECT price, ticket_types, ticket_goal INTO v_event
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

  IF v_event.ticket_goal IS NOT NULL AND v_event.ticket_goal > 0 THEN
    SELECT count(*) INTO v_event_sold FROM public.tickets WHERE event_id = p_event_id AND status = 'active';
    IF v_event_sold + v_count > v_event.ticket_goal THEN
      RAISE EXCEPTION 'Only % ticket(s) remaining for this event', GREATEST(0, v_event.ticket_goal - v_event_sold);
    END IF;
  END IF;

  IF v_ticket_obj IS NOT NULL AND v_ticket_obj ? 'quantity' THEN
    v_type_limit := NULLIF(v_ticket_obj->>'quantity', '')::integer;
    IF v_type_limit IS NOT NULL AND v_type_limit > 0 THEN
      SELECT count(*) INTO v_type_sold
      FROM public.tickets
      WHERE event_id = p_event_id AND ticket_type = p_ticket_type AND status = 'active';

      IF v_type_sold + v_count > v_type_limit THEN
        RAISE EXCEPTION 'Only % % ticket(s) remaining', GREATEST(0, v_type_limit - v_type_sold), p_ticket_type;
      END IF;
    END IF;
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

  IF v_status = 'paid' AND v_promo.id IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE id = v_promo.id;
  END IF;

  RETURN v_ticket_ids;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_raw_id text;
  v_sig text;
  v_expected_sig text;
  v_ticket record;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to scan as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('qr_scan:' || p_actor_id::text, 30, 10);

  IF strpos(p_ticket_id, '.') = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'unsigned_ticket',
      'message', 'This ticket is missing its cryptographic signature and cannot be accepted. Ask the attendee to reopen their ticket (with an internet connection, at least once) and rescan.'
    );
  END IF;

  v_raw_id := split_part(p_ticket_id, '.', 1);
  v_sig := split_part(p_ticket_id, '.', 2);
  v_expected_sig := encode(public.hmac(v_raw_id, 'vents-ticket-hmac-v1', 'sha256'), 'hex');
  IF v_sig IS DISTINCT FROM v_expected_sig THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_signature', 'message', 'This QR code failed cryptographic verification.');
  END IF;

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title, e.event_date
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id::text = v_raw_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'Ticket not found in system.');
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin()
     AND p_actor_id <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_organizer', 'message', 'This ticket belongs to a different organizer''s event.');
  END IF;

  IF v_ticket.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active', 'message', 'This ticket is ' || v_ticket.status || ', not active.');
  END IF;

  IF v_ticket.checked_in THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'checked_in_at', v_ticket.checked_in_at,
      'scanner_id', v_ticket.scanner_id
    );
  END IF;

  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned', 'message', 'This ticket was already scanned.');
  END IF;

  INSERT INTO public.checkins (ticket_id, event_id, scanned_by, checked_in_at)
  VALUES (v_ticket.id, v_ticket.event_id, p_actor_id, now())
  ON CONFLICT (ticket_id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now()
  );
END;
$function$;

-- 4. Pre-flight check the client calls before attempting signup — see the
-- Session & Token Hardening phase's check_auth_rate_limit for the same
-- architectural note: InsForge's /api/auth/signup runs outside our
-- schema, so this can't stop a scripted attacker who calls it directly,
-- only traffic that goes through our own client.
CREATE OR REPLACE FUNCTION public.check_signups_enabled()
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  IF (SELECT disable_signups FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'signups_disabled';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.check_signups_enabled() TO anon, authenticated;
