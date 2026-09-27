-- Large-event scalability/security audit -- remaining LOW-severity
-- hardening items.
--
-- 1) `is_admin()` already covers the platform root account via
--    `is_root()` (SELECT auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'),
--    confirmed live. verify_entry_pass, refund_ticket, and
--    is_event_door_manager each ALSO hardcoded that same UUID literal as a
--    second, independent bypass branch alongside `is_admin()` -- redundant
--    given that account's `role = 'admin'` today, but a maintainability/
--    least-privilege smell: a second, harder-to-revoke path to the same
--    privilege baked into three function bodies instead of driven solely
--    by the `role` column through `is_admin()`. Removing the redundant
--    literal from each does not change who can do what today (is_admin()
--    already grants the same access via is_root()) -- it just removes the
--    duplicate, independently-editable copy of that check.
--
-- 2) `anon` (unauthenticated) had EXECUTE on verify_entry_pass,
--    manual_check_in, and refund_ticket. Not exploitable in practice --
--    each function's first line rejects a NULL auth.uid() -- but
--    unnecessary attack surface for functions that require authentication.
--    Revoking EXECUTE from `anon` on all three.

-- ── 1a. verify_entry_pass: drop the redundant root-UID branch ───────────────
CREATE OR REPLACE FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid, p_device_id text DEFAULT NULL::text, p_gate_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_secret       text;
  v_seg1         text;
  v_seg2         text;
  v_expected_sig text;
  v_payload      jsonb;
  v_raw_id       text;
  v_ticket       record;
  v_log_event_id uuid;
  v_reason       text;
  v_message      text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to scan as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('qr_scan:' || p_actor_id::text, 30, 10);

  IF p_ticket_id IS NULL OR strpos(p_ticket_id, '.') = 0 THEN
    v_reason := 'unsigned_ticket';
    v_message := 'This ticket is missing its cryptographic signature and cannot be accepted. Ask the attendee to reopen their ticket (online) and rescan.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_seg1 := split_part(p_ticket_id, '.', 1);
  v_seg2 := split_part(p_ticket_id, '.', 2);

  IF v_seg1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_reason := 'legacy_token';
    v_message := 'This pass uses an outdated format. Ask the attendee to reopen their ticket (online) to refresh it, then rescan.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  SELECT value INTO v_secret FROM private.app_secrets WHERE key = 'ticket_hmac_v2';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Ticket verification secret is not configured';
  END IF;

  v_expected_sig := encode(extensions.hmac(v_seg1, v_secret, 'sha256'), 'hex');
  IF v_seg2 IS DISTINCT FROM v_expected_sig THEN
    v_reason := 'invalid_signature';
    v_message := 'This QR code failed cryptographic verification.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  BEGIN
    v_payload := convert_from(
      decode(translate(v_seg1, '-_', '+/') || repeat('=', (4 - length(v_seg1) % 4) % 4), 'base64'),
      'UTF8'
    )::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_reason := 'invalid_token';
    v_message := 'This QR code could not be read.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END;

  -- From here on the payload is readable, so its eventId (unverified against
  -- the ticket yet, but still the attendee's claimed event) lets us attribute
  -- the log entry to the right event's dashboard even when the check below
  -- fails before a ticket row is loaded.
  BEGIN
    v_log_event_id := (v_payload->>'eventId')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_log_event_id := NULL;
  END;

  IF (v_payload->>'version') IS DISTINCT FROM '2' THEN
    v_reason := 'invalid_token';
    v_message := 'Unsupported ticket version.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF (v_payload->>'expiresAt') IS NULL
     OR (v_payload->>'expiresAt')::timestamptz < now() THEN
    v_reason := 'expired';
    v_message := 'This ticket pass has expired.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_raw_id := v_payload->>'ticketId';

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type,
         t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id::text = v_raw_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    v_reason := 'not_found';
    v_message := 'Ticket not found in system.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  -- Now that the real ticket is loaded, prefer its authoritative event_id for
  -- logging over the unverified payload claim.
  v_log_event_id := v_ticket.event_id;

  IF (v_payload->>'eventId') IS DISTINCT FROM v_ticket.event_id::text
     OR (v_payload->>'purchaserId') IS DISTINCT FROM v_ticket.user_id::text THEN
    v_reason := 'payload_mismatch';
    v_message := 'This ticket pass does not match its event record.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  -- Root/superadmin access is already covered by is_admin() (is_root() is
  -- one of its OR branches) -- no separate hardcoded-UUID bypass needed.
  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin() THEN
    v_reason := 'wrong_organizer';
    v_message := 'This ticket belongs to a different organizer''s event.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'wrong_event', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.status <> 'active' THEN
    v_reason := 'not_active';
    v_message := 'This ticket is ' || v_ticket.status || ', not active.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id,
      public.scan_reason_to_result(v_reason, v_message), v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already scanned.', p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  -- ATOMIC check-in: the tickets flag, the ledger row, and the scan log all
  -- commit together in this one SECURITY DEFINER call's transaction. The
  -- `WHERE checked_in = false` re-check + ON CONFLICT DO NOTHING below is what
  -- actually makes a race between two simultaneous scans of the same ticket
  -- safe -- the FOR UPDATE row lock above already serializes concurrent
  -- scanners against this same ticket row, so only one commits the flip.
  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already scanned.', p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, false)
  ON CONFLICT (ticket_id) DO NOTHING;

  PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, false);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', false,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$;

