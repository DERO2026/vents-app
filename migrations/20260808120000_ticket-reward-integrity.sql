-- ============================================================================
-- VENTS Cents Batch C -- Ticket Reward Integrity
-- ============================================================================
-- Audit finding: the 50 VC ticket-purchase reward is credited per
-- purchase/payment-confirmation CALL rather than per qualifying
-- purchase/order.
--
-- Investigation (traced through migration history, latest-dated version of
-- each function wins):
--   * purchase_ticket() (latest: 20260803140000) no longer credits VC at
--     all -- it only ever inserts `tickets` rows (one row per attendee,
--     since 20260712100000's multi-attendee change) tagged with a shared
--     `payment_ref`, in `pending`/`paid` status depending on price.
--   * The VC credit lives solely in confirm_ticket_payment() (latest:
--     20260807120000, the Paystack webhook's RPC target -- REVOKEd from
--     PUBLIC/anon/authenticated, GRANTed only to project_admin, i.e. it is
--     already not directly callable by an unprivileged client). It groups
--     every `tickets` row sharing one `payment_ref` into a single unit
--     (`GROUP BY t.user_id, e.organizer_id, e.id`), derives one
--     deterministic `v_first_ticket_id := min(t.id)` for that group, and
--     uses that as `vc_transactions.reference_id` for the reward row.
--   * The authoritative "one qualifying purchase/order" identity in this
--     schema is therefore `payment_ref`, not an individual ticket id and
--     not a bare "payment confirmation call":
--       - `public.pending_purchases.payment_ref` is UNIQUE and is minted
--         once, server-side, by create_pending_purchase() before Paystack
--         ever opens -- it is the row that represents one checkout intent
--         for one amount.
--       - Every ticket row purchase_ticket()/finalize_pending_purchase()
--         creates for that one checkout (one row per attendee) shares that
--         same payment_ref.
--       - confirm_ticket_payment() already treats "every row sharing a
--         payment_ref" as one unit for the amount check and the organizer
--         wallet credit -- the VC reward should be, and was clearly
--         *intended* to be, dedup'd on that exact same unit
--         (`v_first_ticket_id`, deterministic per payment_ref group).
--     Ticket id is the wrong unit (one order = many ticket rows since the
--     multi-attendee change); (user_id, event_id) is too coarse (would
--     wrongly collapse two genuinely separate purchases of the same event
--     by the same user into one reward).
--
--   * The actual, concrete, exploitable gap: the VC insert has used
--     `ON CONFLICT DO NOTHING` since it was first introduced
--     (20260622001538) with NO unique/exclusion constraint anywhere on
--     `vc_transactions` backing it. `INSERT ... ON CONFLICT DO NOTHING`
--     with no matching arbiter constraint protects nothing -- it is a
--     no-op safety net that has never actually fired. The only real
--     protection has been the upstream, application-level
--     `IF v_paid_count = v_ticket_count THEN RETURN 'already_paid'` guard,
--     which depends on every ticket row in the payment_ref group still
--     being in `payment_status = 'paid'`.
--     That derived state is not permanent: refund_ticket() (20260712130000
--     onward) operates on ONE ticket row at a time, not the whole
--     payment_ref group -- a partial refund of a multi-attendee order
--     flips that one row back out of 'paid', which drops
--     `paid_count < ticket_count` for a group whose 50 VC reward was
--     already granted. Paystack retries webhook delivery for a given
--     reference for hours; a retried/duplicate confirm_ticket_payment
--     call arriving after that partial refund no longer short-circuits on
--     `already_paid`, re-enters the reward block, and -- because the
--     ON CONFLICT clause has never had anything to conflict on -- inserts
--     a second, fully redundant 50 VC row for the exact same order/payment
--     reference. The same gap would fire for any other future path that
--     ever calls confirm_ticket_payment twice for one payment_ref outside
--     the narrow "still fully paid" window the existing guard checks.
--
-- Fix (minimal, additive, follows this repo's own established convention
-- for this exact class of bug -- see 20260710174119's
-- vc_transactions_referral_dedup_idx / 20260807120000's
-- vc_transactions_qualifying_ticket_idx): back the existing
-- ON CONFLICT DO NOTHING with a real partial unique index on
-- (user_id, reference_id) for `type = 'earn'` rows, so the database itself
-- -- not the application's derived payment-status bookkeeping -- guarantees
-- at most one ticket-purchase reward per (user, qualifying order). Safe
-- against every other existing `type = 'earn'` writer: _vc_deduct uses
-- type='spend' (unaffected); admin_credit_vents_cents inserts
-- type='earn' but always with a freshly generated `gen_random_uuid()`
-- reference_id, which can never collide with a real ticket id or with
-- itself, so admin credits are unaffected.
--
-- No changes to: the 50 VC amount, referral rewards/qualification/cap,
-- cash-out rate/minimum, Feature Me price, badges, profile completion,
-- email/signup, Admin Console, or any refund amount/eligibility logic.
-- ============================================================================

-- ── Schema (additive): the real dedup key the ON CONFLICT clause has been
--    missing since this reward was introduced ---------------------------
CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_ticket_reward_dedup_idx
  ON public.vc_transactions (user_id, reference_id)
  WHERE type = 'earn' AND reference_id IS NOT NULL;

-- ── confirm_ticket_payment: identical to the 20260807120000 version
--    except the VC insert now targets the new unique index instead of a
--    bare, unbacked ON CONFLICT DO NOTHING. Every other line (overpayment
--    tolerance, organizer credit, promo redemption, qualify_referral hook,
--    notifications) is untouched. -----------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
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
BEGIN
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
  IF p_amount_kobo < v_expected_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;
    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id
    );
  END IF;

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    -- Fix (Batch C): reference_id is v_first_ticket_id -- deterministic
    -- per payment_ref group (the qualifying order), not per ticket row and
    -- not per call. The unique index above is the real arbiter for this
    -- ON CONFLICT, so a second insert attempt for the same
    -- (user_id, reference_id) -- whether from a retried webhook, a
    -- concurrent duplicate call, or a re-confirmation after a partial
    -- refund reopened the "not fully paid" gate above -- is a guaranteed,
    -- database-enforced no-op instead of relying solely on the
    -- already_paid short-circuit.
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT (user_id, reference_id) WHERE type = 'earn' DO NOTHING;

    -- Fix 1 (Batch B): this is the "genuine qualifying purchase" moment -- a
    -- real, non-zero-value ticket whose payment Paystack has actually
    -- confirmed. No-ops instantly (returns changed:false) for the vast
    -- majority of purchases, which have no pending referral at all.
    PERFORM public.qualify_referral(v_user_id, v_first_ticket_id);
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
    jsonb_build_object('eventId', v_event_id)
  );

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

REVOKE EXECUTE ON FUNCTION public.confirm_ticket_payment(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment(text, bigint) TO project_admin;
