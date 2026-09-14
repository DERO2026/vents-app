-- Services refund lifecycle. Audit (this session) confirmed there is
-- currently NO way to cancel/refund a service_bookings row at all: zero
-- cancel/refund functions, RLS only grants admin UPDATE, and the table is
-- missing the refund_reason/refund_initiated_by/refund_id columns tickets
-- already have. This migration adds the minimal equivalent of the ticket
-- refund architecture (0004/0067/0075), adapted where Services genuinely
-- differs from tickets:
--
--   * Authorization: tickets use "event organizer or admin" -- Services has
--     no event/organizer concept, so the analogous actor is the provider
--     who owns the booking (service_providers.user_id = auth.uid()), or
--     admin. Never the customer -- mirrors tickets exactly there.
--   * Amount math: tickets store a float `amount` (organizer's pre-fee
--     share) and recompute the fee-inclusive buyer refund with
--     `amount * (1.05 - discount%/100) * 100` every time. service_bookings
--     already stores subtotal_kobo/fee_kobo/total_kobo directly in kobo at
--     booking time (create_service_booking), so the refund needs no
--     recomputation: v_refund_kobo = total_kobo (buyer gets everything
--     back), v_owed_kobo = subtotal_kobo (provider clawback, fee excluded).
--   * VENTS absorbs fee_kobo on refund exactly like the ticket wallet
--     branch absorbs its 5%, recorded via admin_logs, no separate ledger
--     move (same rule, not copied code).
--   * Idempotency reuses the existing generic partial unique index
--     user_wallet_transactions_refund_ref_idx (0067) keyed on the booking's
--     own UUID as reference_id -- ticket UUIDs and booking UUIDs are
--     disjoint UUID spaces, so no new index is needed.
--   * Paystack leg mirrors refund_ticket/finalize_ticket_refund/
--     fail_ticket_refund/attach_ticket_refund_id/admin_revert_stuck_refund
--     exactly in shape: cancel_service_booking flips paid->refund_pending,
--     a new API endpoint (api/wallet/refund-service-booking.ts, mirroring
--     api/wallet/refund-ticket.ts) calls Paystack, and the refund.processed/
--     refund.failed webhook gets one more fallback link
--     (finalize_service_booking_refund / fail_service_booking_refund),
--     project_admin-only for the same enumerable-Paystack-id reason as the
--     existing ticket/transfer-fee refund finalizers.
--
-- NOT deployed to Production by this migration file's existence alone --
-- per explicit instruction, this is written and tested locally only and
-- requires separate, explicit approval before being applied.

-- ── 1. Schema: mirror tickets' refund-tracking columns ──────────────────
ALTER TABLE public.service_bookings
  ADD COLUMN IF NOT EXISTS refund_reason text,
  ADD COLUMN IF NOT EXISTS refund_initiated_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS refund_id text;

ALTER TABLE public.service_bookings
  ADD CONSTRAINT service_bookings_refund_id_key UNIQUE (refund_id);

ALTER TABLE public.service_bookings
  DROP CONSTRAINT service_bookings_payment_status_check;
ALTER TABLE public.service_bookings
  ADD CONSTRAINT service_bookings_payment_status_check
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'refund_pending', 'refunded'));

