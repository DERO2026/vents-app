import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// WHAT THESE TESTS VERIFY, AND WHAT THEY DO NOT.
//
// Static analysis of the shipped migration SQL, matching the house pattern
// (serviceProviderKyc.security.test.ts, walletRefundFeeLedger.security.test.ts).
// This repo has NO live Postgres harness, so:
//
//   VERIFIED     — the archive/ordering/clamping/idempotency logic is
//                  literally encoded in the SQL that ships, and the
//                  statements appear in the required order.
//   NOT VERIFIED — that Postgres produces specific row counts or balances at
//                  runtime. Assertions about "a second run is a no-op" or
//                  "balance never goes negative" are assertions about the
//                  GUARD being present and correctly shaped, not about an
//                  executed result.
//
// Where a test claims an ordering property, it does so by comparing the
// character offsets of the statements in the migration text — that is a real
// structural property of the file, not an inferred one.

let m88: string;
let m09: string;

// The cleanup DO block, isolated so ordering assertions cannot accidentally
// match text elsewhere in the file.
let dedupBlock: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m88 = readFileSync(join(dir, '0086_referral_rate_limit_and_vc_dedup.sql'), 'utf8');
  m09 = readFileSync(join(dir, '0009_triggers.sql'), 'utf8');
  dedupBlock = m88.match(/DO \$dedup\$[\s\S]*?\$dedup\$;/)?.[0] ?? '';
});

// (A) ─────────────────────────────────────────────────────────────────
describe('(A) duplicates are archived BEFORE deletion', () => {
  it('an immutable archive table exists for the removed rows', () => {
    expect(m88).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_earn_duplicate_archive \(/);
  });

  it('the archive INSERT physically precedes the DELETE in the cleanup block', () => {
    const archiveIdx = dedupBlock.indexOf('INSERT INTO public.vc_earn_duplicate_archive');
    const deleteIdx = dedupBlock.indexOf('DELETE FROM public.vc_transactions');
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(archiveIdx).toBeLessThan(deleteIdx);
  });

  it('the DELETE is restricted to rows this run actually archived', () => {
    // Not a blanket delete of "all duplicates" — it joins the archived set,
    // so an un-archived row can never be deleted.
    expect(dedupBlock).toMatch(/DELETE FROM public\.vc_transactions t\s*\n\s*USING _vc_archived a\s*\n\s*WHERE t\.id = a\.transaction_id;/);
  });

  it('the debit also precedes the delete', () => {
    const debitIdx = dedupBlock.indexOf('UPDATE public.vents_wallets w');
    const deleteIdx = dedupBlock.indexOf('DELETE FROM public.vc_transactions');
    expect(debitIdx).toBeGreaterThan(-1);
    expect(debitIdx).toBeLessThan(deleteIdx);
  });
});

