-- P1-4 — Service-booking admin ledger (read-only foundation).
-- P1-5 — Cross-product financial aggregates (read-only foundation).
--
-- Both are READ-ONLY and additive: no existing function is modified, no
-- policy or grant is changed, nothing writes. They exist so the Admin
-- Console has a server-side surface to build against instead of
-- assembling financial figures client-side from raw table reads.
--
-- EVERY FIGURE BELOW MAPS TO A REAL STORED COLUMN. Nothing is modelled,
-- estimated, or derived from an assumed pricing rule. Where a number the
-- brief asked for is NOT reliably derivable from the schema, it is omitted
-- and the reason is recorded here rather than approximated — see the
-- platform-fee note in admin_get_financial_aggregates.

-- =====================================================================
-- P1-4: admin_list_service_bookings
--
-- Gate and shape follow admin_list_pending_payouts (0004): plpgsql,
-- SECURITY DEFINER, is_admin_or_root(), RETURNS TABLE. That gate matches
-- the existing service_bookings_admin_select policy (0054:253, is_admin()),
-- so this RPC grants no visibility a Sub-Admin does not already have on
-- the table — it just returns it joined, filtered and bounded.
--
-- All three filters are optional (NULL = no filter). Pagination is bounded
-- server-side with the same LEAST/GREATEST clamp used by
-- get_my_wallet_transactions (0065) and admin_get_user_wallet (0081).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_list_service_bookings(
  p_status      text DEFAULT NULL,
  p_provider_id uuid DEFAULT NULL,
  p_from        timestamptz DEFAULT NULL,
  p_to          timestamptz DEFAULT NULL,
  p_limit       integer DEFAULT 50,
  p_offset      integer DEFAULT 0
)
 RETURNS TABLE(
   booking_id uuid,
   status text,
   payment_status text,
   customer_id uuid,
   customer_name text,
   customer_email text,
   provider_id uuid,
   provider_business_name text,
   currency text,
   subtotal_kobo bigint,
   fee_kobo bigint,
   total_kobo bigint,
   payment_ref text,
   scheduled_date date,
   created_at timestamptz
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Admin access required'; END IF;

  RETURN QUERY
  SELECT b.id, b.status, b.payment_status,
         b.customer_id, u.full_name, u.email,
         b.provider_id, sp.business_name,
         b.currency, b.subtotal_kobo, b.fee_kobo, b.total_kobo,
         b.payment_ref, b.scheduled_date, b.created_at
  FROM public.service_bookings b
  JOIN public.users u ON u.id = b.customer_id
  JOIN public.service_providers sp ON sp.id = b.provider_id
  WHERE (p_status      IS NULL OR b.status = p_status)
    AND (p_provider_id IS NULL OR b.provider_id = p_provider_id)
    AND (p_from        IS NULL OR b.created_at >= p_from)
    AND (p_to          IS NULL OR b.created_at <  p_to)
  ORDER BY b.created_at DESC
  LIMIT v_limit OFFSET v_offset;
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_list_service_bookings(text, uuid, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_service_bookings(text, uuid, timestamptz, timestamptz, integer, integer) TO authenticated;

-- =====================================================================
-- P1-5: admin_get_financial_aggregates
--
-- One call, one row, covering every money surface that actually exists in
-- this schema. Units: every *_kobo field is kobo. tickets.amount is stored
-- in NAIRA (confirm_ticket_payment computes
-- `v_credit_kobo := floor(v_total_amount * 100)`), so it is converted here
-- — that conversion is the one piece of arithmetic in this function and it
-- mirrors the live code exactly rather than assuming a unit.
--
-- WHAT IS DELIBERATELY ABSENT: a ticket "platform fee" figure. The buyer
-- fee is applied at charge time inside confirm_ticket_payment's expected-
-- amount formula (`v_total_amount * (1.05 - discount_percentage/100)`) and
-- is NOT persisted as its own column anywhere on tickets. Reconstructing it
-- would mean re-deriving a historical 5% against per-ticket discounts and
-- any past rate changes — i.e. inventing a number and presenting it as
-- ledger truth. Service bookings DO persist fee_kobo as a real column, so
-- that fee is reported. Ticket-side fee reporting needs a schema change
-- (persist fee_kobo on tickets at confirmation time); flagged, not faked.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_get_financial_aggregates()
 RETURNS TABLE(
   -- Ticketing (tickets.amount is naira; converted to kobo here)
   ticket_gross_kobo bigint,
   ticket_paid_count bigint,
   ticket_refunded_kobo bigint,
   ticket_refunded_count bigint,
   ticket_refund_pending_count bigint,
   -- Service marketplace (all real stored kobo columns on service_bookings)
   service_gross_kobo bigint,
   service_fee_kobo bigint,
   service_paid_count bigint,
   -- Organizer money: what is owed, in flight, and already paid out
   organizer_balance_kobo bigint,
   organizer_pending_kobo bigint,
   organizer_total_earned_kobo bigint,
   organizer_total_withdrawn_kobo bigint,
   payout_requests_pending_count bigint,
   payout_requests_pending_kobo bigint,
   -- Customer wallet liability (VENTS Wallet, 0065)
   wallet_liability_kobo bigint,
   wallet_count bigint,
   -- VENTS Cents (points, NOT money — never mix into a naira total)
   vc_circulation bigint,
   vc_transaction_count bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;

  RETURN QUERY
  SELECT
    (SELECT COALESCE(sum(round(t.amount * 100)), 0) FROM public.tickets t WHERE t.payment_status = 'paid')::bigint,
    (SELECT count(*) FROM public.tickets t WHERE t.payment_status = 'paid')::bigint,
    (SELECT COALESCE(sum(round(t.amount * 100)), 0) FROM public.tickets t WHERE t.payment_status = 'refunded')::bigint,
    (SELECT count(*) FROM public.tickets t WHERE t.payment_status = 'refunded')::bigint,
    (SELECT count(*) FROM public.tickets t WHERE t.payment_status = 'refund_pending')::bigint,

    (SELECT COALESCE(sum(b.total_kobo), 0) FROM public.service_bookings b WHERE b.payment_status = 'paid')::bigint,
    (SELECT COALESCE(sum(b.fee_kobo), 0)   FROM public.service_bookings b WHERE b.payment_status = 'paid')::bigint,
    (SELECT count(*) FROM public.service_bookings b WHERE b.payment_status = 'paid')::bigint,

    (SELECT COALESCE(sum(w.balance_kobo), 0)          FROM public.organizer_wallets w)::bigint,
    (SELECT COALESCE(sum(w.pending_kobo), 0)          FROM public.organizer_wallets w)::bigint,
    (SELECT COALESCE(sum(w.total_earned_kobo), 0)     FROM public.organizer_wallets w)::bigint,
    (SELECT COALESCE(sum(w.total_withdrawn_kobo), 0)  FROM public.organizer_wallets w)::bigint,
    (SELECT count(*) FROM public.organizer_withdrawal_requests r WHERE r.status IN ('pending', 'processing'))::bigint,
    (SELECT COALESCE(sum(r.amount_kobo), 0) FROM public.organizer_withdrawal_requests r WHERE r.status IN ('pending', 'processing'))::bigint,

    (SELECT COALESCE(sum(uw.balance_kobo), 0) FROM public.user_wallets uw)::bigint,
    (SELECT count(*) FROM public.user_wallets)::bigint,

    (SELECT COALESCE(sum(vw.balance), 0) FROM public.vents_wallets vw)::bigint,
    (SELECT count(*) FROM public.vc_transactions)::bigint;
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_get_financial_aggregates() FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_get_financial_aggregates() TO authenticated;
