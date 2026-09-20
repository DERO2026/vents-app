-- ============================================================================
-- Referral economy integrity -- VENTS Cents Batch B.
--
-- Implements the 5 recommendations from the read-only VC-economy audit that
-- concern the referral system only. Purely additive: new columns (IF NOT
-- EXISTS), new functions (CREATE OR REPLACE), corrected function bodies,
-- and grant changes. Nothing here changes any reward amount, the 14-day
-- referrer pending period, the cash-out rate, or any other pricing --
-- see CRITICAL SCOPE RULES in the task this migration implements.
--
-- Fix 1 -- Referral qualification. Previously complete_referral() inserted
--   the referred user's 150 VC as `active` immediately, i.e. instantly
--   cashable, on nothing more than "entered a referral code". Now it is
--   inserted `pending` and only flips to `active` when qualify_referral()
--   is invoked -- which happens automatically, server-side, from
--   confirm_ticket_payment() the moment the referred user's FIRST real,
--   non-zero-value, Paystack-confirmed ticket purchase clears. A $0 ticket
--   never reaches confirm_ticket_payment (it is marked 'paid' directly
--   inside purchase_ticket() with nothing to actually confirm), so it does
--   NOT qualify a referral -- deliberately, since a free-ticket event is
--   trivially farmable and carries no genuine signal.
--
-- Fix 2 -- Server-enforced 5-referral cap. MAX_REFERRALS = 5 existed only
--   as a ReferralScreen.tsx frontend constant. complete_referral() now
--   takes a per-referrer pg_advisory_xact_lock before counting the
--   referrer's `joined` referrals, so the count-then-insert is atomic
--   across concurrent/duplicate calls -- a 6th successful join for the
--   same referrer is rejected, and the lock (not merely the count) is
--   what makes this race-safe: two callers hitting this function for the
--   same referrer at the same instant serialize on the lock, so the
--   second one always sees the first one's already-counted row.
--
-- Fix 3 -- Anti-farming, using only data already in this schema. The
--   self-referral check is preserved unchanged. This codebase already
--   ships a separate anti-fraud layer for the INVITE side of referrals
--   (create_referral() in 20260620174257_add-age-gate-and-referral-
--   antifr.sql: a 20-referral hard cap, a 3-per-24h velocity cap, and a
--   global referred_emails dedup table keyed by a client-computed email
--   hash). That layer guards *invite creation*, not *code redemption*
--   (complete_referral) -- the actual point money moves -- which is the
--   real gap. This batch closes most of it structurally: Fix 1 means no
--   redemption pays out anything without a genuine paid purchase, and
--   Fix 2's join cap bounds any one referrer's exposure to 5 payouts,
--   removing the incentive to spin up more than 5 throwaway accounts
--   against a single code. On top of that, this migration adds one
--   concrete, honest check using data already captured here: a
--   per-referrer velocity cap on REDEMPTIONS, no more than 3 successful
--   complete_referral() joins per referrer per rolling 24h, mirroring
--   create_referral's existing invite-side velocity cap but applied to
--   the redemption path that previously had none.
--
--   What was deliberately NOT added, and why: a stronger check (device-
--   fingerprint correlation across referred accounts, or IP/session
--   velocity across DIFFERENT referrers pointing at the same underlying
--   signup source) is not honestly implementable from what this schema
--   already captures. device_fingerprints rows are written only when an
--   invite is CREATED (create_referral), never linked to the account
--   that later actually redeems a code via complete_referral, and no IP
--   or session identifier is captured anywhere reachable from this RPC's
--   context (SECURITY DEFINER Postgres functions have no access to the
--   HTTP request). Doing this properly would need: (a) complete_referral
--   to accept and store a client-computed fingerprint correlated to the
--   *redeeming* account, the way create_referral already does for the
--   inviter, and (b) either IP capture at the edge (a Vercel function
--   fronting the RPC, since Postgres itself never sees the client IP for
--   a PostgREST/Supabase-JS call) or a session/device id column on
--   `users` populated at signup. Both are new infrastructure this task
--   is explicitly scoped not to invent, so this is documented here
--   rather than faked with a hollow check.
--
-- Fix 4 -- Refund/cancellation now actually works for referral rows.
--   check_and_clear_pending_vc() compared vc_transactions.reference_id
--   (which for referral rows holds the COUNTERPART USER's id -- referred
--   row -> referrer_id, referrer row -> referred_id) against tickets.id.
--   Those are two different id spaces; that branch could never match and
--   was dead code. Referral rows now carry their own, correct pointer --
--   the new qualifying_ticket_id column, set by qualify_referral() to the
--   actual ticket that qualified the referral -- and the corrected sweep
--   (_sweep_referral_vc, used by both check_and_clear_pending_vc and the
--   new deterministic cron path) joins on THAT column, so a genuine
--   refund of the qualifying ticket (finalize_ticket_refund flips
--   tickets.payment_status to 'refunded') now correctly cancels both the
--   referred user's 150 VC and the referrer's linked 300 VC, reversing
--   the wallet balance for whichever of those had already gone active.
--
-- Fix 5 -- Deterministic pending-reward activation. The 14-day promotion
--   previously only ran when the referrer happened to call
--   check_and_clear_pending_vc() client-side (ReferralScreen.tsx mount).
--   A referrer who never reopens that screen would never see their VC
--   promoted. This project already runs one Vercel Cron
--   (`/api/cron/run`, daily -- see vercel.json; the Hobby plan's
--   12-function cap is why this project consolidates crons into that one
--   endpoint rather than adding new ones, per api/cron/run.ts's own
--   comment) via a direct project_admin Postgres connection
--   (api/_lib/projectAdminDb.ts). This migration adds
--   run_referral_pending_sweep(), a project_admin-only, no-argument,
--   set-based function that runs the SAME corrected sweep logic across
--   EVERY user in one call, and api/cron/run.ts is extended to invoke it
--   every day alongside the existing reminder/archive sweeps -- no new
--   serverless function, no new cron entry, reusing the exact pattern the
--   audit pointed at. This makes activation deterministic: it now runs
--   once a day for every referrer regardless of whether they ever open
--   the app. The only operational step still required is that this
--   migration itself be applied (deliberately NOT done from this task --
--   see scope rules) and a Vercel deploy of the updated api/cron/run.ts;
--   CRON_SECRET and PROJECT_ADMIN_DATABASE_URL already exist and need no
--   new configuration.
--
--   A second, previously-unnoticed bug is fixed as part of this: the ONLY
--   thing that ever synced vc_transactions into vents_wallets.balance
--   (trg_vc_wallet_sync, 20260622201858_vc-wallet-sync.sql) fires
--   `AFTER INSERT` only. check_and_clear_pending_vc's pending -> active
--   UPDATE therefore never actually credited the wallet -- a referrer's
--   300 VC could sit "active" in vc_transactions while their spendable
--   vents_wallets.balance (what cash-out and ticket VC-redemption both
--   read) never moved. The corrected sweep credits vents_wallets.balance
--   explicitly, in the same statement that flips status, closing this gap
--   for both the referrer's 14-day promotion and Fix 1's qualification
--   flip.
-- ============================================================================