// (B) ─────────────────────────────────────────────────────────────────
describe('(B) the exact affected rows are recoverable from the archive', () => {
  it('archives the full ledger row, not a summary', () => {
    for (const col of [
      'transaction_id', 'user_id', 'amount', 'type', 'status',
      'reference_id', 'earned_at', 'expires_at', 'created_at',
    ]) {
      expect(m88, `archive missing column ${col}`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
  });

  it('records WHY each row was classified as a duplicate, and what was kept instead', () => {
    expect(m88).toMatch(/kept_transaction_id\s+uuid\s+NOT NULL/);
    expect(m88).toMatch(/duplicate_rank\s+integer\s+NOT NULL/);
    expect(m88).toMatch(/dedup_reason\s+text\s+NOT NULL/);
    expect(dedupBlock).toMatch(/duplicate type=earn award for the same \(user_id, reference_id\)/);
  });

  it('records the cleanup-run identifier and an archived-at timestamp', () => {
    expect(m88).toMatch(/cleanup_run_id\s+uuid\s+NOT NULL/);
    expect(m88).toMatch(/archived_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    expect(dedupBlock).toMatch(/v_run_id\s+uuid\s+:= gen_random_uuid\(\);/);
  });

  it('records whether the row had actually been credited to the wallet', () => {
    expect(m88).toMatch(/was_credited\s+boolean\s+NOT NULL/);
    // Mirrors trg_sync_vc_to_wallet's own condition.
    expect(dedupBlock).toMatch(/\(r\.type = 'earn' AND r\.status = 'active'\)/);
  });

  it('the archive is protected like admin_logs: RLS on, no policies, no client grants', () => {
    expect(m88).toMatch(/ALTER TABLE public\.vc_earn_duplicate_archive ENABLE ROW LEVEL SECURITY;/);
    expect(m88).not.toMatch(/CREATE POLICY[^;]*vc_earn_duplicate_archive/);
    const grants = m88.match(/GRANT[^;]*ON public\.vc_earn_duplicate_archive TO [^;]*;/g) ?? [];
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g).not.toMatch(/\banon\b/);
      expect(g).not.toMatch(/\bauthenticated\b/);
    }
  });

  it('no actor value on the archive is client-supplied', () => {
    expect(m88).not.toMatch(/p_admin_id|p_actor_id|p_actor_role/);
  });
});

// (C) ─────────────────────────────────────────────────────────────────
describe('(C) the ACTUAL reclaim amount is reported, not the intended amount', () => {
  it('reclaimed is clamped to the available balance before being applied', () => {
    expect(dedupBlock).toMatch(/LEAST\(p\.identified, COALESCE\(w\.balance, 0\)\)::bigint\s+AS reclaimed/);
  });

  it('identified, reclaimed and unreclaimed are three distinct stored figures', () => {
    expect(m88).toMatch(/vc_identified\s+bigint\s+NOT NULL/);
    expect(m88).toMatch(/vc_reclaimed\s+bigint\s+NOT NULL/);
    expect(m88).toMatch(/vc_unreclaimed\s+bigint\s+NOT NULL/);
  });

  it('the summary log reports the real delta, not the intended one', () => {
    expect(dedupBlock).toMatch(/'vc_identified',\s+v_identified/);
    expect(dedupBlock).toMatch(/'vc_actually_reclaimed',\s+v_reclaimed/);
    expect(dedupBlock).toMatch(/'vc_unreclaimed_insufficient_balance', v_unreclaimed/);
    // The old, dishonest key must be gone.
    expect(m88).not.toMatch(/vc_reclaimed_from_balances/);
  });

  it('the debit applies the clamped figure, not the raw identified sum', () => {
    expect(dedupBlock).toMatch(/SET balance\s+= GREATEST\(0, w\.balance - r\.reclaimed\)::integer/);
    expect(dedupBlock).not.toMatch(/w\.balance - r\.identified/);
    expect(dedupBlock).not.toMatch(/w\.balance - p\.amt/);
  });

  it('a DB-level CHECK makes dishonest accounting unstorable', () => {
    expect(m88).toMatch(/CHECK \(vc_reclaimed >= 0 AND vc_unreclaimed >= 0 AND vc_reclaimed \+ vc_unreclaimed = vc_identified\)/);
    expect(m88).toMatch(/CHECK \(balance_after >= 0 AND balance_after = balance_before - vc_reclaimed\)/);
  });
});

// (D) ─────────────────────────────────────────────────────────────────
describe('(D) insufficient balance never goes negative, and is still tracked', () => {
  it('the GREATEST(0, ...) clamp is retained as a structural guard', () => {
    expect(dedupBlock).toMatch(/GREATEST\(0, w\.balance - r\.reclaimed\)/);
  });

  it('the unreclaimable remainder is computed and stored, not discarded', () => {
    expect(dedupBlock).toMatch(/\(p\.identified - LEAST\(p\.identified, COALESCE\(w\.balance, 0\)\)\)::bigint AS unreclaimed/);
    expect(dedupBlock).toMatch(/INSERT INTO public\.vc_earn_duplicate_reclaim \([\s\S]*?vc_unreclaimed/);
  });

  it('a user with no wallet row at all is handled without error and fully tracked', () => {
    // LEFT JOIN + COALESCE(balance,0): identified stays, reclaimed = 0,
    // unreclaimed = identified. wallet_existed records the distinction.
    expect(dedupBlock).toMatch(/LEFT JOIN public\.vents_wallets w ON w\.user_id = p\.user_id;/);
    expect(dedupBlock).toMatch(/\(w\.user_id IS NOT NULL\)\s+AS wallet_existed/);
    expect(m88).toMatch(/wallet_existed\s+boolean\s+NOT NULL/);
  });

  it('users whose duplicates were never credited are archived but not debited', () => {
    // identified sums only was_credited rows; the UPDATE skips reclaimed = 0.
    expect(dedupBlock).toMatch(/FILTER \(WHERE a\.was_credited\)/);
    expect(dedupBlock).toMatch(/AND r\.reclaimed > 0;/);
  });
});

// (E) ─────────────────────────────────────────────────────────────────
describe('(E) the cleanup is idempotent under a second run', () => {
  it('the archive PK on the ORIGINAL transaction id is the idempotency gate', () => {
    expect(m88).toMatch(/CONSTRAINT vc_earn_duplicate_archive_pkey PRIMARY KEY \(transaction_id\)/);
    expect(dedupBlock).toMatch(/ON CONFLICT \(transaction_id\) DO NOTHING/);
  });

  it('only rows newly archived by THIS run drive the debit and delete', () => {
    // RETURNING feeds _vc_archived; an already-archived row returns nothing,
    // so it cannot be re-debited or re-deleted.
    expect(dedupBlock).toMatch(/RETURNING transaction_id, user_id, amount, status, was_credited/);
    expect(dedupBlock).toMatch(/CREATE TEMP TABLE _vc_archived ON COMMIT DROP AS/);
    const returningIdx = dedupBlock.indexOf('RETURNING transaction_id');
    const debitIdx = dedupBlock.indexOf('UPDATE public.vents_wallets w');
    expect(returningIdx).toBeLessThan(debitIdx);
  });

  it('a second run short-circuits before touching any balance', () => {
    const guard = dedupBlock.match(/IF v_dupes = 0 THEN[\s\S]*?END IF;/)?.[0] ?? '';
    expect(guard).toMatch(/RETURN;/);
    const guardIdx = dedupBlock.indexOf('IF v_dupes = 0 THEN');
    const debitIdx = dedupBlock.indexOf('UPDATE public.vents_wallets w');
    const logIdx = dedupBlock.indexOf('INSERT INTO public.admin_logs');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(debitIdx);
    // No summary row is written for a no-op run either.
    expect(guardIdx).toBeLessThan(logIdx);
  });

  it('the per-user reclaim row is also conflict-guarded', () => {
    expect(m88).toMatch(/CONSTRAINT vc_earn_duplicate_reclaim_pkey PRIMARY KEY \(cleanup_run_id, user_id\)/);
    expect(dedupBlock).toMatch(/ON CONFLICT \(cleanup_run_id, user_id\) DO NOTHING;/);
  });

  it('temp tables are dropped defensively so a manual re-run in one session is safe', () => {
    expect(dedupBlock).toMatch(/DROP TABLE IF EXISTS _vc_archived;/);
    expect(dedupBlock).toMatch(/DROP TABLE IF EXISTS _vc_recon;/);
  });

  it('the index creation is IF NOT EXISTS, so re-application is also a no-op', () => {
    expect(m88).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_earn_dedup_idx/);
  });
});

// (F) ─────────────────────────────────────────────────────────────────
describe('(F) the dry-run causes zero mutations', () => {
  it('exists as a separate read-only function, not a flag inside the migration', () => {
    expect(m88).toMatch(/CREATE OR REPLACE FUNCTION public\.vc_earn_duplicate_dryrun\(\)/);
  });

  it('is STABLE and contains no write statement of any kind', () => {
    const fn = m88.match(/CREATE OR REPLACE FUNCTION public\.vc_earn_duplicate_dryrun\(\)[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/STABLE SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
    for (const w of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'DROP ', 'CREATE TEMP', 'TRUNCATE']) {
      expect(fn, `dry-run must not contain ${w}`).not.toContain(w);
    }
  });

  it('reports the full blast radius including the unreclaimable portion', () => {
    const fn = m88.match(/CREATE OR REPLACE FUNCTION public\.vc_earn_duplicate_dryrun\(\)[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    for (const col of ['duplicate_rows', 'affected_users', 'vc_identified', 'vc_reclaimable', 'vc_unreclaimable']) {
      expect(fn, `missing ${col}`).toContain(col);
    }
  });

  it('is admin-gated and not reachable by anon', () => {
    const fn = m88.match(/CREATE OR REPLACE FUNCTION public\.vc_earn_duplicate_dryrun\(\)[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NOT public\.is_admin\(\) THEN RAISE EXCEPTION 'Admin access required'; END IF;/);
    const grant = m88.match(/GRANT EXECUTE ON FUNCTION public\.vc_earn_duplicate_dryrun\(\)[^;]*;/)?.[0] ?? '';
    expect(grant).toContain('authenticated');
    expect(grant).not.toContain('anon');
  });

  it('a standalone pre-migration query is documented for use before 0088 is applied', () => {
    // Must be runnable against a snapshot that has none of 0088's objects.
    const doc = m88.match(/TO ASSESS PRODUCTION \*BEFORE\*[\s\S]*?FROM per_user;/)?.[0] ?? '';
    expect(doc).not.toBe('');
    expect(doc).not.toContain('vc_earn_duplicate_archive');
    expect(doc).not.toContain('vc_earn_duplicate_dryrun');
    // And it must COALESCE the filtered sum, or it silently understates.
    expect(doc).toMatch(/COALESCE\(sum\(d\.amount\) FILTER \(WHERE d\.status = 'active'\), 0\)/);
  });
});

// (G) ─────────────────────────────────────────────────────────────────
describe('(G) the unique constraint prevents future duplicate rewards', () => {
  it('creates the partial unique index the dead ON CONFLICT clause needed', () => {
    expect(m88).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_earn_dedup_idx\s*\n\s*ON public\.vc_transactions \(user_id, reference_id\)\s*\n\s*WHERE \(type = 'earn' AND reference_id IS NOT NULL\);/);
  });

  it('the index is built in the same transaction as the cleanup (atomic pair)', () => {
    const cleanupIdx = m88.indexOf('DO $dedup$');
    const indexIdx = m88.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_earn_dedup_idx');
    expect(cleanupIdx).toBeLessThan(indexIdx);
    // CONCURRENTLY would abort inside the migration transaction.
    expect(m88).not.toMatch(/CREATE UNIQUE INDEX CONCURRENTLY vc_transactions_earn_dedup_idx\s*\n\s*ON public\.vc_transactions[\s\S]{0,200}?;\s*$/m);
  });

  it('the CONCURRENTLY constraint and the manual alternative are documented honestly', () => {
    expect(m88).toMatch(/cannot run inside a transaction block/i);
    expect(m88).toMatch(/ACCESS EXCLUSIVE LOCK/);
    expect(m88).toMatch(/is NOT a\s*\n--\s*zero-downtime statement/);
    // The documented fallback must include the invalid-index recovery step.
    expect(m88).toMatch(/indisvalid/);
    expect(m88).toMatch(/DROP INDEX CONCURRENTLY vc_transactions_earn_dedup_idx;/);
  });
});

// (H) ─────────────────────────────────────────────────────────────────
describe('(H) legitimate separate rewards are still granted', () => {
  it('two different tickets remain two separate awards (index keys on reference_id)', () => {
    // The index is (user_id, reference_id): distinct ticket ids never collide.
    expect(m88).toMatch(/ON public\.vc_transactions \(user_id, reference_id\)/);
  });

  it('admin credits stay unlimited — each uses a fresh uuid reference_id', () => {
    const m04 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0004_functions.sql'), 'utf8');
    const fn = m04.match(/CREATE OR REPLACE FUNCTION public\.admin_credit_vents_cents[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    expect(fn).toMatch(/'earn', 'active', gen_random_uuid\(\)/);
  });

  it("claim_profile_bonus is outside the index predicate (NULL reference_id)", () => {
    expect(m88).toMatch(/WHERE \(type = 'earn' AND reference_id IS NOT NULL\)/);
    const m04 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0004_functions.sql'), 'utf8');
    const fn = m04.match(/CREATE OR REPLACE FUNCTION public\.claim_profile_bonus[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    expect(fn).toMatch(/INSERT INTO public\.vc_transactions \(user_id, amount, type, status, earned_at\)/);
  });

  it('referral awards are untouched — different type, different index', () => {
    expect(m88).not.toMatch(/DROP INDEX[^;]*vc_transactions_referral_dedup_idx/);
    // The cleanup only ever scans type='earn'.
    expect(dedupBlock).toMatch(/WHERE t\.type = 'earn' AND t\.reference_id IS NOT NULL/);
    expect(dedupBlock).not.toMatch(/'referral'/);
  });

  it('the cleanup never touches a NULL-reference_id earn row', () => {
    expect(dedupBlock).toMatch(/t\.reference_id IS NOT NULL/);
  });
});

// (I) ─────────────────────────────────────────────────────────────────
describe('(I) wallet-sync behavior is unaffected for normal transactions', () => {
  it('the sync trigger itself is not modified by this migration', () => {
    // 0088 references trg_sync_vc_to_wallet by name in its comments (that is
    // the whole justification for debiting before deleting), so the real
    // assertion is that it emits no trigger DDL and does not redefine the
    // trigger function.
    expect(m88).not.toMatch(/CREATE TRIGGER/);
    expect(m88).not.toMatch(/DROP TRIGGER/);
    expect(m88).not.toMatch(/ALTER TABLE[^;]*(DISABLE|ENABLE) TRIGGER/);
    expect(m88).not.toMatch(/CREATE OR REPLACE FUNCTION public\.trg_sync_vc_to_wallet/);
  });

  it('the trigger fires on INSERT only, so the DELETE cannot double-reverse', () => {
    expect(m09).toMatch(/CREATE TRIGGER trg_vc_wallet_sync AFTER INSERT ON vc_transactions/);
    expect(m09).not.toMatch(/trg_vc_wallet_sync[^\n]*DELETE/);
  });

  it('the realtime trigger also never fires on DELETE', () => {
    expect(m09).toMatch(/CREATE TRIGGER trg_realtime_vc AFTER INSERT OR UPDATE ON vc_transactions/);
    expect(m09).not.toMatch(/trg_realtime_vc[^\n]*DELETE/);
  });

  it('only the duplicate rows are debited — the retained row keeps its credit', () => {
    // rn > 1 excludes the kept (earliest) row from both archive and debit.
    expect(dedupBlock).toMatch(/WHERE r\.rn > 1/);
    expect(dedupBlock).toMatch(/first_value\(t\.id\) OVER \(PARTITION BY t\.user_id, t\.reference_id/);
  });

  it('no other wallet table is touched by this migration', () => {
    expect(m88).not.toMatch(/user_wallets/);
    expect(m88).not.toMatch(/organizer_wallets/);
  });
});
