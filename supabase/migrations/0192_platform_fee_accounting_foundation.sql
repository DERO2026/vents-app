-- Phase 1 of the VENTS revenue-accounting foundation (prerequisite for a
-- future recruiter-commission system, NOT implemented here or anywhere in
-- this migration). Schema-only: no recruiter-commission code, no cron
-- sweep, no dispute webhook handling, no refund-path ledger inserts yet
-- (those are Phases 2-4). Reviewed against the live DB (project
-- slrtjxtzhowhwhebjprv) before being drafted. NOT applied to production by
-- this session -- stays as a reviewable file until explicitly approved.
--
-- Historical backfill: deliberately NOT done. Every existing ticket row
-- keeps platform_fee_kobo = NULL; only confirm_ticket_payment's new call to
-- allocate_ticket_platform_fees() below populates it, and only going
-- forward from the next successful payment confirmation.
--
-- ---------------------------------------------------------------------
-- ALLOCATION-BASIS DESIGN NOTE (read before touching allocate_ticket_platform_fees)
-- ---------------------------------------------------------------------
-- confirm_ticket_payment computes the platform's 5% buyer surcharge once
-- per payment_ref (i.e. per ORDER, aggregating every tickets row that
-- shares that payment_ref): v_expected_kobo - v_credit_kobo, stored today
-- only inside organizer_transactions.metadata->>'buyer_fee_kobo' on the
-- wallet-credit row created by credit_organizer_wallet. That order-level
-- number is the only authoritative fee figure that exists -- it is NOT
-- recomputed here, only split.
--
-- tickets.platform_fee_kobo must be a per-ROW column. The chosen
-- allocation basis is each ticket row's own persisted `amount` (its gross,
-- pre-surcharge price for that row -- the exact quantity this data already
-- captures per ticket_type/holder). This is reliably derivable: `amount`
-- is NOT NULL-defaulted and is exactly what fed v_total_amount's SUM in
-- confirm_ticket_payment, so weighting by it reproduces, as closely as
-- integer kobo allows, how much of the order's surcharge "belongs" to each
-- row's price. Verified against live data: 99 of 102 non-null-payment_ref
-- orders are single-ticket (trivial allocation); the 3 multi-ticket orders
-- are all free (amount = 0, so buyer_fee_kobo = 0, allocation is trivially
-- 0 for every row) -- there is no live multi-ticket, non-zero-amount order
-- to cross-check against today, so the algorithm below is designed to be
-- correct from first principles rather than fit to an existing case.
--
-- Deterministic, exact-sum algorithm (largest-remainder / Hamilton
-- apportionment), computed entirely in allocate_ticket_platform_fees:
--   1. If the order's total amount is 0 (all tickets free), every row's
--      platform_fee_kobo is 0 -- no division, no ambiguity.
--   2. Otherwise, for each row i: raw_i = buyer_fee_kobo * amount_i / total_amount.
--   3. floor_i = floor(raw_i) is the base allocation for every row.
--   4. remainder = buyer_fee_kobo - sum(floor_i) (always < ticket_count,
--      since each row's fractional part is < 1).
--   5. The `remainder` extra kobo (1 each) go to the rows with the largest
--      fractional part of raw_i, ties broken by ascending ticket id --
--      fully deterministic, reproducible on retry.
-- This guarantees sum(platform_fee_kobo) over the order's rows ALWAYS
-- equals the authoritative buyer_fee_kobo exactly -- the invariant the
-- reconciliation view below checks.
--
-- Idempotency: allocate_ticket_platform_fees only ever writes rows where
-- platform_fee_kobo IS NULL. A retried webhook (confirm_ticket_payment
-- called again for an already-paid, already-allocated payment_ref) is a
-- guaranteed no-op for the allocation step -- it never recomputes or
-- overwrites a value once set.

-- ============================================================
-- 1. New columns on tickets / service_bookings
-- ============================================================

ALTER TABLE public.tickets
  ADD COLUMN platform_fee_kobo bigint NULL,
  ADD COLUMN platform_fee_absorbed_kobo bigint NOT NULL DEFAULT 0,
  ADD COLUMN qualifying_status text NOT NULL DEFAULT 'pending';

ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_platform_fee_kobo_nonneg CHECK (platform_fee_kobo IS NULL OR platform_fee_kobo >= 0),
  ADD CONSTRAINT tickets_platform_fee_absorbed_kobo_nonneg CHECK (platform_fee_absorbed_kobo >= 0),
  ADD CONSTRAINT tickets_qualifying_status_check CHECK (qualifying_status IN ('pending', 'qualifying', 'qualified', 'disqualified'));

COMMENT ON COLUMN public.tickets.platform_fee_kobo IS 'This ticket row''s share of its order''s buyer_fee_kobo (organizer_transactions.metadata), allocated by allocate_ticket_platform_fees() via largest-remainder apportionment on amount. NULL for historical tickets (never backfilled) and for tickets never paid.';
COMMENT ON COLUMN public.tickets.qualifying_status IS 'Derived recruiter-commission eligibility state (Phase 4 cron sets this). pending: not yet evaluated. qualifying: paid, inside the 30-day hold from event_date. qualified: hold elapsed, no refund/dispute. disqualified: refunded, charged back, or dispute lost.';

-- service_bookings: verified live scheduling columns are scheduled_date
-- (date) + scheduled_time (time without time zone); no completed_at exists
-- today. fee_kobo already exists (the service-booking equivalent of the
-- ticket surcharge) and needs no new column.
ALTER TABLE public.service_bookings
  ADD COLUMN completed_at timestamptz NULL,
  ADD COLUMN platform_fee_absorbed_kobo bigint NOT NULL DEFAULT 0,
  ADD COLUMN qualifying_status text NOT NULL DEFAULT 'pending';

ALTER TABLE public.service_bookings
  ADD CONSTRAINT service_bookings_platform_fee_absorbed_kobo_nonneg CHECK (platform_fee_absorbed_kobo >= 0),
  ADD CONSTRAINT service_bookings_qualifying_status_check CHECK (qualifying_status IN ('pending', 'qualifying', 'qualified', 'disqualified'));

COMMENT ON COLUMN public.service_bookings.completed_at IS 'Set by complete_service_booking() (not modified by this migration). Phase 4''s cron will use this as the primary 30-day-hold anchor, falling back to scheduled_date/scheduled_time + grace period for bookings never marked complete -- fallback formula designed in Phase 4, not here.';

-- ============================================================
-- 2. Append-only platform-fee reversal ledger
-- ============================================================

CREATE TABLE public.platform_fee_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('ticket', 'service_booking')),
  source_id uuid NOT NULL,
  reversal_type text NOT NULL CHECK (reversal_type IN ('refund', 'chargeback', 'dispute_loss', 'other')),
  amount_kobo bigint NOT NULL CHECK (amount_kobo >= 0),
  reference_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL REFERENCES auth.users(id),
  notes text NULL
);