-- ── Schema (additive) ───────────────────────────────────────────────────
-- Which side of a referral pair this vc_transactions row represents.
-- NULL for every pre-existing, non-referral row (CHECK allows NULL).
ALTER TABLE public.vc_transactions
  ADD COLUMN IF NOT EXISTS referral_role text
    CHECK (referral_role IN ('referred', 'referrer'));

-- The actual ticket whose confirmed payment qualified this referral VC --
-- the correct pointer Fix 4 needed. Independent of `reference_id`, which
-- keeps its existing meaning (the counterpart user's id) so nothing that
-- already reads reference_id for referral rows breaks.
ALTER TABLE public.vc_transactions
  ADD COLUMN IF NOT EXISTS qualifying_ticket_id uuid REFERENCES public.tickets(id);

-- Links a referrals row to the actual account that redeemed the code
-- (previously only invitee_email was stored, which is an unverified,
-- pre-signup string -- not something qualify_referral can join against).
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS referred_id uuid REFERENCES public.users(id);

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS qualified_at timestamptz;

CREATE INDEX IF NOT EXISTS referrals_referred_id_idx ON public.referrals (referred_id);

-- Fast lookup for the cap/velocity checks below.
CREATE INDEX IF NOT EXISTS referrals_referrer_status_created_idx
  ON public.referrals (referrer_id, status, created_at);

-- Fast lookup for the sweep's "is this referral qualified" join and for
-- qualify_referral's own lookups.
CREATE INDEX IF NOT EXISTS vc_transactions_qualifying_ticket_idx
  ON public.vc_transactions (qualifying_ticket_id) WHERE qualifying_ticket_id IS NOT NULL;

-- ── complete_referral: qualification-aware, cap-enforced, still race-safe ──
CREATE OR REPLACE FUNCTION public.complete_referral(p_referrer_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referred_id uuid := auth.uid();
  v_referrer_id uuid;
  v_new_row_id  uuid;
  v_joined_count integer;
  v_recent_count integer;
BEGIN
  IF v_referred_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT id INTO v_referrer_id
  FROM public.users
  WHERE upper(substr(id::text, 1, 8)) = upper(p_referrer_code)
  LIMIT 1;

  IF v_referrer_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid referral code');
  END IF;

  IF v_referrer_id = v_referred_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot use your own code');
  END IF;

  -- Fix 2: serialize every complete_referral() call for this referrer.
  -- Concurrent/duplicate calls for the SAME referrer now queue on this
  -- lock instead of racing the count below -- the count a later caller
  -- sees always includes every earlier caller's already-committed insert,
  -- so "5 joined already" can never be under-counted by concurrency.
  PERFORM pg_advisory_xact_lock(hashtextextended('complete_referral:' || v_referrer_id::text, 0));

  SELECT count(*) INTO v_joined_count
  FROM public.referrals
  WHERE referrer_id = v_referrer_id AND status = 'joined';

  IF v_joined_count >= 5 THEN
    RETURN jsonb_build_object('success', false, 'message', 'This referral code has reached its maximum number of uses');
  END IF;

  -- Fix 3 (velocity guard): mirrors create_referral()'s existing 3-per-24h
  -- invite-side cap, applied here to REDEMPTIONS of this referrer's code.
  SELECT count(*) INTO v_recent_count
  FROM public.referrals
  WHERE referrer_id = v_referrer_id
    AND status = 'joined'
    AND created_at > now() - INTERVAL '24 hours';

  IF v_recent_count >= 3 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Too many referrals completed for this code recently, please try again later');
  END IF;

  -- Fix 1: 150 VC to the new user, PENDING until they complete a real,
  -- non-zero, Paystack-confirmed ticket purchase (see qualify_referral(),
  -- invoked from confirm_ticket_payment()). This INSERT remains the real
  -- idempotency gate against double-credit (unchanged from the
  -- 2026-07-10 race fix): vc_transactions_referral_dedup_idx makes a
  -- second concurrent/duplicate call for the same (referred, referrer)
  -- pair conflict here and insert nothing.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, referral_role, earned_at)
  VALUES (v_referred_id, 150, 'referral', 'pending', v_referrer_id, 'referred', now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING
  RETURNING id INTO v_new_row_id;

  IF v_new_row_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Referral already applied');
  END IF;

  -- 300 VC to referrer, pending the existing 14-day hold (unchanged
  -- timing/amount) AND, per Fix 4, now traceable to whichever ticket ends
  -- up qualifying this referral, once qualify_referral() stamps it.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, referral_role, earned_at)
  VALUES (v_referrer_id, 300, 'referral', 'pending', v_referred_id, 'referrer', now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING;

  INSERT INTO public.referrals (referrer_id, invitee_email, status, referred_id)
  VALUES (
    v_referrer_id,
    (SELECT email FROM auth.users WHERE id = v_referred_id LIMIT 1),
    'joined',
    v_referred_id
  )
  ON CONFLICT DO NOTHING;

  -- Backfill referred_id in case this referrer/invitee_email pair already
  -- existed as a 'pending' invite row from create_referral() and the
  -- ON CONFLICT above matched that instead of inserting a fresh row.
  UPDATE public.referrals
  SET referred_id = v_referred_id, status = 'joined'
  WHERE referrer_id = v_referrer_id
    AND referred_id IS NULL
    AND invitee_email = (SELECT email FROM auth.users WHERE id = v_referred_id LIMIT 1);

  RETURN jsonb_build_object(
    'success', true,
    'awarded_to_you', 150,
    'awarded_to_you_status', 'pending',
    'message', 'Your 150 VC will unlock once you complete your first ticket purchase',
    'referrer_pending', 300
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_referral(text) TO authenticated;

-- ── qualify_referral: flips the referred user's pending VC to active on
--    their first genuine, paid (non-zero) ticket purchase, and stamps the
--    linked referrer row with the qualifying ticket for Fix 4 -----------
-- Idempotent and safe to call for a user with no pending referral at all
-- (returns success:false, changed:false rather than raising) -- it is
-- invoked unconditionally from confirm_ticket_payment() for every paid
-- ticket, most of which have nothing to do with a referral.
CREATE OR REPLACE FUNCTION public.qualify_referral(p_referred_user_id uuid, p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount      integer;
  v_referrer_id uuid;
  v_ticket      record;
BEGIN
  IF p_referred_user_id IS NULL OR p_ticket_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'changed', false, 'message', 'Missing arguments');
  END IF;

  -- Defense in depth: only a real, paid, non-zero-value ticket belonging
  -- to this user can qualify a referral, even though the only caller
  -- today (confirm_ticket_payment) already guarantees this.
  SELECT id, user_id, amount, payment_status INTO v_ticket
  FROM public.tickets
  WHERE id = p_ticket_id;

  IF NOT FOUND
     OR v_ticket.user_id IS DISTINCT FROM p_referred_user_id
     OR v_ticket.payment_status <> 'paid'
     OR v_ticket.amount IS NULL
     OR v_ticket.amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'changed', false, 'message', 'Ticket does not qualify');
  END IF;

  UPDATE public.vc_transactions
  SET status = 'active', qualifying_ticket_id = p_ticket_id
  WHERE user_id = p_referred_user_id
    AND type = 'referral'
    AND referral_role = 'referred'
    AND status = 'pending'
    AND qualifying_ticket_id IS NULL
  RETURNING amount, reference_id INTO v_amount, v_referrer_id;

  IF v_amount IS NULL THEN
    -- Nothing pending (never referred, or already qualified) -- idempotent no-op.
    RETURN jsonb_build_object('success', false, 'changed', false, 'message', 'No pending referral to qualify');
  END IF;

  -- trg_vc_wallet_sync only fires on INSERT, never on this UPDATE -- credit
  -- the spendable wallet balance explicitly (see Fix 5 notes above).
  INSERT INTO public.vents_wallets (user_id, balance, updated_at)
  VALUES (p_referred_user_id, v_amount, now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance = vents_wallets.balance + v_amount, updated_at = now();

  UPDATE public.referrals
  SET qualified_at = now()
  WHERE referred_id = p_referred_user_id AND qualified_at IS NULL;

  -- Stamp the referrer's linked pending row too, so Fix 4's refund sweep
  -- can find it via qualifying_ticket_id if this ticket is later refunded,
  -- even though the referrer's own status flip still waits for the
  -- unchanged 14-day hold.
  UPDATE public.vc_transactions
  SET qualifying_ticket_id = p_ticket_id
  WHERE user_id = v_referrer_id
    AND reference_id = p_referred_user_id
    AND type = 'referral'
    AND referral_role = 'referrer'
    AND status = 'pending'
    AND qualifying_ticket_id IS NULL;

  RETURN jsonb_build_object('success', true, 'changed', true, 'vc_awarded', v_amount);
END;
$$;

-- Only ever invoked from confirm_ticket_payment(), which is itself
-- project_admin-only (20260731194723_lockdown-ticket-payment-confirm-
-- refund-rpcs.sql) -- no legitimate client-side caller exists.
REVOKE EXECUTE ON FUNCTION public.qualify_referral(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qualify_referral(uuid, uuid) TO project_admin;

-- ── confirm_ticket_payment: hook Fix 1's qualification check into the
--    real "money actually received" moment -----------------------------
-- Identical to the 20260806100000 version except for the single added
-- PERFORM near the end; every other line (overpayment tolerance, VC-on-
-- purchase bonus, notifications) is untouched.
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
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT DO NOTHING;

    -- Fix 1: this is the "genuine qualifying purchase" moment -- a real,
    -- non-zero-value ticket whose payment Paystack has actually confirmed.
    -- No-ops instantly (returns changed:false) for the vast majority of
    -- purchases, which have no pending referral at all.
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

-- ── _sweep_referral_vc: the corrected activate/cancel logic, shared by
--    the client-invoked check_and_clear_pending_vc() (Fix 4's correctness
--    fix) and the new deterministic cron sweep (Fix 5) -----------------
-- p_user_id NULL => process every user with eligible rows (cron sweep);
-- otherwise scoped to exactly that user (client call for auth.uid()).
-- Idempotent: every UPDATE is already scoped to the specific prior status
-- it expects (status = 'pending' / 'active'), so re-running this for the
-- same rows a second time changes nothing and double-credits nothing.
CREATE OR REPLACE FUNCTION public._sweep_referral_vc(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row            record;
  v_activated      integer := 0;
  v_activated_vc   integer := 0;
  v_cancelled      integer := 0;
  v_cancelled_vc   integer := 0;
BEGIN
  -- ── Cancel: any referral VC (pending OR already active) whose
  --    qualifying ticket has been refunded. Fix 4's actual bug fix: the
  --    join is now on qualifying_ticket_id (a real ticket id this row was
  --    stamped with by qualify_referral), not the old, never-matching
  --    reference_id = tickets.id comparison.
  FOR v_row IN
    SELECT t.id, t.user_id, t.amount, t.status
    FROM public.vc_transactions t
    JOIN public.tickets tk ON tk.id = t.qualifying_ticket_id
    WHERE t.type = 'referral'
      AND t.status IN ('pending', 'active')
      AND tk.payment_status = 'refunded'
      AND (p_user_id IS NULL OR t.user_id = p_user_id)
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    IF v_row.status = 'active' THEN
      -- Reverse the wallet credit this row previously added.
      UPDATE public.vents_wallets
      SET balance = GREATEST(0, balance - v_row.amount), updated_at = now()
      WHERE user_id = v_row.user_id;
    END IF;

    UPDATE public.vc_transactions SET status = 'cancelled' WHERE id = v_row.id;

    v_cancelled := v_cancelled + 1;
    v_cancelled_vc := v_cancelled_vc + v_row.amount;
  END LOOP;

  -- ── Activate: referrer's pending 300 VC, 14 days elapsed, AND the
  --    linked referral was actually qualified (Fix 1) -- an unqualified
  --    referral's referrer-side VC now stays pending indefinitely rather
  --    than auto-activating on a timer alone, closing the exact "pay out
  --    regardless of whether the referred user ever did anything real"
  --    gap the audit flagged. Excludes rows whose ticket was refunded
  --    (already handled, and possibly just cancelled, above).
  FOR v_row IN
    SELECT t.id, t.user_id, t.amount
    FROM public.vc_transactions t
    JOIN public.referrals r ON r.referred_id = t.reference_id AND r.referrer_id = t.user_id
    WHERE t.type = 'referral'
      AND t.referral_role = 'referrer'
      AND t.status = 'pending'
      AND t.earned_at < now() - INTERVAL '14 days'
      AND r.qualified_at IS NOT NULL
      AND (p_user_id IS NULL OR t.user_id = p_user_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.tickets tk
        WHERE tk.id = t.qualifying_ticket_id AND tk.payment_status = 'refunded'
      )
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    UPDATE public.vc_transactions SET status = 'active' WHERE id = v_row.id;

    INSERT INTO public.vents_wallets (user_id, balance, updated_at)
    VALUES (v_row.user_id, v_row.amount, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = vents_wallets.balance + v_row.amount, updated_at = now();

    v_activated := v_activated + 1;
    v_activated_vc := v_activated_vc + v_row.amount;
  END LOOP;

  RETURN jsonb_build_object(
    'activated_rows', v_activated, 'activated_vc', v_activated_vc,
    'cancelled_rows', v_cancelled, 'cancelled_vc', v_cancelled_vc
  );
END;
$$;

-- Internal helper only -- no grants of its own (same convention as
-- _vc_deduct/_vc_restore). Reached only via check_and_clear_pending_vc
-- (authenticated, self-scoped) or run_referral_pending_sweep
-- (project_admin, unscoped).

-- ── check_and_clear_pending_vc: now delegates to the corrected sweep,
--    scoped to the calling user -----------------------------------------
CREATE OR REPLACE FUNCTION public.check_and_clear_pending_vc()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  PERFORM public._sweep_referral_vc(v_uid);
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_and_clear_pending_vc() TO authenticated;

-- ── run_referral_pending_sweep: Fix 5's deterministic mechanism. Invoked
--    daily from api/cron/run.ts (project_admin connection, same pattern
--    as archive_ended_events / run_event_reminder_sweep) so activation no
--    longer depends on the referrer ever opening ReferralScreen.tsx -----
CREATE OR REPLACE FUNCTION public.run_referral_pending_sweep()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN public._sweep_referral_vc(NULL);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.run_referral_pending_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_referral_pending_sweep() TO project_admin;