-- ── 2. cancel_service_booking: the authorization + amount-derivation +
-- state-transition entry point. Provider-of-the-booking or admin only.
-- Locks the booking row FOR UPDATE, branches exactly like refund_ticket:
-- free/zero-amount booking -> instant refund with no money movement;
-- wallet-paid -> synchronous wallet credit + provider clawback, VENTS
-- absorbs fee_kobo; paystack/NULL-paid -> flips to refund_pending, the
-- async Paystack leg happens outside this function.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_service_booking(p_booking_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking            record;
  v_provider_user_id   uuid;
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

  SELECT b.id, b.customer_id, b.provider_id, b.status, b.payment_status, b.payment_ref,
         b.payment_method, b.subtotal_kobo, b.fee_kobo, b.total_kobo, sp.user_id AS provider_user_id
    INTO v_booking
    FROM public.service_bookings b
    JOIN public.service_providers sp ON sp.id = b.provider_id
   WHERE b.id = p_booking_id
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  IF v_booking.provider_user_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only the service provider or an admin can cancel this booking';
  END IF;

  IF v_booking.payment_status = 'refunded' THEN
    RETURN jsonb_build_object('status', 'already_refunded', 'booking_id', v_booking.id);
  END IF;

  IF v_booking.payment_status = 'refund_pending' THEN
    RETURN jsonb_build_object(
      'status', 'refund_pending', 'booking_id', v_booking.id, 'payment_ref', v_booking.payment_ref
    );
  END IF;

  IF v_booking.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Only paid bookings can be refunded (current status: %)', v_booking.payment_status;
  END IF;

  v_provider_user_id := v_booking.provider_user_id;

  IF v_booking.total_kobo <= 0 THEN
    UPDATE public.service_bookings
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_booking.id;

    INSERT INTO public.notifications (user_id, type, title, body)
    VALUES (v_booking.customer_id, 'booking', 'Booking cancelled',
            'Your service booking has been cancelled. Reason: ' || p_reason);

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (auth.uid(), 'cancel_service_booking', v_booking.customer_id,
            jsonb_build_object('booking_id', v_booking.id, 'reason', p_reason, 'amount_kobo', 0),
            public.actor_role());

    RETURN jsonb_build_object('status', 'refunded', 'booking_id', v_booking.id, 'amount_kobo', 0);
  END IF;

  IF v_booking.payment_method = 'wallet' THEN
    INSERT INTO public.user_wallets (user_id) VALUES (v_booking.customer_id)
    ON CONFLICT (user_id) DO NOTHING;

    PERFORM 1 FROM public.user_wallets WHERE user_id = v_booking.customer_id FOR UPDATE;

    -- Buyer gets the full fee-inclusive total back; VENTS absorbs fee_kobo
    -- (recorded via admin_logs below, no separate ledger move -- same rule
    -- as refund_ticket's wallet branch).
    INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
    VALUES (
      v_booking.customer_id, 'refund', v_booking.total_kobo, 'Service booking refund', v_booking.id::text,
      jsonb_build_object('booking_id', v_booking.id, 'platform_fee_absorbed_kobo', v_booking.fee_kobo)
    )
    ON CONFLICT (reference_id) WHERE (type = 'refund' AND reference_id IS NOT NULL) DO NOTHING
    RETURNING id INTO v_wallet_refund_tx_id;

    IF v_wallet_refund_tx_id IS NULL THEN
      RETURN jsonb_build_object('status', 'already_refunded', 'booking_id', v_booking.id);
    END IF;

    UPDATE public.user_wallets
       SET balance_kobo = balance_kobo + v_booking.total_kobo, updated_at = now()
     WHERE user_id = v_booking.customer_id;

    UPDATE public.service_bookings
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_booking.id;

    -- Clawback is the provider's subtotal only (fee_kobo was never
    -- credited to the provider -- create_service_booking/
    -- credit_provider_wallet_for_booking credits subtotal_kobo alone),
    -- clamped to the provider's current balance under a row lock, with any
    -- shortfall written to admin_logs rather than silently dropped.
    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_provider_user_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_booking.subtotal_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_provider_user_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
      VALUES (
        v_provider_user_id, 'refund', v_actual_debit,
        'Refund (Wallet): service booking' ||
          CASE WHEN v_actual_debit < v_booking.subtotal_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_booking.subtotal_kobo || ' kobo owed)'
               ELSE '' END,
        jsonb_build_object('service_booking_id', v_booking.id)
      );
    END IF;

    IF v_actual_debit < v_booking.subtotal_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), 'refund_service_booking_wallet_shortfall', v_provider_user_id,
        jsonb_build_object(
          'booking_id', v_booking.id, 'owed_kobo', v_booking.subtotal_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_booking.subtotal_kobo - v_actual_debit
        ),
        public.actor_role()
      );
    END IF;

    IF v_booking.fee_kobo > 0 THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), 'refund_platform_fee_absorbed', v_booking.customer_id,
        jsonb_build_object(
          'booking_id', v_booking.id, 'refund_method', 'wallet',
          'platform_fee_absorbed_kobo', v_booking.fee_kobo, 'refund_kobo', v_booking.total_kobo
        ),
        public.actor_role()
      );
    END IF;

    INSERT INTO public.notifications (user_id, type, title, body)
    VALUES (v_booking.customer_id, 'booking', 'Booking refunded',
            'Your service booking has been refunded to your VENTS Wallet. Reason: ' || p_reason);

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (auth.uid(), 'cancel_service_booking_wallet', v_booking.customer_id,
            jsonb_build_object('booking_id', v_booking.id, 'reason', p_reason, 'amount_kobo', v_booking.total_kobo),
            public.actor_role());

    RETURN jsonb_build_object(
      'status', 'refunded', 'booking_id', v_booking.id,
      'amount_kobo', v_booking.total_kobo, 'refund_method', 'wallet'
    );
  END IF;

  UPDATE public.service_bookings
     SET payment_status = 'refund_pending', status = 'cancelled',
         refund_reason = p_reason, refund_initiated_by = auth.uid()
   WHERE id = v_booking.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'cancel_service_booking_initiated', v_booking.customer_id,
    jsonb_build_object('booking_id', v_booking.id, 'reason', p_reason, 'amount_kobo', v_booking.total_kobo),
    public.actor_role()
  );

  RETURN jsonb_build_object(
    'status', 'refund_pending',
    'booking_id', v_booking.id,
    'payment_ref', v_booking.payment_ref,
    'amount_kobo', v_booking.total_kobo,
    'user_id', v_booking.customer_id
  );