COMMENT ON TABLE public.platform_fee_reversals IS 'Append-only ledger of platform-fee reversals (refunds, chargebacks, lost disputes). No UPDATE/DELETE policy exists for anyone -- corrections are new rows, never edits, mirroring organizer_transactions'' append-only shape. Populated starting Phase 2; this migration only creates the table.';

CREATE INDEX platform_fee_reversals_source_idx ON public.platform_fee_reversals (source_type, source_id);

-- Idempotency guard mirroring user_wallet_transactions' partial unique
-- index on (type='refund', reference_id): a retried webhook/finalize call
-- for the same reference_id and reversal_type on the same source can never
-- insert a duplicate reversal row.
CREATE UNIQUE INDEX platform_fee_reversals_dedupe_idx
  ON public.platform_fee_reversals (source_type, source_id, reversal_type, reference_id)
  WHERE reference_id IS NOT NULL;

REVOKE ALL ON public.platform_fee_reversals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.platform_fee_reversals TO project_admin;

ALTER TABLE public.platform_fee_reversals ENABLE ROW LEVEL SECURITY;

-- Append-only, admin/service-role shape: owners can read their own
-- reversals (via the same join patterns organizer_transactions/
-- service_bookings already use for ownership), only is_admin() can write,
-- and there is deliberately NO update/delete policy for anyone.
CREATE POLICY platform_fee_reversals_admin_write ON public.platform_fee_reversals
  FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY platform_fee_reversals_admin_select ON public.platform_fee_reversals
  FOR SELECT USING (public.is_admin());

