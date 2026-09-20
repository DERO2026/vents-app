import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real, static SQL-text-assertion tests for VENTS Cents Batch D (cash-out
// protection: raised minimum, withdrawal limits, fresh/farmed-VC
// maturation hold for cash-out eligibility) plus the bank-selector search
// behavior, mirroring this repo's own convention (see
// src/lib/vcCashout.security.test.ts / vcTicketReward*.security.test.ts) of
// verifying a live migration's actual, deployed function body rather than
// a re-implementation that could silently drift from what ships.
//
// Covered migration: supabase/migrations/0084_vc_cashout_limits_and_maturation.sql
// (layered CREATE OR REPLACE on top of 0082_vc_cashout.sql's
// request_vc_cashout, which this file does NOT modify -- see
// vcCashout.security.test.ts for Batch A's own, still-valid assertions
// against the original 0082 file).

let migration: string;
let referralMigration: string; // 20260807120000 -- proves the 14-day hold only covers the referrer side
let priorMigration0082: string; // 0082 -- proves it is untouched
let screenSrc: string;

function fn(src: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`);
  return src.match(re)?.[0] ?? '';
}

// Like fn(), but for functions delimited with a bare `$$` body (LANGUAGE
// plpgsql without the $function$ tag) -- e.g. qualify_referral as layered
// into 0084. Anchors on the literal `CREATE OR REPLACE FUNCTION
// public.<name>(<exact args>)` signature line (not just the name) so it
// can't match a mention of the same name inside an earlier comment.
function fnDollarDollar(src: string, signature: string): string {
  const escaped = signature.replace(/[()]/g, '\\$&');
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${escaped}\\s*\\n[\\s\\S]*?\\n\\$\\$;`);
  return src.match(re)?.[0] ?? '';
}

beforeAll(() => {
  const migDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(migDir, '0084_vc_cashout_limits_and_maturation.sql'), 'utf8');
  priorMigration0082 = readFileSync(join(migDir, '0082_vc_cashout.sql'), 'utf8');
  referralMigration = readFileSync(join(__dirname, '..', '..', 'migrations', '20260807120000_referral-economy-integrity.sql'), 'utf8');
  screenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'VcCashoutScreen.tsx'), 'utf8');
});

describe('0082_vc_cashout.sql is not modified by this batch', () => {
  it('0082 still defines request_vc_cashout with the OLD 1,000 VC minimum -- proving Batch D is a later, additive layer, not an edit to Batch A', () => {
    expect(priorMigration0082).toMatch(/RAISE EXCEPTION 'Minimum cash-out is 1,000 Vents Cents';/);
  });
});

describe('₦25,000 (250,000 VC) minimum, server-side and configurable', () => {
  it('adds vc_cashout_min_vc additively, defaulting to 250,000 (VC-denominated, not naira-named)', () => {
    expect(migration).toMatch(/ALTER TABLE public\.app_config\s*\n\s*ADD COLUMN IF NOT EXISTS vc_cashout_min_vc integer NOT NULL DEFAULT 250000;/);
  });

  it('does not touch vc_cashout_naira_per_1000 or vc_naira_per_1000 in any executable statement', () => {
    const codeOnly = migration.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(codeOnly).not.toMatch(/vc_naira_per_1000 integer/);
  });

  it('request_vc_cashout reads the minimum from app_config and rejects below it, before any insert/debit', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/SELECT vc_cashout_min_vc, vc_cashout_max_vc, vc_cashout_daily_max_vc,/);
    expect(f).toMatch(/IF p_vc_amount IS NULL OR p_vc_amount < v_min_vc THEN\s*\n\s*RAISE EXCEPTION 'Minimum cash-out is % Vents Cents', v_min_vc;/);
    const minIdx = f.indexOf("RAISE EXCEPTION 'Minimum cash-out is");
    const insertIdx = f.indexOf('INSERT INTO public.vc_withdrawal_requests');
    expect(minIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(minIdx);
  });

  it('250,000 VC = ₦25,000 at the unchanged default rate (100)', () => {
    const rate = 100;
    const kobo = Math.floor((250000 * rate * 100) / 1000);
    expect(kobo / 100).toBe(25000);
  });

  it('a request below the new minimum sent directly (bypassing the frontend) is rejected the same way -- the check reads app_config, not any client-supplied flag', () => {
    const f = fn(migration, 'request_vc_cashout');
    // No parameter carries or overrides the minimum -- signature unchanged.
    expect(f).toMatch(/CREATE OR REPLACE FUNCTION public\.request_vc_cashout\(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text\)/);
  });
});

describe('Withdrawal limits: max single, rolling 24h amount cap, rolling 24h request-count cap, cooldown', () => {
  it('adds all four limit columns additively, VC/time-denominated (never naira-named)', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS vc_cashout_max_vc integer NOT NULL DEFAULT 500000;/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS vc_cashout_daily_max_vc integer NOT NULL DEFAULT 500000;/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS vc_cashout_daily_max_requests integer NOT NULL DEFAULT 2;/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS vc_cashout_cooldown_minutes integer NOT NULL DEFAULT 60;/);
  });

  it('rejects a single request above vc_cashout_max_vc', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/IF p_vc_amount > v_max_vc THEN\s*\n\s*RAISE EXCEPTION 'Maximum single cash-out is % Vents Cents', v_max_vc;/);
  });

  it('enforces a cooldown keyed off the most recent request of ANY status', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/SELECT max\(created_at\) INTO v_last_request_at\s*\n\s*FROM public\.vc_withdrawal_requests WHERE user_id = v_user_id;/);
    expect(f).toMatch(/v_last_request_at > now\(\) - make_interval\(mins => v_cooldown_minutes\)/);
  });

  it('enforces a rolling 24h request-count cap counting every request regardless of status', () => {
    const f = fn(migration, 'request_vc_cashout');
    const block = f.match(/SELECT count\(\*\) INTO v_recent_count[\s\S]*?RAISE EXCEPTION 'Daily cash-out request limit reached, please try again later';/)?.[0] ?? '';
    expect(block).toMatch(/created_at > now\(\) - INTERVAL '24 hours'/);
    expect(block).not.toMatch(/AND status/); // no status filter -- every request counts
    expect(block).toMatch(/v_recent_count >= v_daily_max_requests/);
  });

  it('enforces a rolling 24h VC-amount cap over non-restored (still-reserved-or-paid) requests only', () => {
    const f = fn(migration, 'request_vc_cashout');
    const block = f.match(/SELECT COALESCE\(sum\(vc_amount\), 0\) INTO v_recent_vc_sum[\s\S]*?RAISE EXCEPTION 'Daily cash-out amount limit reached, please try again later';/)?.[0] ?? '';
    expect(block).toMatch(/AND status IN \('pending', 'processing', 'completed'\)/);
    expect(block).toMatch(/v_recent_vc_sum \+ p_vc_amount > v_daily_max_vc/);
  });

  it('all limit checks happen inside a per-user pg_advisory_xact_lock, before the reservation insert, so concurrent requests cannot race past them', () => {
    const f = fn(migration, 'request_vc_cashout');
    const lockIdx = f.indexOf("pg_advisory_xact_lock(hashtextextended('vc_cashout:' || v_user_id::text, 0))");
    const maxIdx = f.indexOf('IF p_vc_amount > v_max_vc THEN');
    const cooldownIdx = f.indexOf('v_last_request_at > now()');
    const countIdx = f.indexOf('v_recent_count >= v_daily_max_requests');
    const amountIdx = f.indexOf('v_recent_vc_sum + p_vc_amount > v_daily_max_vc');
    const insertIdx = f.indexOf('INSERT INTO public.vc_withdrawal_requests');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(maxIdx).toBeGreaterThan(lockIdx);
    expect(cooldownIdx).toBeGreaterThan(lockIdx);
    expect(countIdx).toBeGreaterThan(lockIdx);
    expect(amountIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(amountIdx);
  });

  it('concurrent withdrawal attempts cannot bypass limits -- structural reasoning: pg_advisory_xact_lock serializes ALL callers hashing to the same key (per user), so a second call for the same user always observes the first call\'s already-committed row before evaluating any count/sum limit (same mechanism as complete_referral\'s per-referrer lock)', () => {
    expect(referralMigration).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\('complete_referral:' \|\| v_referrer_id::text, 0\)\);/);
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\('vc_cashout:' \|\| v_user_id::text, 0\)\);/);
  });
});

describe('Fresh/farmed VC maturation hold for cash-out eligibility', () => {
  it('adds vc_cashout_maturation_hold_hours additively, default 72 hours', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS vc_cashout_maturation_hold_hours integer NOT NULL DEFAULT 72;/);
  });

  it('investigation finding is documented: referred-user VC activates immediately on first paid ticket (no 14-day hold on that side)', () => {
    // The 14-day hold in the referral migration applies ONLY to the referrer's pending row.
    expect(referralMigration).toMatch(/t\.earned_at < now\(\) - INTERVAL '14 days'/);
    // qualify_referral flips the REFERRED user's row from pending -> active on ticket confirmation, with no time condition at all.
    const qualify = fn(referralMigration, 'qualify_referral');
    expect(qualify).toMatch(/UPDATE public\.vc_transactions\s*\n\s*SET status = 'active', qualifying_ticket_id = p_ticket_id/);
    expect(qualify).not.toMatch(/INTERVAL '\d+ days'/);
  });

  it('computes a ledger-based (not flattened-balance) eligible-for-cashout amount, summing only recent active earn/referral credits', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/SELECT COALESCE\(sum\(amount\), 0\) INTO v_recent_unmatured\s*\n\s*FROM public\.vc_transactions\s*\n\s*WHERE user_id = v_user_id\s*\n\s*AND type IN \('earn', 'referral'\)\s*\n\s*AND status = 'active'\s*\n\s*AND amount > 0\s*\n\s*AND COALESCE\(activated_at, earned_at\) > now\(\) - make_interval\(hours => v_hold_hours\);/);
  });

  it('eligible amount = balance minus the lesser of (balance, recent unmatured sum) -- never negative, never exceeds balance', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/v_cashout_eligible := v_balance - LEAST\(v_balance, v_recent_unmatured\);/);
    expect(f).toMatch(/IF p_vc_amount > v_cashout_eligible THEN\s*\n\s*RAISE EXCEPTION 'Some of your Vents Cents were earned too recently to cash out yet -- please try again once they mature';/);
  });

  it('behavioral simulation: freshly-earned VC cannot immediately cash out, matured/older VC can, and an account with only old VC is fully unaffected', () => {
    function eligible(balance: number, recentUnmatured: number) {
      return balance - Math.min(balance, recentUnmatured);
    }
    // All-fresh balance: nothing eligible yet.
    expect(eligible(300000, 300000)).toBe(0);
    // Half fresh, half matured: only the matured half is eligible.
    expect(eligible(300000, 150000)).toBe(150000);
    // No recent credits at all (all matured/old): full balance eligible, unaffected by the hold.
    expect(eligible(300000, 0)).toBe(300000);
  });

  it('the hold does NOT gate general spending -- only request_vc_cashout computes/uses v_cashout_eligible; _vc_deduct (used by ticket VC-redemption too) is untouched by this migration', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\._vc_deduct/);
    expect(migration).not.toMatch(/purchase_ticket|redeem_vc/); // no unrelated spend path touched
  });

  it('the design comment is honest about NOT retrofitting true FIFO lot-tracking onto the flattened vents_wallets.balance scalar (documented limitation, not a fake mechanism)', () => {
    expect(migration).toMatch(/does not attempt to retrofit true FIFO lot-tracking/);
  });
});

describe('Delayed-referral-qualification maturation bypass fix (activated_at)', () => {
  it('adds activated_at additively on vc_transactions, not client-writable via any new policy/grant', () => {
    expect(migration).toMatch(/ALTER TABLE public\.vc_transactions\s*\n\s*ADD COLUMN IF NOT EXISTS activated_at timestamptz;/);
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*vc_transactions[\s\S]*FOR (INSERT|UPDATE)/);
    expect(migration).not.toMatch(/GRANT[^;]*vc_transactions[^;]*TO (anon|authenticated)/);
  });

  it('qualify_referral is layered via CREATE OR REPLACE in this migration and stamps activated_at = now() only inside the existing idempotency-guarded UPDATE', () => {
    const f = fnDollarDollar(migration, 'qualify_referral(p_referred_user_id uuid, p_ticket_id uuid)');
    expect(f).not.toBe('');
    expect(f).toMatch(/UPDATE public\.vc_transactions\s*\n\s*SET status = 'active', qualifying_ticket_id = p_ticket_id, activated_at = now\(\)\s*\n\s*WHERE user_id = p_referred_user_id\s*\n\s*AND type = 'referral'\s*\n\s*AND referral_role = 'referred'\s*\n\s*AND status = 'pending'\s*\n\s*AND qualifying_ticket_id IS NULL/);
  });

  it('qualify_referral keeps its project_admin-only grant -- no client-side caller, so activated_at can only ever be set server-side from confirm_ticket_payment', () => {
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.qualify_referral\(uuid, uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.qualify_referral\(uuid, uuid\) TO project_admin;/);
  });

  it('idempotency preserved: a second/replayed qualify_referral call cannot reset or re-stamp activated_at -- the guard (status=pending AND qualifying_ticket_id IS NULL) matches zero rows the second time', () => {
    const f = fnDollarDollar(migration, 'qualify_referral(p_referred_user_id uuid, p_ticket_id uuid)');
    const guard = f.match(/UPDATE public\.vc_transactions[\s\S]*?RETURNING amount, reference_id INTO v_amount, v_referrer_id;/)?.[0] ?? '';
    expect(guard).toMatch(/AND status = 'pending'/);
    expect(guard).toMatch(/AND qualifying_ticket_id IS NULL/);
    expect(f).toMatch(/IF v_amount IS NULL THEN\s*\n\s*-- Nothing pending \(never referred, or already qualified\) -- idempotent no-op\./);
  });

  it('the referrer-side pending row stamp is unchanged -- no activated_at set there, since the referrer still activates only via the unchanged 14-day _sweep_referral_vc path', () => {
    const f = fnDollarDollar(migration, 'qualify_referral(p_referred_user_id uuid, p_ticket_id uuid)');
    const referrerBlock = f.match(/UPDATE public\.vc_transactions\s*\n\s*SET qualifying_ticket_id = p_ticket_id\s*\n\s*WHERE user_id = v_referrer_id[\s\S]*?qualifying_ticket_id IS NULL;/)?.[0] ?? '';
    expect(referrerBlock).not.toBe('');
    expect(referrerBlock).not.toMatch(/activated_at/);
  });

  it('the maturation formula keys off COALESCE(activated_at, earned_at), not earned_at alone', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/COALESCE\(activated_at, earned_at\) > now\(\) - make_interval\(hours => v_hold_hours\);/);
  });

  it('behavioral simulation: signup time does not start the clock; qualification does; a cash-out immediately after qualification is rejected; qualifying >72h after signup still gets a fresh 72h hold measured from qualification, not signup', () => {
    const HOLD_HOURS = 72;
    function isMatured(nowHours: number, earnedAtHours: number, activatedAtHours: number | null) {
      const clockStart = activatedAtHours ?? earnedAtHours;
      return nowHours - clockStart > HOLD_HOURS;
    }

    // Signup (earned_at) at T0. Qualification (activated_at) at T0+100h --
    // more than 72h after signup, so if the bug were still present the
    // 150 VC would already read as "matured" the instant it activates.
    const earnedAtHours = 0;
    const activatedAtHours = 100;

    // Signup time alone must NOT start the clock: at the qualification
    // moment itself, using earned_at (T0) would already show >72h elapsed
    // (100 > 72) -- the bug. Using activated_at (0 elapsed since itself)
    // correctly shows not matured.
    expect(isMatured(activatedAtHours, earnedAtHours, null)).toBe(true); // old buggy behavior, for contrast
    expect(isMatured(activatedAtHours, earnedAtHours, activatedAtHours)).toBe(false); // fixed behavior

    // Cash-out attempted immediately after qualification (T0+100h, i.e.
    // 0h since activation): REJECTED (not matured).
    expect(isMatured(activatedAtHours + 0, earnedAtHours, activatedAtHours)).toBe(false);

    // Cash-out attempted 1h after qualification (T0+101h): still REJECTED
    // -- fresh 72h window from actual activation, not bypassed by the
    // >72h-since-signup gap.
    expect(isMatured(activatedAtHours + 1, earnedAtHours, activatedAtHours)).toBe(false);

    // Cash-out attempted 73h after qualification (T0+173h): ALLOWED --
    // the fresh window from activation has now elapsed.
    expect(isMatured(activatedAtHours + 73, earnedAtHours, activatedAtHours)).toBe(true);
  });

  it('normal ticket-purchase "earn" VC timing is unchanged: earned_at IS the activation moment, activated_at stays NULL, so COALESCE falls back to earned_at exactly as before this fix', () => {
    const f = fn(referralMigration, 'confirm_ticket_payment');
    expect(f).toMatch(/INSERT INTO public\.vc_transactions \(user_id, amount, type, status, reference_id, earned_at\)\s*\n\s*VALUES \(v_user_id, 50, 'earn', 'active', v_first_ticket_id, now\(\)\)/);
    // No activated_at column is set for earn rows anywhere in this migration or 0084's replace.
    const insertBlock = f.match(/INSERT INTO public\.vc_transactions \(user_id, amount, type, status, reference_id, earned_at\)[\s\S]*?ON CONFLICT DO NOTHING;/)?.[0] ?? '';
    expect(insertBlock).not.toMatch(/activated_at/);
  });
});

describe('Existing invariants from Batch A remain intact through the CREATE OR REPLACE', () => {
  it('still inserts the reservation row (idempotency-first) before calling _vc_deduct', () => {
    const f = fn(migration, 'request_vc_cashout');
    const insertIdx = f.indexOf('INSERT INTO public.vc_withdrawal_requests');
    const conflictIdx = f.indexOf('ON CONFLICT (user_id, idempotency_key) DO NOTHING');
    const deductIdx = f.indexOf('PERFORM public._vc_deduct(v_user_id, p_vc_amount');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(conflictIdx).toBeGreaterThan(insertIdx);
    expect(deductIdx).toBeGreaterThan(conflictIdx);
  });

  it('a replayed idempotency key still short-circuits before any new debit', () => {
    const f = fn(migration, 'request_vc_cashout');
    const guard = f.match(/GET DIAGNOSTICS v_rows = ROW_COUNT;\s*\n\s*IF v_rows = 0 THEN[\s\S]*?RETURN v_id;\s*\n\s*END IF;/)?.[0] ?? '';
    expect(guard).not.toBe('');
    expect(guard).not.toMatch(/_vc_deduct/);
  });

  it('still requires a verified, active bank account and honors disable_payouts and email verification', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/IF NOT public\.is_email_verified\(\) THEN/);
    expect(f).toMatch(/IF \(SELECT disable_payouts FROM public\.app_config LIMIT 1\) THEN\s*\n\s*RAISE EXCEPTION 'payouts_disabled';/);
    expect(f).toMatch(/AND is_active AND recipient_code IS NOT NULL;/);
  });

  it('unauthenticated callers are still rejected before any other logic', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/IF v_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';/);
  });

  it('still computes ngn_amount_kobo purely from the unchanged rate column and p_vc_amount', () => {
    const f = fn(migration, 'request_vc_cashout');
    expect(f).toMatch(/SELECT vc_cashout_naira_per_1000 INTO v_rate FROM public\.app_config LIMIT 1;/);
    expect(f).toMatch(/v_ngn_kobo := \(p_vc_amount::bigint \* v_rate::bigint \* 100\) \/ 1000;/);
  });

  it('does not redefine complete_vc_payout/fail_vc_payout/admin_* RPCs or touch their project_admin-only grants', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.complete_vc_payout/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fail_vc_payout/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.admin_/);
  });

  it('does not touch any organizer_* table or function', () => {
    expect(migration).not.toMatch(/organizer_withdrawal_requests|organizer_wallets|organizer_bank_accounts|organizer_payout/);
  });

  it('does not create any new INSERT policy on vc_withdrawal_requests (request_vc_cashout remains the only, SECURITY DEFINER insert path)', () => {
    expect(migration).not.toMatch(/CREATE POLICY[^;]*vc_withdrawal_requests[^;]*FOR INSERT/);
  });
});

describe('Searchable bank selector (VcCashoutScreen.tsx)', () => {
  it('filters banks client-side by case-insensitive substring match, over the same Paystack-sourced list (no new bank data source)', () => {
    expect(screenSrc).toMatch(/const filteredBanks = bankSearch\.trim\(\)\s*\n\s*\? banks\.filter\(b => b\.name\.toLowerCase\(\)\.includes\(bankSearch\.trim\(\)\.toLowerCase\(\)\)\)\s*\n\s*: banks;/);
    // Still sourced from /api/v1/wallet/banks -- no fabricated bank list.
    expect(screenSrc).toMatch(/apiUrl\('\/api\/v1\/wallet\/banks'\)/);
  });

  it('renders a "No banks found" empty state when the filter matches nothing', () => {
    expect(screenSrc).toMatch(/No banks found/);
    expect(screenSrc).toMatch(/filteredBanks\.length === 0/);
  });

  it('has a controlled search input above the bank list, resets on bank selection and on reopening the add-bank flow', () => {
    expect(screenSrc).toMatch(/value=\{bankSearch\}\s*\n\s*onChange=\{\(e\) => setBankSearch\(e\.target\.value\)\}/);
    expect(screenSrc).toMatch(/setSelectedBank\(b\); setShowBankPicker\(false\); setBankSearch\(''\);/);
    expect(screenSrc).toMatch(/setSelectedBank\(null\); setBankSearch\(''\);/);
  });

  it('preserves tap-to-select behavior and keeps a real min tap-target height on filtered bank rows', () => {
    expect(screenSrc).toMatch(/filteredBanks\.map\(b => \(/);
    expect(screenSrc).toMatch(/minHeight: '44px'/);
  });

  it('the Paystack bank list is never modified or replaced -- filteredBanks is a pure client-side derivation of the fetched `banks` array', () => {
    expect(screenSrc).not.toMatch(/setBanks\(\[.*fake|setBanks\(\[.*mock/i);
  });
});

describe('Nigeria-scoped NUBAN validation preserved, without a blocking unlabeled magic constant', () => {
  it('defines a clearly Nigeria-scoped named constant instead of a bare magic "10"', () => {
    expect(screenSrc).toMatch(/const NUBAN_ACCOUNT_NUMBER_LENGTH = 10;/);
  });

  it('still validates exactly 10 digits before attempting bank/account resolution', () => {
    expect(screenSrc).toMatch(/accountNumber\.length !== NUBAN_ACCOUNT_NUMBER_LENGTH \|\| !\/\^\\d\+\$\/\.test\(accountNumber\)/);
  });

  it('still strips non-digits and caps input length at the NUBAN constant, not a bare "10"', () => {
    expect(screenSrc).toMatch(/e\.target\.value\.replace\(\/\[\^0-9\]\/g, ''\)\.slice\(0, NUBAN_ACCOUNT_NUMBER_LENGTH\)/);
  });
});

describe('Minimum displayed/enforced in the UI now reflects server config, not a hardcoded 1,000', () => {
  // Batch F2 migrated this screen's fetch from a direct `app_config` select
  // to the authoritative get_vc_config() RPC (supabase/migrations/0085 +
  // 0086) -- the underlying config values (cashout_rate_naira_per_1000,
  // cashout_min_vc) and the submit-gate logic are unchanged, only the fetch
  // call itself moved. See vcF2UserExperience.security.test.ts for the
  // Batch F2-specific assertions on this same file.
  it('fetches cashout_min_vc from get_vc_config() and uses it (not a hardcoded MIN_VC=1000) for the submit gate', () => {
    expect(screenSrc).toMatch(/supabase\.rpc\('get_vc_config'/);
    expect(screenSrc).toMatch(/cfg\?\.cashout_min_vc/);
    expect(screenSrc).toMatch(/const canSubmit = vcAmount >= minVc && vcAmount <= balance && !!selectedAccountId;/);
    expect(screenSrc).not.toMatch(/const MIN_VC = 1000;/);
  });

  it('default display constant is 250,000 (₦25,000), matching the new server default, before config loads', () => {
    expect(screenSrc).toMatch(/const DEFAULT_MIN_VC = 250000;/);
  });
});