-- ── 1b. refund_ticket: drop the redundant root-UID branch ───────────────────
CREATE OR REPLACE FUNCTION public.refund_ticket(p_ticket_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket             record;
  v_refund_kobo        bigint;
  v_owed_kobo          bigint;
  v_platform_fee_kobo  bigint;
  v_wallet_bal         bigint;
  v_actual_debit       bigint;
  v_wallet_refund_tx_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A refund reason is required';
  END IF;

  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage,
         t.ticket_type, t.user_id, t.checked_in, t.payment_method, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  -- Root/superadmin access is already covered by is_admin() (is_root() is
  -- one of its OR branches) -- no separate hardcoded-UUID bypass needed.
  IF v_ticket.organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only the event organizer or an admin can refund this ticket';
  END IF;

  IF v_ticket.payment_status = 'refunded' THEN
    RETURN jsonb_build_object('status', 'already_refunded', 'ticket_id', v_ticket.id);
  END IF;

  IF v_ticket.payment_status = 'refund_pending' THEN
    RETURN jsonb_build_object(
      'status', 'refund_pending', 'ticket_id', v_ticket.id, 'payment_ref', v_ticket.payment_ref
    );
  END IF;

  IF v_ticket.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Only paid tickets can be refunded (current status: %)', v_ticket.payment_status;
  END IF;

  IF v_ticket.checked_in THEN
    RAISE EXCEPTION 'A checked-in ticket cannot be refunded';
  END IF;

  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  IF v_ticket.amount <= 0 OR v_refund_kobo <= 0 THEN
    UPDATE public.tickets
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_ticket.id;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_ticket.user_id, 'booking', 'Ticket refunded',
      'Your ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been refunded. Reason: ' || p_reason,
      false, '💸',
      jsonb_build_object('ticketId', v_ticket.id)
    );

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (
      auth.uid(), 'refund_ticket', v_ticket.user_id,
      jsonb_build_object('ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', 0),
      public.actor_role()
    );

    RETURN jsonb_build_object('status', 'refunded', 'ticket_id', v_ticket.id, 'amount_kobo', 0);
  END IF;

  IF v_ticket.payment_method = 'wallet' THEN
    INSERT INTO public.user_wallets (user_id) VALUES (v_ticket.user_id)
    ON CONFLICT (user_id) DO NOTHING;

    PERFORM 1 FROM public.user_wallets WHERE user_id = v_ticket.user_id FOR UPDATE;

    v_platform_fee_kobo := GREATEST(0, v_refund_kobo - floor(v_ticket.amount * 100)::bigint);

    INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
    VALUES (
      v_ticket.user_id, 'refund', v_refund_kobo, 'Ticket refund: ' || v_ticket.ticket_type, v_ticket.id::text,
      jsonb_build_object('ticket_id', v_ticket.id, 'platform_fee_absorbed_kobo', v_platform_fee_kobo)
    )
    ON CONFLICT (reference_id) WHERE (type = 'refund' AND reference_id IS NOT NULL) DO NOTHING
    RETURNING id INTO v_wallet_refund_tx_id;

    IF v_wallet_refund_tx_id IS NULL THEN
      RETURN jsonb_build_object('status', 'already_refunded', 'ticket_id', v_ticket.id);
    END IF;

    UPDATE public.user_wallets
       SET balance_kobo = balance_kobo + v_refund_kobo, updated_at = now()
     WHERE user_id = v_ticket.user_id;

    UPDATE public.tickets
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_ticket.id;

    IF v_ticket.organizer_id IS NOT NULL THEN
      v_owed_kobo := floor(v_ticket.amount * 100)::bigint;

      SELECT balance_kobo INTO v_wallet_bal
        FROM public.organizer_wallets
       WHERE organizer_id = v_ticket.organizer_id
         FOR UPDATE;

      v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_owed_kobo);

      IF v_actual_debit > 0 THEN
        UPDATE public.organizer_wallets
           SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
         WHERE organizer_id = v_ticket.organizer_id;

        INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
        VALUES (
          v_ticket.organizer_id, 'refund', v_actual_debit,
          'Refund (Wallet): ' || v_ticket.ticket_type ||
            CASE WHEN v_actual_debit < v_owed_kobo
                 THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_owed_kobo || ' kobo owed)'
                 ELSE '' END,
          v_ticket.id
        );
      END IF;

      IF v_actual_debit < v_owed_kobo THEN
        INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
        VALUES (
          auth.uid(), 'refund_wallet_shortfall', v_ticket.organizer_id,
          jsonb_build_object(
            'ticket_id', v_ticket.id, 'owed_kobo', v_owed_kobo, 'recovered_kobo', v_actual_debit,
            'shortfall_kobo', v_owed_kobo - v_actual_debit
          ),
          public.actor_role()
        );
      END IF;
    END IF;

    IF v_platform_fee_kobo > 0 THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), 'refund_platform_fee_absorbed', v_ticket.user_id,
        jsonb_build_object(
          'ticket_id', v_ticket.id, 'refund_method', 'wallet',
          'platform_fee_absorbed_kobo', v_platform_fee_kobo, 'refund_kobo', v_refund_kobo
        ),
        public.actor_role()
      );
    END IF;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_ticket.user_id, 'booking', 'Ticket refunded',
      'Your ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been refunded to your VENTS Wallet. Reason: ' || p_reason,
      false, '💸',
      jsonb_build_object('ticketId', v_ticket.id)
    );

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (
      auth.uid(), 'refund_ticket_wallet', v_ticket.user_id,
      jsonb_build_object('ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', v_refund_kobo),
      public.actor_role()
    );

    RETURN jsonb_build_object('status', 'refunded', 'ticket_id', v_ticket.id, 'amount_kobo', v_refund_kobo, 'refund_method', 'wallet');
  END IF;

  UPDATE public.tickets
     SET payment_status = 'refund_pending', status = 'cancelled',
         refund_reason = p_reason, refund_initiated_by = auth.uid()
   WHERE id = v_ticket.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'refund_ticket_initiated', v_ticket.user_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', v_refund_kobo,
      'checked_in', v_ticket.checked_in
    ),
    public.actor_role()
  );

  RETURN jsonb_build_object(
    'status', 'refund_pending',
    'ticket_id', v_ticket.id,
    'payment_ref', v_ticket.payment_ref,
    'amount_kobo', v_refund_kobo,
    'user_id', v_ticket.user_id
  );
END;
$function$;

-- ── 1c. is_event_door_manager: drop the redundant root-UID branch ───────────
CREATE OR REPLACE FUNCTION public.is_event_door_manager(p_event_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.events e WHERE e.id = p_event_id AND e.organizer_id = auth.uid())
      OR public.is_admin();
$function$;

-- ── 2. Revoke unnecessary anon EXECUTE on authentication-required functions ──
REVOKE EXECUTE ON FUNCTION public.verify_entry_pass(text, uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.manual_check_in(uuid, uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.refund_ticket(uuid, text) FROM anon;
