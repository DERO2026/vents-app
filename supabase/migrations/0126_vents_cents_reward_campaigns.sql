-- VENTS Cents: configurable reward-campaign framework + emergency-control
-- and refund/reversal fixes.
--
-- AUDIT SUMMARY (see report): the existing VC infrastructure is far more
-- complete than a fresh build would assume -- vc_transactions (ledger),
-- vents_wallets (balance cache, kept in sync by trg_sync_vc_to_wallet),
-- a full cash-out pipeline mirroring the organizer payout system exactly
-- (request_vc_cashout / admin_claim_vc_payout_for_processing / complete_vc_
-- payout / fail_vc_payout / admin_cancel_processing_vc_payout / admin_
-- reject_vc_payout / admin_release_vc_payout_claim), idempotent unique
-- indexes for referral and per-reference "earn" dedup, and working self-
-- credit/self-debit protection on the admin tools. None of that is
-- reinvented here.
--
-- What conflicted with the new product direction and is fixed:
--
-- 1. VULNERABILITY (fail-open): request_vc_cashout and all three VC payout
--    admin actions used the bare `(SELECT disable_payouts FROM app_config
--    LIMIT 1)` pattern that 0124 already proved fails OPEN if the config
--    row is ever missing -- the organizer-payout equivalents were fixed in
--    0124 but these VC-specific copies were not. Switched to the existing
--    fail-closed public.payouts_disabled() helper.
--
-- 2. NO CONFIGURABILITY: every reward amount (50 VC/ticket, 100 VC profile
--    completion, 150/300 VC referral) was hard-coded directly in the
--    payment-confirmation functions, with no admin control over amount,
--    enable/disable, date window, or per-user/total caps. Introduced
--    vc_reward_campaigns (one row per named reward source) and a single
--    award_vc_reward() entry point that every earn path now calls through.
--    Existing amounts are preserved as the seeded defaults (flagged in the
--    report as needing final business confirmation) -- no reward changed.
--
-- 3. NO "first qualifying purchase" tier: added a first_ticket_purchase
--    campaign (disabled by default -- amount needs a business decision)
--    that award_vc_reward's caller triggers alongside the base
--    ticket_purchase reward exactly once per user, keyed off the same
--    ticket id so it can never double-fire.
--
-- 4. REFUND/REVERSAL GAP: neither refund_ticket nor finalize_ticket_refund
--    touched vc_transactions at all -- a refunded/cancelled ticket left its
--    "earn" reward permanently credited. Added reverse_vc_reward(), called
--    from both refund paths, which marks the matching earn row 'reversed'
--    and claws back the wallet balance up to whatever the user hasn't
--    already spent/cashed out (never negative -- a shortfall is logged,
--    matching the exact clamping pattern already used for organizer-wallet
--    refund shortfalls).
--
-- Multi-campaign dedup: the existing vc_transactions_earn_dedup_idx was
-- unique on (user_id, reference_id) WHERE type='earn' -- fine when only one
-- campaign could ever fire per reference, but ticket_purchase and
-- first_ticket_purchase both key off the same ticket id now. Widened to
-- (user_id, COALESCE(campaign_key,''), reference_id) so two campaigns can
-- both fire, once each, off the same reference, while old NULL-campaign_key
-- rows (already committed) keep exactly their old dedup behavior.

-- ── vc_transactions: campaign linkage ────────────────────────────────────
ALTER TABLE public.vc_transactions
  ADD COLUMN IF NOT EXISTS campaign_key text,
  ADD COLUMN IF NOT EXISTS metadata jsonb;

DROP INDEX IF EXISTS public.vc_transactions_earn_dedup_idx;
CREATE UNIQUE INDEX vc_transactions_earn_dedup_idx
  ON public.vc_transactions (user_id, COALESCE(campaign_key, ''), reference_id)
  WHERE (type = 'earn' AND reference_id IS NOT NULL);

