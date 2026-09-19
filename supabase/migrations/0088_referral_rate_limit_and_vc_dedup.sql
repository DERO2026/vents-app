-- P1-2 — Rate-limit complete_referral.
-- P1-3 — Give the ticket-purchase VC award a real dedup index.

-- =====================================================================
-- P1-2: complete_referral rate limiting.
--
-- complete_referral is called exactly once per user in normal operation —
-- AuthScreen.tsx:733, immediately after signup, with the referral code the
-- user arrived with. It had no rate limit of any kind while awarding 150 VC
-- to the caller and queuing 300 VC to the referrer.
--
-- Limits are deliberately far above legitimate use (one call, ever):
--   per user: 5 per hour  — a retry loop or a double-submitted signup form
--                           stays well clear; scripted code-guessing does not.
--   per IP:  20 per hour  — catches many-accounts-one-machine farming that a
--                           per-user key cannot see.
-- The two-key (identity + IP) shape copies check_auth_rate_limit
-- (0004:550-551 / 0026:59-60) exactly; the mechanism is the existing
-- public.check_rate_limit(key, max, window_seconds), unchanged.
--
-- Placement is after the auth check (so an unauthenticated call still gets
-- its plain 'Not authenticated' result rather than consuming quota) but
-- BEFORE the referrer-code lookup — otherwise the lookup itself is the
-- brute-force oracle we are trying to throttle.
--
-- ── DOCUMENTED FLAW NOT FIXED HERE (deliberate) ────────────────────────
-- Rate limiting narrows, but does not close, a design gap found while
-- reading this function: nothing enforces "a user may be referred only
-- ONCE, by one referrer". vc_transactions_referral_dedup_idx is on
-- (user_id, reference_id) WHERE type='referral', and for the referred user
-- reference_id is the REFERRER's id — so the same account can legitimately
-- satisfy that index once per distinct referrer code and collect 150 VC
-- each time.
--
-- I am NOT fixing that here, on purpose. The obvious in-function guard
-- ("does this user already have a referral row?") is wrong, because a
-- referrer also owns referral rows keyed to each person they referred, so
-- that test would block a legitimate referrer from ever being referred
-- themselves. Separating the two roles reliably needs a real schema change
-- — e.g. users.referred_by uuid with a UNIQUE/NOT-NULL-once constraint, or
-- a dedicated referral_redemptions table — plus a backfill and a decision
-- about existing multi-referred accounts. Shipping an amount-or-status
-- heuristic (amount = 150, status = 'active') into a live financial path
-- to approximate that would be exactly the fragile guess this pass is
-- meant to avoid. Flagged in the report as its own work item.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.complete_referral(p_referrer_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_referred_id uuid := auth.uid();
  v_referrer_id uuid;
  v_new_row_id  uuid;
  v_referred_name text;
BEGIN
  IF v_referred_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  -- P1-2: throttle before the code lookup below can be used as an oracle.
  PERFORM public.check_rate_limit('complete_referral:' || v_referred_id::text, 5, 3600);
  PERFORM public.check_rate_limit('complete_referral:ip:' || public.client_ip(), 20, 3600);

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

  -- 150 VC to the new user immediately. This INSERT is the real
  -- idempotency gate: vc_transactions_referral_dedup_idx makes a second
  -- concurrent/duplicate call for the same (referred, referrer) pair
  -- conflict here and insert nothing, so only one caller ever proceeds
  -- past this point — no separate read-then-write race window.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (v_referred_id, 150, 'referral', 'active', v_referrer_id, now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING
  RETURNING id INTO v_new_row_id;

  IF v_new_row_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Referral already applied');
  END IF;

  -- 300 VC to referrer pending 14 days (pending rows don't trigger wallet
  -- update). Guarded by the same unique index, scoped to the referrer's
  -- own user_id — belt-and-suspenders, since reaching this line already
  -- implies the line above won the race for this referral event.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (v_referrer_id, 300, 'referral', 'pending', v_referred_id, now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING;

  INSERT INTO public.referrals (referrer_id, invitee_email, status)
  VALUES (
    v_referrer_id,
    (SELECT email FROM auth.users WHERE id = v_referred_id LIMIT 1),
    'joined'
  )
  ON CONFLICT DO NOTHING;

  SELECT COALESCE(full_name, username, 'Someone') INTO v_referred_name
  FROM public.users WHERE id = v_referred_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_referred_id, 'promo', 'Referral Bonus', '+150 Vents Cents added to your wallet for joining via a referral link.', false, '🎉');

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_referrer_id, 'promo', 'Referral Joined', v_referred_name || ' joined using your referral link! 300 Vents Cents pending (available in 14 days).', false, '🤝');

  RETURN jsonb_build_object('success', true, 'awarded_to_you', 150, 'referrer_pending', 300);
END;
$function$
;

-- =====================================================================
-- P1-3: back the ticket-purchase VC award with a real unique index.
--
-- confirm_ticket_payment (0070) and confirm_ticket_payment_via_wallet
-- (0075) both end with:
--
--   INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
--   VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
--   ON CONFLICT DO NOTHING;
--
-- A bare ON CONFLICT DO NOTHING only fires against an actual unique index.
-- The sole unique index on vc_transactions is
-- vc_transactions_referral_dedup_idx, which is partial on type='referral'
-- and therefore never matches an 'earn' row. So the clause was DEAD CODE:
-- a webhook retry, a client re-verify racing the webhook, or any repeated
-- confirmation awarded 50 VC again, every time. And because
-- trg_vc_wallet_sync (0009:28) is AFTER INSERT and credits
-- vents_wallets.balance on every 'earn'/'active' row, each duplicate
-- inflated a real spendable balance.
--
-- SAFETY OF THE INDEX SHAPE — every 'earn' writer was checked, not assumed:
--   * confirm_ticket_payment (0070)            reference_id = first ticket id
--   * confirm_ticket_payment_via_wallet (0075) reference_id = first ticket id
--        ^ these two are mutually exclusive payment paths for the SAME
--          purchase, so collapsing them to one award per ticket is exactly
--          the intended behavior, not an accidental block.
--   * admin_credit_vents_cents (0004)          reference_id = gen_random_uuid()
--        ^ fresh uuid per call, so it can never collide — an admin can
--          still issue unlimited separate credits to the same user.
--   * claim_profile_bonus (0004)               reference_id omitted (NULL)
--        ^ excluded by the reference_id IS NOT NULL predicate below, so the
--          one-off profile bonus is untouched.
-- No other function inserts type='earn'.
--
-- Style mirrors vc_transactions_referral_dedup_idx (0007:72) and
-- user_wallet_transactions_deposit_ref_idx (0065), both partial unique
-- indexes used as ON CONFLICT targets.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ARCHIVE TABLES — every row this migration deletes is preserved first.
--
-- The previous version of this cleanup deleted duplicate ledger rows and
-- left behind only a two-integer summary in admin_logs. That is not enough
-- to answer the question that actually matters after a balance-affecting
-- cleanup: "which exact rows were removed, from which users, and why?"
-- These two tables make the operation fully reconstructible and reversible
-- by hand.
--
-- Lockdown follows the 0026 pattern exactly: RLS ENABLED with ZERO
-- policies, and no grants to anon/authenticated. With RLS on and no policy,
-- PostgreSQL denies all client access outright; only SECURITY DEFINER
-- functions (running as the table owner) and project_admin can read or
-- write. Nothing here is client-writable and no actor value is ever taken
-- from a client — consistent with the admin_logs hardening in 0087.
-- ---------------------------------------------------------------------

-- One row per deleted vc_transactions row — a faithful copy of the ledger
-- row plus the forensic context needed to justify its removal.
CREATE TABLE IF NOT EXISTS public.vc_earn_duplicate_archive (
  transaction_id      uuid        NOT NULL,
  user_id             uuid        NOT NULL,
  amount              integer     NOT NULL,
  type                text        NOT NULL,
  status              text        NOT NULL,
  reference_id        uuid,
  earned_at           timestamptz,
  expires_at          timestamptz,
  created_at          timestamptz,
  -- Forensics: which row was kept instead, and why this one was classified
  -- as the duplicate.
  kept_transaction_id uuid        NOT NULL,
  duplicate_rank      integer     NOT NULL,
  dedup_reason        text        NOT NULL,
  -- Whether this row's amount had actually been credited to the wallet by
  -- trg_vc_wallet_sync (only type='earn' AND status='active' rows are), and
  -- therefore whether it was in scope for a debit.
  was_credited        boolean     NOT NULL,
  cleanup_run_id      uuid        NOT NULL,
  archived_at         timestamptz NOT NULL DEFAULT now(),
  -- PK on the ORIGINAL transaction id: this is the structural idempotency
  -- gate. A second run cannot re-archive, and therefore cannot re-debit or
  -- re-delete, a row that was already processed.
  CONSTRAINT vc_earn_duplicate_archive_pkey PRIMARY KEY (transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_vc_earn_duplicate_archive_user
  ON public.vc_earn_duplicate_archive (user_id);
CREATE INDEX IF NOT EXISTS idx_vc_earn_duplicate_archive_run
  ON public.vc_earn_duplicate_archive (cleanup_run_id);

ALTER TABLE public.vc_earn_duplicate_archive ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE
  ON public.vc_earn_duplicate_archive TO project_admin;

-- One row per (run, user): the honest financial reconciliation.
--
-- vc_identified is what the duplicates were worth. vc_reclaimed is what was
-- ACTUALLY removed from the balance. vc_unreclaimed is the difference — VC
-- that had already been spent, so the balance could not absorb the full
-- reversal. The old code reported vc_identified as if it were reclaimed,
-- which overstated the recovery whenever a user had spent their duplicate
-- credit. That gap is real money-equivalent and is now stored, not dropped.
CREATE TABLE IF NOT EXISTS public.vc_earn_duplicate_reclaim (
  cleanup_run_id  uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  duplicate_rows  integer     NOT NULL,
  vc_identified   bigint      NOT NULL,
  vc_reclaimed    bigint      NOT NULL,
  vc_unreclaimed  bigint      NOT NULL,
  balance_before  bigint      NOT NULL,
  balance_after   bigint      NOT NULL,
  wallet_existed  boolean     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vc_earn_duplicate_reclaim_pkey PRIMARY KEY (cleanup_run_id, user_id),
  CONSTRAINT vc_earn_duplicate_reclaim_amounts_check
    CHECK (vc_reclaimed >= 0 AND vc_unreclaimed >= 0 AND vc_reclaimed + vc_unreclaimed = vc_identified),
  CONSTRAINT vc_earn_duplicate_reclaim_balance_check
    CHECK (balance_after >= 0 AND balance_after = balance_before - vc_reclaimed)
);

CREATE INDEX IF NOT EXISTS idx_vc_earn_duplicate_reclaim_user
  ON public.vc_earn_duplicate_reclaim (user_id);

ALTER TABLE public.vc_earn_duplicate_reclaim ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE
  ON public.vc_earn_duplicate_reclaim TO project_admin;

-- ---------------------------------------------------------------------
-- DRY-RUN / BLAST-RADIUS. Read-only, zero mutation.
--
-- The migration itself is deterministic — it has no dry-run flag, because a
-- migration that behaves differently depending on a parameter is a
-- migration you cannot reason about. Blast radius is measured separately,
-- with the query below.
--
-- ► TO ASSESS PRODUCTION *BEFORE* THIS MIGRATION HAS EVER RUN, paste this
--   standalone query into a read-only session against a snapshot. It needs
--   nothing this migration creates:
--
--     WITH ranked AS (
--       SELECT t.id, t.user_id, t.amount, t.status,
--              row_number() OVER (PARTITION BY t.user_id, t.reference_id
--                                 ORDER BY t.earned_at ASC, t.id ASC) AS rn
--         FROM public.vc_transactions t
--        WHERE t.type = 'earn' AND t.reference_id IS NOT NULL
--     ),
--     dupes AS (SELECT * FROM ranked WHERE rn > 1),
--     per_user AS (
--       SELECT d.user_id,
--              COALESCE(sum(d.amount) FILTER (WHERE d.status = 'active'), 0)::bigint AS identified,
--              COALESCE(max(w.balance), 0)::bigint AS balance_before
--         FROM dupes d
--         LEFT JOIN public.vents_wallets w ON w.user_id = d.user_id
--        GROUP BY d.user_id
--     )
--     SELECT (SELECT count(*) FROM dupes)                                    AS duplicate_rows,
--            (SELECT count(DISTINCT user_id) FROM dupes)                     AS affected_users,
--            COALESCE(sum(identified), 0)                                    AS vc_identified,
--            COALESCE(sum(LEAST(identified, balance_before)), 0)             AS vc_reclaimable,
--            COALESCE(sum(identified - LEAST(identified, balance_before)), 0) AS vc_unreclaimable
--       FROM per_user;
--
-- ► AFTER this migration is applied, the same logic is available as a
--   permanent, admin-gated function for re-checking at any time:
--   SELECT * FROM public.vc_earn_duplicate_dryrun();
--
--   It is STABLE and performs no writes. It reports what a cleanup WOULD do
--   against current data; after a successful run it should report all zeros.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vc_earn_duplicate_dryrun()
 RETURNS TABLE(
   duplicate_rows   bigint,
   affected_users   bigint,
   vc_identified    bigint,
   vc_reclaimable   bigint,
   vc_unreclaimable bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;

  RETURN QUERY
  WITH ranked AS (
    SELECT t.id, t.user_id, t.amount, t.status,
           row_number() OVER (PARTITION BY t.user_id, t.reference_id
                              ORDER BY t.earned_at ASC, t.id ASC) AS rn
      FROM public.vc_transactions t
     WHERE t.type = 'earn' AND t.reference_id IS NOT NULL
  ),
  dupes AS (
    SELECT r.id, r.user_id, r.amount, r.status FROM ranked r WHERE r.rn > 1
  ),
  per_user AS (
    SELECT d.user_id,
           COALESCE(sum(d.amount) FILTER (WHERE d.status = 'active'), 0)::bigint AS identified,
           COALESCE(max(w.balance), 0)::bigint AS balance_before
      FROM dupes d
      LEFT JOIN public.vents_wallets w ON w.user_id = d.user_id
     GROUP BY d.user_id
  )
  SELECT (SELECT count(*) FROM dupes)::bigint,
         (SELECT count(DISTINCT d.user_id) FROM dupes d)::bigint,
         COALESCE(sum(p.identified), 0)::bigint,
         COALESCE(sum(LEAST(p.identified, p.balance_before)), 0)::bigint,
         COALESCE(sum(p.identified - LEAST(p.identified, p.balance_before)), 0)::bigint
    FROM per_user p;
END;
$function$
;

REVOKE ALL ON FUNCTION public.vc_earn_duplicate_dryrun() FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.vc_earn_duplicate_dryrun() TO authenticated;

-- ---------------------------------------------------------------------
-- THE CLEANUP.
--
-- Order is load-bearing and each step is justified:
--
--   1. ARCHIVE FIRST. Nothing is deleted before it is copied. The archive's
--      PK on transaction_id, combined with ON CONFLICT DO NOTHING and
--      RETURNING, is also the idempotency gate: only rows archived by THIS
--      run flow into the debit and delete steps. A previously-processed row
--      cannot be archived twice, so it cannot be debited or deleted twice.
--
--   2. RECONCILE. Per user, compute what the balance can actually absorb.
--      actual = LEAST(identified, balance_before), so the debit is clamped
--      BEFORE it is applied and the clamped-away remainder is captured as
--      vc_unreclaimed rather than being silently reported as recovered.
--
--   3. DEBIT. Only what step 2 proved is available. GREATEST(0, ...) is
--      retained as a second, structural guarantee that no balance can go
--      negative even if step 2 were ever wrong.
--
--   4. DELETE. Safe to do after the debit. Both triggers on vc_transactions
--      were checked, not assumed: trg_vc_wallet_sync (0009:28) is AFTER
--      INSERT, and trg_realtime_vc (0009:27) is AFTER INSERT OR UPDATE.
--      Neither fires on DELETE, so removing a ledger row cannot
--      double-reverse the balance or emit a spurious realtime event.
--
-- Only type='earn' AND status='active' rows are debited, because those are
-- exactly the rows trg_sync_vc_to_wallet credits. Non-active duplicates are
-- still archived and deleted (they must be, for the unique index to build)
-- but contribute 0 to the debit — recorded via was_credited.
--
-- The earliest row per (user_id, reference_id) is always the one kept.
-- ---------------------------------------------------------------------
DO $dedup$
DECLARE
  v_run_id       uuid   := gen_random_uuid();
  v_dupes        bigint := 0;
  v_users        bigint := 0;
  v_identified   bigint := 0;
  v_reclaimed    bigint := 0;
  v_unreclaimed  bigint := 0;
BEGIN
  -- STEP 1 — archive, and let the archive decide what is in scope.
  -- The DROPs make a manual re-run inside a single session safe; ON COMMIT
  -- DROP already covers the normal transaction-scoped case.
  DROP TABLE IF EXISTS _vc_archived;
  DROP TABLE IF EXISTS _vc_recon;

  CREATE TEMP TABLE _vc_archived ON COMMIT DROP AS
  WITH ranked AS (
    SELECT t.id, t.user_id, t.amount, t.type, t.status, t.reference_id,
           t.earned_at, t.expires_at, t.created_at,
           first_value(t.id) OVER (PARTITION BY t.user_id, t.reference_id
                                   ORDER BY t.earned_at ASC, t.id ASC) AS kept_id,
           row_number()  OVER (PARTITION BY t.user_id, t.reference_id
                               ORDER BY t.earned_at ASC, t.id ASC)     AS rn
      FROM public.vc_transactions t
     WHERE t.type = 'earn' AND t.reference_id IS NOT NULL
  ),
  ins AS (
    INSERT INTO public.vc_earn_duplicate_archive (
      transaction_id, user_id, amount, type, status, reference_id,
      earned_at, expires_at, created_at,
      kept_transaction_id, duplicate_rank, dedup_reason, was_credited,
      cleanup_run_id
    )
    SELECT r.id, r.user_id, r.amount, r.type, r.status, r.reference_id,
           r.earned_at, r.expires_at, r.created_at,
           r.kept_id, r.rn::integer,
           'duplicate type=earn award for the same (user_id, reference_id); '
             || 'earliest row ' || r.kept_id::text || ' retained. '
             || 'Root cause: confirm_ticket_payment / confirm_ticket_payment_via_wallet '
             || 'used ON CONFLICT DO NOTHING with no backing unique index (dead clause), '
             || 'so retries re-awarded. Index vc_transactions_earn_dedup_idx added in 0088.',
           (r.type = 'earn' AND r.status = 'active'),
           v_run_id
      FROM ranked r
     WHERE r.rn > 1
    ON CONFLICT (transaction_id) DO NOTHING
    RETURNING transaction_id, user_id, amount, status, was_credited
  )
  SELECT * FROM ins;

  SELECT count(*) INTO v_dupes FROM _vc_archived;

  IF v_dupes = 0 THEN
    -- Idempotent no-op: either there were never any duplicates, or a
    -- previous run already archived, debited and deleted them all. No
    -- balance is touched and no run row is written.
    RETURN;
  END IF;

  -- STEP 2 — honest per-user reconciliation, computed BEFORE any write.
  CREATE TEMP TABLE _vc_recon ON COMMIT DROP AS
  WITH per_user AS (
    SELECT a.user_id,
           count(*)::integer AS duplicate_rows,
           COALESCE(sum(a.amount) FILTER (WHERE a.was_credited), 0)::bigint AS identified
      FROM _vc_archived a
     GROUP BY a.user_id
  )
  SELECT p.user_id,
         p.duplicate_rows,
         p.identified,
         (w.user_id IS NOT NULL)                                  AS wallet_existed,
         COALESCE(w.balance, 0)::bigint                           AS balance_before,
         LEAST(p.identified, COALESCE(w.balance, 0))::bigint      AS reclaimed,
         (p.identified - LEAST(p.identified, COALESCE(w.balance, 0)))::bigint AS unreclaimed,
         (COALESCE(w.balance, 0) - LEAST(p.identified, COALESCE(w.balance, 0)))::bigint AS balance_after
    FROM per_user p
    LEFT JOIN public.vents_wallets w ON w.user_id = p.user_id;

  -- STEP 3 — debit exactly the reclaimable amount. GREATEST(0, ...) is
  -- redundant given the clamp above and is kept as a structural guard.
  UPDATE public.vents_wallets w
     SET balance    = GREATEST(0, w.balance - r.reclaimed)::integer,
         updated_at = now()
    FROM _vc_recon r
   WHERE w.user_id = r.user_id
     AND r.reclaimed > 0;

  -- STEP 4 — delete only what this run archived.
  DELETE FROM public.vc_transactions t
   USING _vc_archived a
   WHERE t.id = a.transaction_id;

  -- Persist the per-user accounting, including the unreclaimable remainder.
  INSERT INTO public.vc_earn_duplicate_reclaim (
    cleanup_run_id, user_id, duplicate_rows, vc_identified, vc_reclaimed,
    vc_unreclaimed, balance_before, balance_after, wallet_existed
  )
  SELECT v_run_id, r.user_id, r.duplicate_rows, r.identified, r.reclaimed,
         r.unreclaimed, r.balance_before, r.balance_after, r.wallet_existed
    FROM _vc_recon r
  ON CONFLICT (cleanup_run_id, user_id) DO NOTHING;

  SELECT count(*), COALESCE(sum(identified), 0), COALESCE(sum(reclaimed), 0), COALESCE(sum(unreclaimed), 0)
    INTO v_users, v_identified, v_reclaimed, v_unreclaimed
    FROM _vc_recon;

  -- Run-level summary. Reports identified, actually-reclaimed and
  -- unreclaimed as three DISTINCT figures — the previous version conflated
  -- the first with the second.
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'vc_earn_duplicate_cleanup', NULL,
          jsonb_build_object(
            'migration',                '0088',
            'cleanup_run_id',           v_run_id,
            'duplicate_rows_archived',  v_dupes,
            'affected_users',           v_users,
            'vc_identified',            v_identified,
            'vc_actually_reclaimed',    v_reclaimed,
            'vc_unreclaimed_insufficient_balance', v_unreclaimed,
            'archive_table',            'public.vc_earn_duplicate_archive',
            'reclaim_table',            'public.vc_earn_duplicate_reclaim'),
          'system:migration');
END
$dedup$;

-- ---------------------------------------------------------------------
-- INDEX CREATION — deployment safety.
--
-- This statement is intentionally NOT `CONCURRENTLY`. Verified reasoning,
-- not assumption:
--
--   * PostgreSQL forbids CREATE INDEX CONCURRENTLY inside a transaction
--     block — it performs multiple table scans that must each commit
--     separately, and the server raises
--     "CREATE INDEX CONCURRENTLY cannot run inside a transaction block".
--   * The Supabase CLI applies each migration file inside a single
--     transaction, so a CONCURRENTLY statement placed here would abort the
--     whole migration.
--   * It must also be in the same transaction as the cleanup above: if the
--     cleanup committed but the index failed, duplicates could be written
--     again before a retry. Keeping both in one transaction makes the pair
--     atomic.
--   * This repo has no CREATE INDEX CONCURRENTLY precedent anywhere in
--     supabase/migrations — confirmed by grep.
--
-- BUILDING THIS INDEX TAKES AN ACCESS EXCLUSIVE LOCK on vc_transactions for
-- the duration of the build, blocking reads and writes. This is NOT a
-- zero-downtime statement and is not claimed to be. The lock is brief on a
-- small table and grows with row count.
--
-- ► IF vc_transactions IS LARGE ENOUGH THAT THE LOCK IS UNACCEPTABLE, do
--   this instead, and confirm row count first:
--
--     SELECT count(*) FROM public.vc_transactions;          -- measure first
--     SELECT * FROM public.vc_earn_duplicate_dryrun();      -- blast radius
--
--   1. Run the cleanup migration content EXCEPT this index statement.
--   2. In a separate session with autocommit ON (psql, NOT inside BEGIN,
--      and NOT via `supabase db push`), run:
--
--        CREATE UNIQUE INDEX CONCURRENTLY vc_transactions_earn_dedup_idx
--          ON public.vc_transactions (user_id, reference_id)
--          WHERE (type = 'earn' AND reference_id IS NOT NULL);
--
--   3. CONCURRENTLY can fail and leave an INVALID index behind (it does not
--      roll back). Always verify, and if invalid, drop and retry:
--
--        SELECT i.indisvalid FROM pg_index i
--          JOIN pg_class c ON c.oid = i.indexrelid
--         WHERE c.relname = 'vc_transactions_earn_dedup_idx';
--        -- if false:
--        DROP INDEX CONCURRENTLY vc_transactions_earn_dedup_idx;
--
--   4. Then apply this migration. The IF NOT EXISTS below makes the
--      statement a no-op, so the migration still records as applied.
--
--   Note that between steps 1 and 2 there is a window with no unique
--   constraint, during which a retry could create a new duplicate. Keep it
--   short, and re-run vc_earn_duplicate_dryrun() after step 2 to confirm.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_earn_dedup_idx
  ON public.vc_transactions (user_id, reference_id)
  WHERE (type = 'earn' AND reference_id IS NOT NULL);
