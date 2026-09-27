-- Fix confirmed production issue #5: refund_ticket read and logged
-- `checked_in` (visible in the Paystack-refund-pending branch's admin_logs
-- details) but never used it as a precondition anywhere in the function --
-- not in the free-ticket branch, not the wallet branch, not the Paystack
-- branch. An organizer or admin could refund a ticket after the attendee
-- had already been scanned in at the door.
--
-- Confirmed this contradicts, rather than merely omits, VENTS's existing
-- policy on checked-in tickets -- it is not a new rule being invented here:
--   - initiate_ticket_transfer already hard-blocks with
--     "A ticket already checked in cannot be transferred".
--   - accept_ticket_transfer re-checks checked_in under lock and the final
--     UPDATE's own WHERE clause requires checked_in = false.
--   - No function anywhere in the schema ever sets checked_in back to
--     false -- verify_entry_pass and manual_check_in both flip it
--     false -> true exactly once (WHERE checked_in = false, checked via
--     ROW_COUNT) and there is no reversal path. A checked-in ticket is
--     already treated as a permanent, irrevocable terminal state for every
--     other ticket-mutating action; refund_ticket was the one exception.
-- Confirmed refund_ticket's authorization is unchanged by this fix: still
-- callable only by the event's organizer, an admin, or root (checked via
-- v_ticket.organizer_id = auth.uid() OR is_admin() OR root, identical to
-- the live pre-fix function).
--
-- Fix: add a single guard, checked atomically under the same row lock
-- (`FOR UPDATE OF t`) already taken at the top of the function, placed
-- after the existing idempotency short-circuits (already_refunded /
-- refund_pending) and the "only paid tickets can be refunded" check so
-- those retain their exact existing behavior and error precedence -- and
-- before every money-moving branch (free-ticket, wallet, Paystack), so a
-- checked-in ticket can reach NONE of them: no wallet credit, no
-- organizer_wallets debit, no organizer_transactions row, no
-- payment_status mutation, no notification, no admin_logs entry (RAISE
-- EXCEPTION aborts the whole call, same as the other guards in this
-- function that already behave this way, e.g. the payment_status check
-- immediately above it).

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

  IF v_ticket.organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND auth.uid() <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
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

  -- A checked-in ticket is a permanent, irrevocable state elsewhere in this
  -- schema (see header) -- refunding it here would have been the one
  -- ticket-mutating action that didn't respect that.
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
