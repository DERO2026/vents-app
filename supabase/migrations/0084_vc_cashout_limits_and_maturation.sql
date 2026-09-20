-- ============================================================================
-- VENTS Cents (VC) cash-out -- BATCH D: minimum raise, withdrawal limits,
-- fresh-VC maturation hold, all layered into request_vc_cashout().
--
-- Purely additive: new app_config columns (ADD COLUMN IF NOT EXISTS) and a
-- single CREATE OR REPLACE FUNCTION public.request_vc_cashout(...) with the
-- SAME signature as 0082_vc_cashout.sql shipped (p_vc_amount integer,
-- p_bank_account_id uuid, p_idempotency_key text) -- nothing about the
-- table shapes, RLS, grants, admin RPCs, webhook dispatch, or the
-- complete_vc_payout/fail_vc_payout project_admin boundary from Batch A
-- changes. 0082_vc_cashout.sql itself is NOT edited; this migration is a
-- later, additive layer on top of it, exactly like 20260807120000 and
-- 20260808120000 layered on top of earlier VC functions without editing
-- their original migration files.
--
-- All new config is VC-denominated (vc_cashout_*_vc / vc_cashout_*_hours /
-- vc_cashout_*_minutes / vc_cashout_*_requests), never NGN/naira-named --
-- VC amounts are country-agnostic even though today's only cash-out rail
-- (Paystack, NUBAN) is Nigeria-specific. The existing
-- vc_cashout_naira_per_1000 RATE is untouched.
-- ============================================================================

-- ── 1. New app_config columns (additive) ───────────────────────────────────
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_cashout_min_vc integer NOT NULL DEFAULT 250000;
  -- 250,000 VC = ₦25,000 at the current, unchanged vc_cashout_naira_per_1000
  -- default of 100 (i.e. 1,000 VC = ₦100). This is the ONLY authoritative
  -- minimum -- enforced here, server-side, inside request_vc_cashout, not
  -- merely as a frontend constant. Kept VC-denominated rather than
  -- vc_cashout_min_naira, per the country-agnostic-config rule above.

ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_cashout_max_vc integer NOT NULL DEFAULT 500000;
  -- Maximum single withdrawal: 500,000 VC (~₦50,000 today). Conservative
  -- ceiling for an early-stage rewards economy with no track record yet of
  -- real payout volume -- caps single-request fraud/error blast radius
  -- without blocking a legitimate power user from cashing out over
  -- multiple, separately-reviewed requests.

ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_cashout_daily_max_vc integer NOT NULL DEFAULT 500000;
  -- Rolling 24h VC cap across ALL of a user's non-terminal-failed requests
  -- (pending/processing/completed), i.e. by default the same as one
  -- max-size request per day. Prevents chaining several smaller requests
  -- to exceed the effective daily ceiling.

ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_cashout_daily_max_requests integer NOT NULL DEFAULT 2;
  -- Rolling 24h REQUEST-COUNT cap (counts every request regardless of
  -- eventual status, since the thing being bounded is request volume/spam,
  -- not just successful payouts).

ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_cashout_cooldown_minutes integer NOT NULL DEFAULT 60;
  -- Minimum gap between one cash-out request and the next for the same
  -- user, regardless of the first request's outcome. Slows down rapid-fire
  -- repeat attempts (e.g. scripted retries) beyond what idempotency keys
  -- alone address (a fresh idempotency key always creates a genuinely new
  -- request, so idempotency is not itself a rate limit).

ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_cashout_maturation_hold_hours integer NOT NULL DEFAULT 72;
  -- Fresh/farmed-VC maturation hold for CASH-OUT ELIGIBILITY specifically
  -- (separate from general spendability -- see the eligibility comment on
  -- request_vc_cashout below for the full investigation and rationale).