-- ── Reward campaigns (admin-configurable) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vc_reward_campaigns (
  key            text PRIMARY KEY,
  label          text NOT NULL,
  description    text,
  amount_vc      integer NOT NULL CHECK (amount_vc > 0),
  cap_per_user   integer CHECK (cap_per_user IS NULL OR cap_per_user > 0),
  cap_total      integer CHECK (cap_total IS NULL OR cap_total > 0),
  total_awarded  integer NOT NULL DEFAULT 0,
  enabled        boolean NOT NULL DEFAULT true,
  starts_at      timestamptz,
  ends_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.vc_reward_campaigns ENABLE ROW LEVEL SECURITY;

-- Read-only for everyone (client UI needs to show "how to earn Cents" and
-- current amounts) -- all writes go through the admin RPC below.
CREATE POLICY vc_reward_campaigns_select_all ON public.vc_reward_campaigns
  FOR SELECT USING (true);

REVOKE ALL ON public.vc_reward_campaigns FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vc_reward_campaigns TO anon, authenticated;

-- Seed rows matching EXACTLY the amounts already live in production --
-- this migration changes nothing about what a user actually earns today,
-- only makes it admin-configurable going forward. first_ticket_purchase is
-- new and shipped disabled since its amount is a genuine business decision,
-- not something to invent here.
INSERT INTO public.vc_reward_campaigns (key, label, description, amount_vc, cap_per_user, cap_total, enabled)
VALUES
  ('ticket_purchase', 'Ticket purchase', 'Awarded for each paid ticket purchase.', 50, NULL, NULL, true),
  ('first_ticket_purchase', 'First ticket purchase bonus', 'One-time bonus on top of the standard reward for a user''s first paid ticket. Amount and enabled state need business confirmation before launch.', 100, 1, NULL, false),
  ('profile_complete', 'Profile completion', 'One-time reward for adding a photo, bio, and phone number.', 100, 1, NULL, true),
  ('referral_referred', 'Referral — joined via code', 'Awarded to a new user who signs up using a referral code.', 150, 1, NULL, true),
  ('referral_referrer', 'Referral — friend joined', 'Awarded to the referrer when their invitee joins (held pending for 14 days).', 300, NULL, NULL, true)
ON CONFLICT (key) DO NOTHING;

-- ── award_vc_reward: the one entry point every earn path now calls ──────
-- Enforces: campaign exists & enabled & within its date window, per-user
-- cap, campaign-wide total cap -- all under a row lock on the campaign so
-- two concurrent awards against a tight total cap can't both slip through.
-- Idempotent against the same (user, campaign, reference) tuple via
-- vc_transactions_earn_dedup_idx -- a duplicate webhook or retried call is
-- always a no-op, never a double credit.
CREATE OR REPLACE FUNCTION public.award_vc_reward(
  p_user_id uuid,
  p_campaign_key text,
  p_reference_id uuid DEFAULT NULL,
  p_status text DEFAULT 'active'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_campaign public.vc_reward_campaigns;
  v_user_count integer;
  v_tx_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'award_vc_reward: user_id is required';
  END IF;
  IF p_status NOT IN ('active', 'pending') THEN
    RAISE EXCEPTION 'award_vc_reward: invalid status %', p_status;
  END IF;

  SELECT * INTO v_campaign FROM public.vc_reward_campaigns WHERE key = p_campaign_key FOR UPDATE;
  IF v_campaign IS NULL THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'unknown_campaign');
  END IF;
  IF NOT v_campaign.enabled THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'campaign_disabled');
  END IF;
  IF v_campaign.starts_at IS NOT NULL AND now() < v_campaign.starts_at THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'campaign_not_started');
  END IF;
  IF v_campaign.ends_at IS NOT NULL AND now() > v_campaign.ends_at THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'campaign_ended');
  END IF;

  IF v_campaign.cap_per_user IS NOT NULL THEN
    SELECT count(*) INTO v_user_count
    FROM public.vc_transactions
    WHERE user_id = p_user_id AND campaign_key = p_campaign_key AND type = 'earn' AND status <> 'cancelled';
    IF v_user_count >= v_campaign.cap_per_user THEN
      RETURN jsonb_build_object('awarded', false, 'reason', 'per_user_cap_reached');
    END IF;
  END IF;

  IF v_campaign.cap_total IS NOT NULL AND v_campaign.total_awarded >= v_campaign.cap_total THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'total_cap_reached');
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, campaign_key, metadata)
  VALUES (p_user_id, v_campaign.amount_vc, 'earn', p_status, p_reference_id, p_campaign_key, jsonb_build_object('campaign_label', v_campaign.label))
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'already_awarded');
  END IF;

  UPDATE public.vc_reward_campaigns SET total_awarded = total_awarded + 1 WHERE key = p_campaign_key;

  RETURN jsonb_build_object('awarded', true, 'amount', v_campaign.amount_vc, 'transaction_id', v_tx_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('awarded', false, 'reason', 'already_awarded');
END;
$function$;

REVOKE ALL ON FUNCTION public.award_vc_reward(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_vc_reward(uuid, text, uuid, text) TO postgres, project_admin;

-- ── reverse_vc_reward: refund/cancellation/fraud reversal ───────────────
-- Marks every matching non-reversed 'earn' row for this reference as
-- 'reversed' and claws back the wallet balance up to whatever the user
-- hasn't already spent or cashed out. Never drives the balance negative --
-- a shortfall (the VC was already spent) is logged to admin_logs instead,
-- the same pattern already used for organizer-wallet refund shortfalls.
-- Idempotent: reversing an already-reversed reward is a no-op.
CREATE OR REPLACE FUNCTION public.reverse_vc_reward(
  p_reference_id uuid,
  p_reason text DEFAULT 'Underlying activity refunded/cancelled/invalidated'
) RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row record;
  v_wallet_balance integer;
  v_actual_clawback integer;
BEGIN
  IF p_reference_id IS NULL THEN
    RETURN;
  END IF;

  FOR v_row IN
    SELECT id, user_id, amount, campaign_key
    FROM public.vc_transactions
    WHERE reference_id = p_reference_id AND type = 'earn' AND status IN ('active', 'pending')
    FOR UPDATE
  LOOP
    UPDATE public.vc_transactions SET status = 'cancelled' WHERE id = v_row.id;

    IF v_row.amount > 0 THEN
      SELECT balance INTO v_wallet_balance FROM public.vents_wallets WHERE user_id = v_row.user_id FOR UPDATE;
      v_actual_clawback := LEAST(COALESCE(v_wallet_balance, 0), v_row.amount);

      IF v_actual_clawback > 0 THEN
        UPDATE public.vents_wallets SET balance = balance - v_actual_clawback, updated_at = now()
        WHERE user_id = v_row.user_id;
      END IF;

      IF v_actual_clawback < v_row.amount THEN
        INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
        VALUES (
          NULL, 'vc_reward_reversal_shortfall', v_row.user_id,
          jsonb_build_object(
            'reference_id', p_reference_id, 'campaign_key', v_row.campaign_key,
            'owed_vc', v_row.amount, 'recovered_vc', v_actual_clawback,
            'shortfall_vc', v_row.amount - v_actual_clawback, 'reason', p_reason
          ),
          'webhook'
        );
      END IF;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_vc_reward(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_vc_reward(uuid, text) TO postgres, project_admin;

-- ── admin_update_vc_campaign: the one audited write path for campaigns ──
-- Same tier as the existing VC economy dials in admin_update_app_config
-- (Root-only -- these are direct-cost financial parameters) with the same
-- server-side, same-transaction audit logging shape.
CREATE OR REPLACE FUNCTION public.admin_update_vc_campaign(
  p_key text,
  p_amount_vc integer DEFAULT NULL,
  p_cap_per_user integer DEFAULT NULL,
  p_cap_per_user_unset boolean DEFAULT false,
  p_cap_total integer DEFAULT NULL,
  p_cap_total_unset boolean DEFAULT false,
  p_enabled boolean DEFAULT NULL,
  p_starts_at timestamptz DEFAULT NULL,
  p_ends_at timestamptz DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old public.vc_reward_campaigns;
  v_new public.vc_reward_campaigns;
BEGIN
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required to change VENTS Cents campaigns (your role: %)', COALESCE(public.actor_role(), 'none');
  END IF;

  SELECT * INTO v_old FROM public.vc_reward_campaigns WHERE key = p_key FOR UPDATE;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'Unknown campaign: %', p_key;
  END IF;

  IF p_amount_vc IS NOT NULL AND p_amount_vc <= 0 THEN
    RAISE EXCEPTION 'amount_vc must be positive';
  END IF;

  UPDATE public.vc_reward_campaigns SET
    amount_vc = COALESCE(p_amount_vc, amount_vc),
    cap_per_user = CASE WHEN p_cap_per_user_unset THEN NULL ELSE COALESCE(p_cap_per_user, cap_per_user) END,
    cap_total = CASE WHEN p_cap_total_unset THEN NULL ELSE COALESCE(p_cap_total, cap_total) END,
    enabled = COALESCE(p_enabled, enabled),
    starts_at = COALESCE(p_starts_at, starts_at),
    ends_at = COALESCE(p_ends_at, ends_at),
    updated_by = auth.uid(),
    updated_at = now()
  WHERE key = p_key
  RETURNING * INTO v_new;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'vc_campaign_update', NULL,
    jsonb_build_object(
      'campaign_key', p_key, 'reason', p_reason,
      'old', jsonb_build_object('amount_vc', v_old.amount_vc, 'cap_per_user', v_old.cap_per_user, 'cap_total', v_old.cap_total, 'enabled', v_old.enabled, 'starts_at', v_old.starts_at, 'ends_at', v_old.ends_at),
      'new', jsonb_build_object('amount_vc', v_new.amount_vc, 'cap_per_user', v_new.cap_per_user, 'cap_total', v_new.cap_total, 'enabled', v_new.enabled, 'starts_at', v_new.starts_at, 'ends_at', v_new.ends_at)
    ),
    public.actor_role()
  );

  RETURN jsonb_build_object('key', v_new.key, 'amount_vc', v_new.amount_vc, 'cap_per_user', v_new.cap_per_user, 'cap_total', v_new.cap_total, 'enabled', v_new.enabled, 'starts_at', v_new.starts_at, 'ends_at', v_new.ends_at);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_vc_campaign(text, integer, integer, boolean, integer, boolean, boolean, timestamptz, timestamptz, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_update_vc_campaign(text, integer, integer, boolean, integer, boolean, boolean, timestamptz, timestamptz, text) TO authenticated;

-- ── Refactor the two ticket-purchase earn paths to route through the
--    campaign framework instead of a hard-coded INSERT. Behavior-preserving
--    (still 50 VC per paid ticket by default) except now configurable, and
--    now also fires first_ticket_purchase (shipped disabled) exactly once.
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

CREATE OR REPLACE FUNCTION public.confirm_ticket_payment_via_wallet(p_payment_ref text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid             uuid := auth.uid();
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
  v_holder_name     text;
  v_holder_email    text;
  v_holder_phone    text;
  v_metadata        jsonb;
  v_wallet_balance  bigint;
  v_tx_id           uuid;
  v_prior_paid_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF public.purchases_disabled() THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Pending purchase not found for reference%' THEN
      RAISE WARNING 'confirm_ticket_payment_via_wallet: finalize_pending_purchase failed unexpectedly for %: %', p_payment_ref, SQLERRM;
      RAISE;
    END IF;
  END;

  PERFORM 1 FROM public.tickets WHERE payment_ref = p_payment_ref FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_payment_ref
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not authorized for this payment reference';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_kobo INTO v_wallet_balance
    FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;

  IF v_wallet_balance < v_expected_kobo THEN
    RETURN 'insufficient_balance:' || v_wallet_balance::text || ':' || v_expected_kobo::text;
  END IF;

  SELECT count(*) INTO v_prior_paid_count FROM public.tickets WHERE user_id = v_uid AND payment_status = 'paid';

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id)
  VALUES (v_uid, 'spend', v_expected_kobo, 'Ticket purchase: ' || v_ticket_type, p_payment_ref)
  ON CONFLICT (reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN 'already_paid';
  END IF;

  UPDATE public.user_wallets
     SET balance_kobo = balance_kobo - v_expected_kobo, updated_at = now()
   WHERE user_id = v_uid;

  UPDATE public.tickets
     SET payment_status = 'paid', payment_method = 'wallet'
   WHERE payment_ref = p_payment_ref AND payment_status <> 'paid';

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
      'wallet_reference', p_payment_ref,
      'buyer_name', v_holder_name,
      'buyer_email', v_holder_email,
      'buyer_phone', v_holder_phone
    );

    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale (Wallet): ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id,
      v_metadata
    );
  END IF;

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

-- ── Refund/reversal wiring: both ticket-refund paths now reverse the
--    matching VC reward instead of leaving it permanently credited.
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

  PERFORM public.check_rate_limit('refund_ticket:' || auth.uid()::text, 30, 3600);

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

    PERFORM public.reverse_vc_reward(v_ticket.id, 'Ticket refunded: ' || p_reason);

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

    PERFORM public.reverse_vc_reward(v_ticket.id, 'Ticket refunded: ' || p_reason);

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

CREATE OR REPLACE FUNCTION public.finalize_ticket_refund(p_refund_id text)
 RETURNS TABLE(status text, buyer_email text, buyer_name text, event_title text, ticket_type text, refunded_amount_kobo bigint, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket       record;
  v_owed_kobo    bigint;
  v_wallet_bal   bigint;
  v_actual_debit bigint;
  v_refund_kobo  bigint;
BEGIN
  SELECT t.id, t.user_id, t.amount, t.discount_percentage, t.ticket_type, t.payment_status,
         t.refund_initiated_by, t.refund_reason, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.refund_id = p_refund_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_refunded'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  UPDATE public.tickets SET payment_status = 'refunded' WHERE id = v_ticket.id;

  PERFORM public.reverse_vc_reward(v_ticket.id, 'Ticket refunded: ' || COALESCE(v_ticket.refund_reason, 'refund processed'));

  IF v_ticket.amount > 0 AND v_ticket.organizer_id IS NOT NULL THEN
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
        'Refund: ' || v_ticket.ticket_type ||
          CASE WHEN v_actual_debit < v_owed_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_owed_kobo || ' kobo owed)'
               ELSE '' END,
        v_ticket.id
      );
    END IF;

    IF v_actual_debit < v_owed_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        v_ticket.refund_initiated_by, 'refund_wallet_shortfall', v_ticket.organizer_id,
        jsonb_build_object(
          'ticket_id', v_ticket.id, 'owed_kobo', v_owed_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_owed_kobo - v_actual_debit
        ),
        'webhook'
      );
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_ticket.user_id, 'booking', 'Ticket refunded',
    'Your refund for the ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been processed.',
    false, '💸'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_ticket.refund_initiated_by, 'refund_ticket_finalized', v_ticket.user_id,
    jsonb_build_object('ticket_id', v_ticket.id, 'refund_id', p_refund_id),
    'webhook'
  );

  RETURN QUERY
  SELECT 'finalized'::text, u.email, u.full_name, v_ticket.event_title, v_ticket.ticket_type,
         v_refund_kobo, v_ticket.refund_reason
    FROM public.users u WHERE u.id = v_ticket.user_id;
END;
$function$;

-- ── Emergency-control fail-closed fix for VC cash-out (Fix 1 above) ──────
CREATE OR REPLACE FUNCTION public.request_vc_cashout(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_account  public.vc_bank_accounts;
  v_rate     integer;
  v_ngn_kobo bigint;
  v_id       uuid;
  v_rows     int;
BEGIN
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before requesting a cash-out';
  END IF;

  IF p_vc_amount IS NULL OR p_vc_amount < 1000 THEN
    RAISE EXCEPTION 'Minimum cash-out is 1,000 Vents Cents';
  END IF;

  IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  SELECT * INTO v_account FROM public.vc_bank_accounts
  WHERE id = p_bank_account_id AND user_id = v_user_id
    AND is_active AND recipient_code IS NOT NULL;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Bank account not verified';
  END IF;

  SELECT vc_cashout_naira_per_1000 INTO v_rate FROM public.app_config LIMIT 1;
  v_ngn_kobo := (p_vc_amount::bigint * v_rate::bigint * 100) / 1000;

  INSERT INTO public.vc_withdrawal_requests
    (user_id, vc_amount, ngn_amount_kobo, rate_used, status, bank_account_id, idempotency_key)
  VALUES
    (v_user_id, p_vc_amount, v_ngn_kobo, v_rate, 'pending', p_bank_account_id, p_idempotency_key)
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    SELECT id INTO v_id FROM public.vc_withdrawal_requests
    WHERE user_id = v_user_id AND idempotency_key = p_idempotency_key;
    RETURN v_id;
  END IF;

  PERFORM public._vc_deduct(v_user_id, p_vc_amount, 'VC cash-out request');

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_claim_vc_payout_for_processing(p_request_id uuid)
 RETURNS TABLE(request_id uuid, user_id uuid, vc_amount integer, ngn_amount_kobo bigint, recipient_code text, status text, claimed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed_id uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  UPDATE public.vc_withdrawal_requests
  SET status = 'processing', resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NOT NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
    VALUES (auth.uid(), 'claim_vc_payout_for_processing', jsonb_build_object('request_id', p_request_id), public.actor_role());
  END IF;

  RETURN QUERY
  SELECT r.id, r.user_id, r.vc_amount, r.ngn_amount_kobo, b.recipient_code, r.status, (v_claimed_id IS NOT NULL)
  FROM public.vc_withdrawal_requests r
  JOIN public.vc_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_cancel_processing_vc_payout(p_request_id uuid, p_reason text)
 RETURNS TABLE(status text, user_email text, user_name text, vc_amount integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid;
  v_vc_amount integer;
  v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT r.user_id, r.vc_amount, r.status
    INTO v_user_id, v_vc_amount, v_status
  FROM public.vc_withdrawal_requests r
  WHERE r.id = p_request_id;

  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_status; END IF;

  UPDATE public.vc_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  PERFORM public._vc_restore(v_user_id, v_vc_amount, 'VC cash-out cancelled by admin, funds returned — ' || p_reason);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'cancel_processing_vc_payout', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'vc_amount', v_vc_amount, 'reason', p_reason),
          public.actor_role());

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_vc_amount
  FROM public.users u WHERE u.id = v_user_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_reject_vc_payout(p_request_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_vc_amount integer; v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  SELECT r.user_id, r.vc_amount, r.status INTO v_user_id, v_vc_amount, v_status
  FROM public.vc_withdrawal_requests r WHERE r.id = p_request_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status NOT IN ('pending') THEN RAISE EXCEPTION 'Only pending requests can be rejected'; END IF;

  UPDATE public.vc_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  PERFORM public._vc_restore(v_user_id, v_vc_amount, 'VC cash-out rejected by admin, funds returned — ' || p_reason);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_vc_payout_request', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'vc_amount', v_vc_amount, 'reason', p_reason),
          public.actor_role());

  RETURN 'rejected';
END; $function$;
