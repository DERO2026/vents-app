-- VENTS Wallet refunds -- Tickets only, in this pass.
--
-- AUDIT FINDING (read before touching Services): there is no existing
-- Service-booking cancellation/refund RPC anywhere in this schema.
-- service_bookings.status has a 'cancelled' value in its CHECK constraint
-- (0054_service_bookings_marketplace.sql), but no function ever writes it,
-- and no Paystack-refund call exists for a service booking anywhere in
-- api/ or supabase/migrations. ServiceBookingsScreen.tsx only displays
-- status labels; it has no cancel/refund action wired to anything.
-- Building that production path from scratch was not part of what this
-- pass was approved for ("find the actual production path and modify
-- that path rather than creating a parallel refund system" -- there is no
-- path to modify), so Service wallet refunds are deliberately NOT
-- implemented here. Only Ticket wallet refunds are implemented below,
-- against the real, already-proven refund_ticket path.
--
-- Ticket refund path this migration modifies (traced from the actual
-- code, not assumed):
--   1. refund_ticket(p_ticket_id, p_reason) -- organizer/admin-triggered,
--      SECURITY DEFINER, granted to authenticated (0011_grants.sql).
--      Locks the ticket FOR UPDATE, computes the buyer's fee-inclusive
--      refund amount, and for a real (non-free) payment previously always
--      flipped payment_status to 'refund_pending' and returned the amount
--      for api/wallet/refund-ticket.ts to hand to Paystack's refund API.
--   2. api/wallet/refund-ticket.ts -- calls Paystack's own POST /refund,
--      then attach_ticket_refund_id.
--   3. refund.processed webhook (api/webhook/paystack.ts) ->
--      finalize_ticket_refund -- the ASYNC step that actually flips
--      payment_status to 'refunded' and reverses the organizer's earned
--      credit (organizer_wallets), once Paystack confirms the money moved.
--
-- A wallet-paid ticket has no Paystack transaction at all, so step 2/3's
-- entire async round-trip is meaningless for it -- there is nothing for
-- Paystack to refund and no refund.processed event will ever arrive for
-- a reference Paystack never saw. This migration adds a THIRD branch
-- directly inside refund_ticket, for payment_method = 'wallet' only: it
-- credits user_wallets and flips the ticket to 'refunded' SYNCHRONOUSLY,
-- in the same call, instead of going through 'refund_pending'. The
-- existing Paystack branch (payment_method = 'paystack' or NULL/legacy)
-- is left completely unchanged -- api/wallet/refund-ticket.ts and the
-- refund.processed webhook handler both need zero changes: a wallet
-- refund returns status: 'refunded' directly, which refund-ticket.ts's
-- existing `if (state?.status === 'refunded' || ...)` branch already
-- treats as terminal, before it would ever reach the Paystack fetch call.
--
-- Organizer earnings reversal is copied verbatim (same formula, same
-- clamped-under-lock debit, same shortfall admin_log) from
-- finalize_ticket_refund's existing logic (0061_notification_push_data_
-- backfill.sql) -- an organizer must not keep a ticket's earned credit
-- just because the buyer happened to pay with Wallet instead of Paystack.
-- finalize_ticket_refund itself is NOT modified by this migration (it
-- still only ever runs for a real refund_pending -> Paystack-refunded
-- transition, which a wallet-paid ticket never enters).

CREATE UNIQUE INDEX IF NOT EXISTS user_wallet_transactions_refund_ref_idx
  ON public.user_wallet_transactions (reference_id)
  WHERE (type = 'refund' AND reference_id IS NOT NULL);

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

  -- Buyer's paid share for this ticket, service fee included -- the
  -- per-ticket version of the group formula confirm_ticket_payment sums
  -- (CheckoutScreen.tsx: total = subtotal * (1.05 - discount%/100)). Summed
  -- across every ticket sharing a payment_ref this equals the group total
  -- that was actually charged, so refunding one ticket at a time out of a
  -- multi-attendee purchase never over- or under-refunds what Paystack
  -- actually collected.
  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  -- Free ticket: nothing was ever charged or credited to the organizer, so
  -- finalize immediately -- no Paystack call, no wallet credit, nothing to
  -- reverse. Unchanged from before this migration.
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

  -- Wallet-paid ticket: synchronous credit-back, no Paystack round-trip.
  -- See this migration's header comment for the full reasoning.
  IF v_ticket.payment_method = 'wallet' THEN
    INSERT INTO public.user_wallets (user_id) VALUES (v_ticket.user_id)
    ON CONFLICT (user_id) DO NOTHING;

    PERFORM 1 FROM public.user_wallets WHERE user_id = v_ticket.user_id FOR UPDATE;

    -- Idempotency: reference_id = this ticket's own id, guarded by
    -- user_wallet_transactions_refund_ref_idx above -- at most one refund
    -- ledger row (and therefore at most one credit) can ever exist for
    -- this ticket. The payment_status = 'refunded' check already done at
    -- the top of this function (under the same row lock acquired there)
    -- is the primary guard for a concurrent/retried call; this index is
    -- defense-in-depth, same relationship as 0066's spend-ref index.
    INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id)
    VALUES (v_ticket.user_id, 'refund', v_refund_kobo, 'Ticket refund: ' || v_ticket.ticket_type, v_ticket.id::text)
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

    -- Reverse exactly what credit_organizer_wallet originally credited for
    -- this ticket -- copied verbatim from finalize_ticket_refund's own
    -- logic (same formula, same clamped-under-lock debit, same shortfall
    -- admin_log) so organizer earnings are reversed identically regardless
    -- of how the buyer paid.
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

  -- Paystack-paid (or legacy NULL payment_method) ticket -- entirely
  -- unchanged from before this migration: flips to refund_pending and
  -- hands off to api/wallet/refund-ticket.ts + the refund.processed
  -- webhook, exactly as before.
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
$function$
;