-- ── 1b. Fix: delayed-qualification maturation bypass ───────────────────────
--
-- Independent review found a real gap in the maturation hold above: for
-- referral VC, earned_at is stamped by complete_referral() at
-- referral-code-redemption/signup time (row inserted 'pending'), NOT at
-- qualify_referral()'s later pending -> active flip (migrations/
-- 20260807120000_referral-economy-integrity.sql). If a referred user
-- signs up, waits more than vc_cashout_maturation_hold_hours, THEN makes
-- their qualifying purchase, their 150 VC becomes active/spendable at
-- that moment but earned_at is already stale, so the SELECT above sees
-- earned_at outside the hold window and treats it as fully matured --
-- zero effective hold on exactly the "signup -> wait -> cash out"
-- scenario this migration exists to close. Same-day qualifiers are
-- correctly held; delayed qualifiers are not.
--
-- Fix chosen: add a new, narrow `activated_at` timestamp column on
-- vc_transactions, set ONLY by qualify_referral() (SECURITY DEFINER,
-- already project_admin-only -- no client can invoke or influence it) at
-- the exact moment a referral row flips pending -> active, and have the
-- maturation formula key off COALESCE(activated_at, earned_at): rows
-- where it is set (referral rows that have been qualified) measure time
-- since activation; rows where it stays NULL (ticket-purchase 'earn'
-- rows, and any referral row not yet qualified) keep measuring time
-- since earned_at exactly as before -- earned_at IS the activation
-- moment for confirm_ticket_payment()'s 'earn' rows already, so that path
-- is completely unchanged.
--
-- Alternative considered and rejected: overwriting earned_at itself
-- inside qualify_referral()'s UPDATE instead of adding a column. Checked
-- for other readers of earned_at before deciding (grep across src/ and
-- api/): ReferralScreen.tsx reads and displays vc_transactions.earned_at
-- directly to the user as the "date earned" in their VC activity history
-- (`.order('earned_at', ...)` + `new Date(a.earned_at).toLocaleDateString(...)`
-- at src/app/components/ReferralScreen.tsx). That UI reader assumes
-- earned_at means "when this VC was originally earned" (i.e. when the
-- referral was redeemed), not "when it became active" -- silently
-- redefining the column to mean activation time would change what date
-- referred users see next to their 150 VC line item and would reorder
-- their activity feed, a real, unrelated behavior change outside this
-- fix's scope. A new, additive column has no such side effect and keeps
-- earned_at's existing meaning intact for every existing reader.
ALTER TABLE public.vc_transactions
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- CREATE OR REPLACE layer on qualify_referral() (originally defined in
-- migrations/20260807120000_referral-economy-integrity.sql) -- identical
-- to that version except for the single added `activated_at = now()` in
-- the referred-user UPDATE below. That migration is already shipped/
-- applied, so per this codebase's own additive-layering convention (see
-- this file's own header, and how 20260807120000/20260808120000 layer on
-- earlier VC functions without editing their original files) it is
-- layered here via CREATE OR REPLACE rather than edited in place.
--
-- Idempotency preserved: the added assignment lives inside the exact same
-- guarded UPDATE (`WHERE ... AND status = 'pending' AND
-- qualifying_ticket_id IS NULL`) that already made a second/duplicate
-- call a no-op -- a replayed call still matches zero rows (v_amount IS
-- NULL) and returns changed:false without touching activated_at again.
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
  SET status = 'active', qualifying_ticket_id = p_ticket_id, activated_at = now()
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
  -- the spendable wallet balance explicitly (see Fix 5 notes in
  -- 20260807120000_referral-economy-integrity.sql).
  INSERT INTO public.vents_wallets (user_id, balance, updated_at)
  VALUES (p_referred_user_id, v_amount, now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance = vents_wallets.balance + v_amount, updated_at = now();

  UPDATE public.referrals
  SET qualified_at = now()
  WHERE referred_id = p_referred_user_id AND qualified_at IS NULL;

  -- Stamp the referrer's linked pending row too, so the refund sweep can
  -- find it via qualifying_ticket_id if this ticket is later refunded,
  -- even though the referrer's own status flip still waits for the
  -- unchanged 14-day hold. Unchanged from 20260807120000 -- no
  -- activated_at here, since the referrer's row activates later, via
  -- _sweep_referral_vc's own 14-day check on its own earned_at, which
  -- this fix does not touch.
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

-- Same grant set as 20260807120000 shipped -- project_admin only, no
-- client-side caller exists. CREATE OR REPLACE does not reset existing
-- grants, but these are repeated explicitly for clarity/defense-in-depth,
-- exactly mirroring the original migration's own REVOKE+GRANT pair.
REVOKE EXECUTE ON FUNCTION public.qualify_referral(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qualify_referral(uuid, uuid) TO project_admin;

-- ── 2. request_vc_cashout -- CREATE OR REPLACE layers limits + eligibility
--       onto the exact same entry point Batch A shipped, same signature,
--       same idempotency-first-then-debit ordering, same _vc_deduct call ──
--
-- FRESH/FARMED VC ELIGIBILITY -- investigation and design rationale:
--
-- Traced concretely against the POST-Batch-B system (complete_referral /
-- qualify_referral / _sweep_referral_vc in
-- migrations/20260807120000_referral-economy-integrity.sql):
--
--   - Referred user's 150 VC: inserted 'pending' by complete_referral(),
--     flips to 'active' (and is credited into vents_wallets.balance) by
--     qualify_referral() the MOMENT their first real, non-zero,
--     Paystack-confirmed ticket purchase clears -- i.e. NOT after any
--     14-day hold. The 14-day hold in this codebase applies only to the
--     REFERRER's 300 VC (_sweep_referral_vc's activation branch), never to
--     the referred user's 150 VC.
--   - Ticket-purchase 'earn' VC (50 VC/ticket, confirm_ticket_payment):
--     inserted 'active' immediately on a real paid purchase (Batch C
--     hardened the dedup key, not the timing).
--
-- So: signup -> refer a friend (or be referred) -> that friend's first
-- real ticket purchase -> 150 VC (or the referrer's ticket purchases
-- themselves, 50 VC each) can reach 'active', spendable-balance status
-- within minutes of a purchase clearing, with NO time-based hold at all
-- on top of "a genuine payment cleared". A brand-new account that
-- immediately transacts (their own or a referred friend's real purchase)
-- can therefore have freshly-active VC available to combine toward a
-- cash-out almost immediately -- Batch B's qualification gate stops FREE/
-- fake signups from paying out, but does not by itself impose any
-- additional TIME-based maturation once a real payment has occurred.
--
-- Given amounts here are small per-event (150/300 VC referral, 50 VC/
-- ticket) against a 250,000 VC minimum, single-event farming cannot reach
-- the cash-out floor on its own -- but repeated real purchases (or many
-- referrals) accumulating just past the floor and cashing out within
-- minutes of the last credit is still a live pattern this batch is asked
-- to close specifically for CASH-OUT (not general spending, which stays
-- immediate -- a legitimate 5-VC ticket discount redemption etc. must not
-- wait on a hold).
--
-- Implementation: this schema already carries exactly what is needed for
-- a ledger-based (not scalar-balance-based) rule -- vc_transactions.status
-- ('active') and .earned_at already exist and are already the source the
-- wallet-sync trigger (trg_vc_wallet_sync, type IN ('earn','referral'),
-- status = 'active') uses to credit vents_wallets.balance. So:
--
--   v_recent_unmatured := SUM(vc_transactions.amount)
--     WHERE user_id = caller AND type IN ('earn','referral')
--       AND status = 'active' AND amount > 0
--       AND earned_at > now() - vc_cashout_maturation_hold_hours
--
--   v_cashout_eligible := balance - LEAST(balance, v_recent_unmatured)
--
-- This is deliberately conservative rather than a precise FIFO
-- reconstruction: vents_wallets.balance is a flattened scalar with no
-- FIFO/aging concept of WHICH specific earned VC funded a later spend, so
-- this migration does not attempt to retrofit true FIFO lot-tracking
-- (out of scope for an additive migration, per this task's own explicit
-- instruction to stop rather than fake a mechanism that doesn't actually
-- work). Instead it treats "the most recently earned VC, up to the
-- current balance" as the part still on hold -- the worst-case (most
-- restrictive) assumption when the true spend order is unknown. This can
-- occasionally hold back VC that was, in reality, already spent and only
-- older VC remains (over-restrictive, safe direction), but it can NEVER
-- under-restrict: it never allows treating unmatured VC as eligible. An
-- account with only older, already-matured VC (earned_at older than the
-- hold, or from 'refund'/'spend'-adjacent activity outside the summed
-- types) is completely unaffected -- v_recent_unmatured is 0 for them and
-- their full balance remains eligible for cash-out AND general spending,
-- exactly as today.
CREATE OR REPLACE FUNCTION public.request_vc_cashout(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id            uuid := auth.uid();
  v_account            public.vc_bank_accounts;
  v_rate               integer;
  v_ngn_kobo           bigint;
  v_id                 uuid;
  v_rows               int;
  v_min_vc             integer;
  v_max_vc             integer;
  v_daily_max_vc       integer;
  v_daily_max_requests integer;
  v_cooldown_minutes   integer;
  v_hold_hours         integer;
  v_last_request_at    timestamptz;
  v_recent_count       integer;
  v_recent_vc_sum      bigint;
  v_balance            integer;
  v_recent_unmatured   bigint;
  v_cashout_eligible   bigint;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before requesting a cash-out';
  END IF;

  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  -- Serialize every check-then-insert below for THIS user: two concurrent/
  -- simultaneous requests from the same account now queue on this lock
  -- instead of racing the limit checks -- the second call always sees the
  -- first call's already-committed row when it evaluates the cooldown /
  -- daily-count / daily-amount / eligibility checks, so none of those
  -- limits can be bypassed by firing requests in parallel. Mirrors
  -- complete_referral()'s per-referrer pg_advisory_xact_lock pattern
  -- (migrations/20260807120000_referral-economy-integrity.sql).
  PERFORM pg_advisory_xact_lock(hashtextextended('vc_cashout:' || v_user_id::text, 0));

  SELECT vc_cashout_min_vc, vc_cashout_max_vc, vc_cashout_daily_max_vc,
         vc_cashout_daily_max_requests, vc_cashout_cooldown_minutes,
         vc_cashout_maturation_hold_hours
    INTO v_min_vc, v_max_vc, v_daily_max_vc, v_daily_max_requests,
         v_cooldown_minutes, v_hold_hours
  FROM public.app_config LIMIT 1;

  IF p_vc_amount IS NULL OR p_vc_amount < v_min_vc THEN
    RAISE EXCEPTION 'Minimum cash-out is % Vents Cents', v_min_vc;
  END IF;

  IF p_vc_amount > v_max_vc THEN
    RAISE EXCEPTION 'Maximum single cash-out is % Vents Cents', v_max_vc;
  END IF;

  -- Cooldown: gap since this user's most recent request, regardless of its
  -- outcome (a fresh idempotency key always creates a genuinely new row,
  -- so idempotency replay-detection alone is not a rate limit).
  SELECT max(created_at) INTO v_last_request_at
  FROM public.vc_withdrawal_requests WHERE user_id = v_user_id;

  IF v_last_request_at IS NOT NULL
     AND v_last_request_at > now() - make_interval(mins => v_cooldown_minutes) THEN
    RAISE EXCEPTION 'Please wait before submitting another cash-out request';
  END IF;

  -- Rolling 24h request-COUNT cap (every request, any status -- bounds
  -- request volume/spam itself, not just successful payouts).
  SELECT count(*) INTO v_recent_count
  FROM public.vc_withdrawal_requests
  WHERE user_id = v_user_id AND created_at > now() - INTERVAL '24 hours';

  IF v_recent_count >= v_daily_max_requests THEN
    RAISE EXCEPTION 'Daily cash-out request limit reached, please try again later';
  END IF;

  -- Rolling 24h VC-AMOUNT cap: sums only requests that still represent (or
  -- represented) a real reservation of funds -- excludes rejected/
  -- cancelled/failed, whose VC was already restored and is no longer
  -- "withdrawn" in any sense.
  SELECT COALESCE(sum(vc_amount), 0) INTO v_recent_vc_sum
  FROM public.vc_withdrawal_requests
  WHERE user_id = v_user_id
    AND created_at > now() - INTERVAL '24 hours'
    AND status IN ('pending', 'processing', 'completed');

  IF v_recent_vc_sum + p_vc_amount > v_daily_max_vc THEN
    RAISE EXCEPTION 'Daily cash-out amount limit reached, please try again later';
  END IF;

  -- Fresh/farmed-VC maturation hold for CASH-OUT ELIGIBILITY (see the
  -- design-rationale comment above this function).
  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = v_user_id;
  v_balance := COALESCE(v_balance, 0);

  -- Keyed off COALESCE(activated_at, earned_at): activated_at is set only
  -- for referral rows that have gone through qualify_referral()'s
  -- pending -> active flip, and marks the true activation moment. Rows
  -- where it is NULL (ticket-purchase 'earn' rows, whose earned_at IS
  -- already their activation time) fall back to earned_at, unchanged from
  -- before this fix. See the "Fix: delayed-qualification maturation
  -- bypass" comment above for the full investigation.
  SELECT COALESCE(sum(amount), 0) INTO v_recent_unmatured
  FROM public.vc_transactions
  WHERE user_id = v_user_id
    AND type IN ('earn', 'referral')
    AND status = 'active'
    AND amount > 0
    AND COALESCE(activated_at, earned_at) > now() - make_interval(hours => v_hold_hours);

  v_cashout_eligible := v_balance - LEAST(v_balance, v_recent_unmatured);

  IF p_vc_amount > v_cashout_eligible THEN
    RAISE EXCEPTION 'Some of your Vents Cents were earned too recently to cash out yet -- please try again once they mature';
  END IF;

  SELECT * INTO v_account FROM public.vc_bank_accounts
  WHERE id = p_bank_account_id AND user_id = v_user_id
    AND is_active AND recipient_code IS NOT NULL;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Bank account not verified';
  END IF;

  -- Server-side only -- never accepted as a parameter from the client.
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
    -- Replayed idempotency key -- return the existing request, no new debit.
    SELECT id INTO v_id FROM public.vc_withdrawal_requests
    WHERE user_id = v_user_id AND idempotency_key = p_idempotency_key;
    RETURN v_id;
  END IF;

  -- Atomic, row-locked debit -- raises (and rolls back the INSERT above
  -- too, since this whole function is one transaction) if the balance is
  -- insufficient. Mirrors _vc_deduct's own FOR UPDATE lock on
  -- vents_wallets. This remains the FINAL, authoritative balance check --
  -- the eligibility check above only restricts recently-earned VC, it does
  -- not replace _vc_deduct's real, concurrency-safe sufficiency check.
  PERFORM public._vc_deduct(v_user_id, p_vc_amount, 'VC cash-out request');

  RETURN v_id;
END;
$function$
;

-- No grant changes needed: request_vc_cashout keeps the exact grant set
-- 0082_vc_cashout.sql already gave it (anon, authenticated, project_admin
-- EXECUTE) -- CREATE OR REPLACE FUNCTION does not reset existing grants.