CREATE POLICY platform_fee_reversals_select_own_ticket ON public.platform_fee_reversals
  FOR SELECT USING (
    source_type = 'ticket' AND EXISTS (
      SELECT 1 FROM public.tickets t
      JOIN public.events e ON e.id = t.event_id
      WHERE t.id = platform_fee_reversals.source_id AND e.organizer_id = auth.uid()
    )
  );

CREATE POLICY platform_fee_reversals_select_own_booking ON public.platform_fee_reversals
  FOR SELECT USING (
    source_type = 'service_booking' AND EXISTS (
      SELECT 1 FROM public.service_bookings sb
      JOIN public.service_providers sp ON sp.id = sb.provider_id
      WHERE sb.id = platform_fee_reversals.source_id AND sp.user_id = auth.uid()
    )
  );

-- ============================================================
-- 3. Payment disputes / chargebacks
-- ============================================================

CREATE TABLE public.payment_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('ticket', 'service_booking')),
  source_id uuid NOT NULL,
  payment_ref text NULL,
  paystack_dispute_id text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'merchant_won', 'merchant_lost', 'resolved_other')),
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NULL,
  CONSTRAINT payment_disputes_paystack_dispute_id_uniq UNIQUE (paystack_dispute_id)
);

COMMENT ON TABLE public.payment_disputes IS 'Paystack dispute/chargeback records. Populated starting Phase 3 (authenticated webhook handling for charge.dispute.* events); this migration only creates the table.';

CREATE INDEX payment_disputes_source_idx ON public.payment_disputes (source_type, source_id);

REVOKE ALL ON public.payment_disputes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.payment_disputes TO project_admin;

ALTER TABLE public.payment_disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_disputes_admin_all ON public.payment_disputes
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY payment_disputes_select_own_ticket ON public.payment_disputes
  FOR SELECT USING (
    source_type = 'ticket' AND EXISTS (
      SELECT 1 FROM public.tickets t
      JOIN public.events e ON e.id = t.event_id
      WHERE t.id = payment_disputes.source_id AND e.organizer_id = auth.uid()
    )
  );

CREATE POLICY payment_disputes_select_own_booking ON public.payment_disputes
  FOR SELECT USING (
    source_type = 'service_booking' AND EXISTS (
      SELECT 1 FROM public.service_bookings sb
      JOIN public.service_providers sp ON sp.id = sb.provider_id
      WHERE sb.id = payment_disputes.source_id AND sp.user_id = auth.uid()
    )
  );

-- ============================================================
-- 4. Allocation function (largest-remainder apportionment)
-- ============================================================