END;
$function$
;

REVOKE ALL ON FUNCTION public.cancel_service_booking(uuid, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.cancel_service_booking(uuid, text) TO authenticated;

-- ── 3. attach_service_booking_refund_id -- same shape as
-- attach_ticket_refund_id: caller-authorized (provider-or-admin), records
-- Paystack's refund id once cancel_service_booking has flipped the row to
-- refund_pending, so the webhook can find it again.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attach_service_booking_refund_id(p_booking_id uuid, p_refund_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_provider_user_id uuid;
  v_status           text;
  v_customer_id      uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT sp.user_id, b.payment_status, b.customer_id
    INTO v_provider_user_id, v_status, v_customer_id
    FROM public.service_bookings b
    JOIN public.service_providers sp ON sp.id = b.provider_id
   WHERE b.id = p_booking_id
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  IF v_provider_user_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Booking is not awaiting a refund (status: %)', v_status;
  END IF;

  UPDATE public.service_bookings SET refund_id = p_refund_id WHERE id = p_booking_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'attach_service_booking_refund_id', v_customer_id,
          jsonb_build_object('booking_id', p_booking_id, 'refund_id', p_refund_id), public.actor_role());
END;
$function$
;

REVOKE ALL ON FUNCTION public.attach_service_booking_refund_id(uuid, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.attach_service_booking_refund_id(uuid, text) TO authenticated;

-- ── 4. admin_revert_stuck_service_refund -- same shape as
-- admin_revert_stuck_refund: super-admin-only manual escape hatch when
-- Paystack rejected the refund creation call outright.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_revert_stuck_service_refund(p_booking_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking record;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT id, customer_id, payment_status INTO v_booking
    FROM public.service_bookings
   WHERE id = p_booking_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  IF v_booking.payment_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Only bookings awaiting refund can be reverted (current status: %)', v_booking.payment_status;
  END IF;

  UPDATE public.service_bookings
     SET payment_status = 'paid', status = 'confirmed', refund_id = NULL
   WHERE id = p_booking_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'admin_revert_stuck_service_refund', v_booking.customer_id,
    jsonb_build_object('booking_id', p_booking_id, 'reason', p_reason),
    public.actor_role()
  );

  RETURN 'reverted';
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_revert_stuck_service_refund(uuid, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_revert_stuck_service_refund(uuid, text) TO authenticated;

-- ── 5. finalize_service_booking_refund / fail_service_booking_refund --
-- project_admin-only, keyed only on Paystack's own numeric refund id, same
-- reasoning as finalize_ticket_refund/fail_ticket_refund (that id alone is
-- short/sequential/enumerable with no internal auth check, so these must
-- never be reachable over the normal REST surface).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_service_booking_refund(p_refund_id text)
 RETURNS TABLE(status text, customer_email text, customer_name text, refunded_amount_kobo bigint, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking      record;
  v_wallet_bal   bigint;
  v_actual_debit bigint;
BEGIN
  SELECT b.id, b.customer_id, b.provider_id, b.payment_status, b.refund_initiated_by, b.refund_reason,
         b.subtotal_kobo, b.fee_kobo, b.total_kobo, sp.user_id AS provider_user_id
    INTO v_booking
    FROM public.service_bookings b
    JOIN public.service_providers sp ON sp.id = b.provider_id
   WHERE b.refund_id = p_refund_id
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_booking.payment_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_refunded'::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_booking.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  UPDATE public.service_bookings SET payment_status = 'refunded' WHERE id = v_booking.id;

  -- Reverse exactly what credit_provider_wallet_for_booking originally
  -- credited (subtotal_kobo only -- fee_kobo was never credited to the
  -- provider), clamped at the current balance under a row lock.
  IF v_booking.subtotal_kobo > 0 THEN
    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_booking.provider_user_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_booking.subtotal_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_booking.provider_user_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
      VALUES (
        v_booking.provider_user_id, 'refund', v_actual_debit,
        'Refund (Paystack): service booking' ||
          CASE WHEN v_actual_debit < v_booking.subtotal_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_booking.subtotal_kobo || ' kobo owed)'
               ELSE '' END,
        jsonb_build_object('service_booking_id', v_booking.id)
      );
    END IF;

    IF v_actual_debit < v_booking.subtotal_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        v_booking.refund_initiated_by, 'refund_service_booking_shortfall', v_booking.provider_user_id,
        jsonb_build_object(
          'booking_id', v_booking.id, 'owed_kobo', v_booking.subtotal_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_booking.subtotal_kobo - v_actual_debit
        ),
        'webhook'
      );
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_booking.customer_id, 'booking', 'Booking refunded', 'Your service booking has been refunded.');

  RETURN QUERY
  SELECT 'finalized'::text, u.email, u.full_name, v_booking.total_kobo, v_booking.refund_reason
    FROM public.users u WHERE u.id = v_booking.customer_id;
END;
$function$
;

REVOKE ALL ON FUNCTION public.finalize_service_booking_refund(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.finalize_service_booking_refund(text) TO project_admin;

CREATE OR REPLACE FUNCTION public.fail_service_booking_refund(p_refund_id text, p_reason text)
 RETURNS TABLE(status text, actor_email text, actor_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking record;
BEGIN
  SELECT id, customer_id, payment_status, refund_initiated_by
    INTO v_booking
    FROM public.service_bookings
   WHERE refund_id = p_refund_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_booking.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.service_bookings
     SET payment_status = 'paid', status = 'confirmed', refund_id = NULL
   WHERE id = v_booking.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_booking.refund_initiated_by, 'refund_service_booking_failed', v_booking.customer_id,
    jsonb_build_object('booking_id', v_booking.id, 'refund_id', p_refund_id, 'reason', p_reason),
    'webhook'
  );

  RETURN QUERY
  SELECT 'reverted'::text, u.email, u.full_name
    FROM public.users u WHERE u.id = v_booking.refund_initiated_by;
END;
$function$
;

REVOKE ALL ON FUNCTION public.fail_service_booking_refund(text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.fail_service_booking_refund(text, text) TO project_admin;