CREATE OR REPLACE FUNCTION public.allocate_ticket_platform_fees(p_payment_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_total_amount    numeric;
  v_buyer_fee_kobo  bigint;
  v_remainder       bigint;
BEGIN
  IF p_payment_ref IS NULL THEN
    RETURN;
  END IF;

  -- Lock the order's ticket rows first, same convention confirm_ticket_payment uses.
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_payment_ref FOR UPDATE;

  -- Already allocated (every paid row already has a non-null value) -- no-op.
  IF NOT EXISTS (
    SELECT 1 FROM public.tickets
    WHERE payment_ref = p_payment_ref AND payment_status = 'paid' AND platform_fee_kobo IS NULL
  ) THEN
    RETURN;
  END IF;

  SELECT sum(t.amount) INTO v_total_amount
  FROM public.tickets t
  WHERE t.payment_ref = p_payment_ref AND t.payment_status = 'paid';

  -- The authoritative order-level fee: read back from the wallet-credit
  -- row's metadata written by confirm_ticket_payment via credit_organizer_wallet.
  -- Never recomputed here -- only split.
  SELECT (ot.metadata->>'buyer_fee_kobo')::bigint INTO v_buyer_fee_kobo
  FROM public.organizer_transactions ot
  WHERE ot.metadata->>'paystack_reference' = p_payment_ref
  ORDER BY ot.created_at DESC
  LIMIT 1;

  IF v_buyer_fee_kobo IS NULL OR v_total_amount IS NULL OR v_total_amount <= 0 THEN
    -- Free order, wallet-only payment with no organizer_transactions row
    -- yet, or no recorded fee: every paid row's share is 0. Still mark
    -- them non-NULL so the row is treated as allocated (idempotent).
    UPDATE public.tickets
       SET platform_fee_kobo = 0
     WHERE payment_ref = p_payment_ref AND payment_status = 'paid' AND platform_fee_kobo IS NULL;
    RETURN;
  END IF;

  -- Largest-remainder apportionment: base floor share per row, then
  -- distribute the leftover kobo to the rows with the largest fractional
  -- remainder (ties broken by id for determinism).
  WITH weighted AS (
    SELECT
      t.id,
      t.amount,
      (v_buyer_fee_kobo * t.amount / v_total_amount) AS raw_share,
      floor(v_buyer_fee_kobo * t.amount / v_total_amount)::bigint AS floor_share
    FROM public.tickets t
    WHERE t.payment_ref = p_payment_ref AND t.payment_status = 'paid' AND t.platform_fee_kobo IS NULL
  ),
  ranked AS (
    SELECT
      id,
      floor_share,
      row_number() OVER (ORDER BY (raw_share - floor_share) DESC, id ASC) AS rn
    FROM weighted
  )
  SELECT v_buyer_fee_kobo - coalesce(sum(floor_share), 0) INTO v_remainder FROM weighted;

  UPDATE public.tickets t
     SET platform_fee_kobo = r.floor_share + CASE WHEN r.rn <= v_remainder THEN 1 ELSE 0 END
    FROM ranked r
   WHERE t.id = r.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.allocate_ticket_platform_fees(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.allocate_ticket_platform_fees(text) TO project_admin;

-- ============================================================
-- 5. Wire allocation into confirm_ticket_payment (atomic, idempotent)
-- ============================================================
-- Identical to the live body (confirmed via pg_get_functiondef immediately
-- before drafting this migration) except for one addition: a call to
-- allocate_ticket_platform_fees(p_reference) placed right after the
-- organizer wallet credit (so the order-level buyer_fee_kobo already
-- exists in organizer_transactions.metadata when the allocator reads it)
-- and before notifications/VC rewards. No other line changed: same
-- not_found/already_paid short-circuits, same amount-mismatch check, same
-- promo code, VC reward, and notification logic.

CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
  v_payer_id        uuid;
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
  v_prior_paid_count integer;
BEGIN
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, t.payer_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_payer_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, t.payer_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    -- Already paid (webhook retry). Still make sure allocation ran --
    -- allocate_ticket_platform_fees is itself a no-op once every paid row
    -- already has platform_fee_kobo set, so this is safe to call every
    -- time and closes the gap for any row paid before this migration's
    -- allocator call existed.
    PERFORM public.allocate_ticket_platform_fees(p_reference);
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
  IF p_amount_kobo < v_expected_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  SELECT count(*) INTO v_prior_paid_count FROM public.tickets WHERE user_id = v_user_id AND payment_status = 'paid';

  UPDATE public.tickets
     SET payment_status = 'paid', payment_method = 'paystack'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;

    SELECT holder_name, holder_email, holder_phone
      INTO v_holder_name, v_holder_email, v_holder_phone
      FROM public.tickets WHERE id = v_first_ticket_id;

    v_metadata := jsonb_build_object(
      'event_title', v_event_title,
      'ticket_type', v_ticket_type,
      'quantity', v_ticket_count,
      'gross_kobo', v_credit_kobo,
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

  -- New: allocate this order's buyer_fee_kobo across its ticket rows, now
  -- that the authoritative value is in organizer_transactions.metadata
  -- (or, for free orders / orders with no organizer_id, the allocator's
  -- own zero-fallback path handles it). Idempotent: a webhook retry for
  -- this same payment_ref is a no-op once allocated.
  PERFORM public.allocate_ticket_platform_fees(p_reference);

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    PERFORM public.award_vc_reward(v_user_id, 'ticket_purchase', v_first_ticket_id);
    IF v_prior_paid_count = 0 THEN
      PERFORM public.award_vc_reward(v_user_id, 'first_ticket_purchase', v_first_ticket_id);
    END IF;
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
    jsonb_build_object('eventId', v_event_id, 'ticketId', v_first_ticket_id)
  );

  IF v_payer_id IS NOT NULL AND v_payer_id IS DISTINCT FROM v_user_id THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    SELECT
      v_payer_id,
      'booking',
      'Payment successful ✅',
      'Your payment for ' || COALESCE(u.full_name, u.username, 'their') || '''s ' || v_ticket_type ||
        ' ticket(s) to ' || v_event_title || ' was successful. Thanks for covering it!',
      false,
      '✅',
      jsonb_build_object('eventId', v_event_id)
    FROM public.users u WHERE u.id = v_user_id;
  END IF;

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
$function$;

REVOKE ALL ON FUNCTION public.confirm_ticket_payment(text, bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint) TO project_admin;

-- ============================================================
-- 6. Read-only reconciliation view
-- ============================================================
-- Flags two mismatch classes per payment_ref:
--   (a) incomplete: at least one paid ticket row still has platform_fee_kobo IS NULL
--       (allocation hasn't run yet, or ran before this migration existed)
--   (b) mismatched: allocation ran, but the sum of ticket-level shares
--       doesn't equal the authoritative order-level buyer_fee_kobo exactly
--       (would indicate a bug in allocate_ticket_platform_fees, since the
--       algorithm is designed to make this impossible)

CREATE VIEW public.platform_fee_reconciliation AS
SELECT
  t.payment_ref,
  count(*) AS ticket_count,
  count(*) FILTER (WHERE t.platform_fee_kobo IS NULL) AS unallocated_ticket_count,
  sum(t.platform_fee_kobo) AS allocated_total_kobo,
  ot.buyer_fee_kobo AS authoritative_buyer_fee_kobo,
  (count(*) FILTER (WHERE t.platform_fee_kobo IS NULL) > 0) AS is_incomplete,
  (
    count(*) FILTER (WHERE t.platform_fee_kobo IS NULL) = 0
    AND ot.buyer_fee_kobo IS NOT NULL
    AND coalesce(sum(t.platform_fee_kobo), 0) <> ot.buyer_fee_kobo
  ) AS is_mismatched
FROM public.tickets t
LEFT JOIN LATERAL (
  SELECT (o.metadata->>'buyer_fee_kobo')::bigint AS buyer_fee_kobo
  FROM public.organizer_transactions o
  WHERE o.metadata->>'paystack_reference' = t.payment_ref
  ORDER BY o.created_at DESC
  LIMIT 1
) ot ON true
WHERE t.payment_ref IS NOT NULL AND t.payment_status = 'paid'
GROUP BY t.payment_ref, ot.buyer_fee_kobo;

COMMENT ON VIEW public.platform_fee_reconciliation IS 'Read-only. Per payment_ref: flags is_incomplete (a paid ticket row still has platform_fee_kobo IS NULL) or is_mismatched (allocated sum != the authoritative organizer_transactions.metadata buyer_fee_kobo). Should always be empty in steady state; a non-empty is_mismatched row is a bug report on allocate_ticket_platform_fees, never expected by design.';

REVOKE ALL ON public.platform_fee_reconciliation FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.platform_fee_reconciliation TO project_admin;
