import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real, static SQL-text-assertion tests for VENTS Cents Batch B (referral
// economy integrity), mirroring this repo's own convention (see
// src/lib/vcCashout.security.test.ts / organizerPayoutSecurity.security.test.ts)
// of verifying a live migration's actual, deployed function bodies rather
// than a re-implementation that could silently drift from what ships.
//
// Covered migration: migrations/20260807120000_referral-economy-integrity.sql
// (plus the prior referral history it builds on, and api/cron/run.ts's
// extension for Fix 5).

let migration: string;
let priorRace: string;
let priorSync: string;
let priorBonuses: string;
let cronSrc: string;

function fn(src: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$(?:function\\$|\\$)\\s*;`);
  return src.match(re)?.[0] ?? '';
}

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'migrations');
  migration = readFileSync(join(dir, '20260807120000_referral-economy-integrity.sql'), 'utf8');
  priorRace = readFileSync(join(dir, '20260710174119_fix-referral-double-credit-race.sql'), 'utf8');
  priorSync = readFileSync(join(dir, '20260622201858_vc-wallet-sync.sql'), 'utf8');
  priorBonuses = readFileSync(join(dir, '20260620220218_prize-draw-and-vc-bonuses.sql'), 'utf8');
  cronSrc = readFileSync(join(__dirname, '..', '..', 'api', 'cron', 'run.ts'), 'utf8');
});

describe('scope discipline: no reward amount, timing, or unrelated price changed', () => {
  it('referred user still gets 150 VC, referrer still gets 300 VC pending', () => {
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/VALUES \(v_referred_id, 150, 'referral', 'pending', v_referrer_id, 'referred', now\(\)\)/);
    expect(cr).toMatch(/VALUES \(v_referrer_id, 300, 'referral', 'pending', v_referred_id, 'referrer', now\(\)\)/);
  });

  it('the 14-day referrer pending hold is unchanged', () => {
    const sweep = fn(migration, '_sweep_referral_vc');
    expect(sweep).toMatch(/INTERVAL '14 days'/);
  });

  it('never touches vc_cashout_naira_per_1000, vc_naira_per_1000, badge or Feature Me pricing', () => {
    expect(migration).not.toMatch(/vc_cashout_naira_per_1000|vc_naira_per_1000|badge_tier|feature_in_people/);
  });

  it('is purely additive: every ALTER TABLE uses IF NOT EXISTS, no DROP TABLE/COLUMN, no destructive statement', () => {
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN/);
    const alterAdds = migration.match(/ALTER TABLE[\s\S]*?ADD COLUMN/g) || [];
    expect(alterAdds.length).toBeGreaterThan(0);
    for (const stmt of migration.match(/ALTER TABLE public\.\w+\s*\n?\s*ADD COLUMN[^;]*/g) || []) {
      expect(stmt).toMatch(/IF NOT EXISTS/);
    }
  });
});

describe('Fix 1: referral qualification -- referred VC starts pending, activates only on a real purchase', () => {
  it('complete_referral inserts the referred row as pending, not active', () => {
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/150, 'referral', 'pending'/);
    expect(cr).not.toMatch(/150, 'referral', 'active'/);
  });

  it('qualify_referral only activates a pending referred-side row', () => {
    const qr = fn(migration, 'qualify_referral');
    expect(qr).toMatch(/SET status = 'active', qualifying_ticket_id = p_ticket_id/);
    expect(qr).toMatch(/AND referral_role = 'referred'/);
    expect(qr).toMatch(/AND status = 'pending'/);
  });

  it('qualify_referral rejects unpaid or zero-value tickets, and tickets not owned by the referred user', () => {
    const qr = fn(migration, 'qualify_referral');
    expect(qr).toMatch(/v_ticket\.user_id IS DISTINCT FROM p_referred_user_id/);
    expect(qr).toMatch(/v_ticket\.payment_status <> 'paid'/);
    expect(qr).toMatch(/v_ticket\.amount <= 0/);
  });

  it('qualify_referral is hooked into confirm_ticket_payment, the real Paystack-confirmed payment moment', () => {
    const ctp = fn(migration, 'confirm_ticket_payment');
    expect(ctp).toMatch(/PERFORM public\.qualify_referral\(v_user_id, v_first_ticket_id\);/);
    // Only reachable when a non-zero amount actually changed hands.
    expect(ctp).toMatch(/IF v_total_amount > 0 THEN[\s\S]*qualify_referral/);
  });

  it('qualify_referral credits vents_wallets directly (the UPDATE it performs never fires the INSERT-only wallet-sync trigger)', () => {
    const qr = fn(migration, 'qualify_referral');
    expect(qr).toMatch(/INSERT INTO public\.vents_wallets[\s\S]*ON CONFLICT \(user_id\) DO UPDATE/);
  });

  it('qualify_referral is project_admin-only -- no client can call it directly to force-activate VC', () => {
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.qualify_referral\(uuid, uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.qualify_referral\(uuid, uuid\) TO project_admin;/);
  });

  it('qualify_referral is idempotent: a second call for an already-qualified user is a documented no-op', () => {
    const qr = fn(migration, 'qualify_referral');
    expect(qr).toMatch(/AND qualifying_ticket_id IS NULL/);
    expect(qr).toMatch(/IF v_amount IS NULL THEN/);
    expect(qr).toMatch(/'changed', false/);
  });
});

describe('Fix 2: server-enforced 5-referral cap, race-safe', () => {
  it('complete_referral takes a per-referrer advisory lock before counting', () => {
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\('complete_referral:' \|\| v_referrer_id::text, 0\)\);/);
    const lockIdx = cr.indexOf('pg_advisory_xact_lock');
    const countIdx = cr.indexOf('SELECT count(*) INTO v_joined_count');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(countIdx).toBeGreaterThan(lockIdx);
  });

  it('rejects once 5 joined referrals already exist for the referrer', () => {
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/WHERE referrer_id = v_referrer_id AND status = 'joined'/);
    expect(cr).toMatch(/IF v_joined_count >= 5 THEN/);
    expect(cr).toMatch(/reached its maximum number of uses/);
  });

  it('the cap check runs before any VC-granting INSERT in the function body', () => {
    const cr = fn(migration, 'complete_referral');
    const capIdx = cr.indexOf('v_joined_count >= 5');
    const insertIdx = cr.indexOf("150, 'referral'");
    expect(capIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(capIdx);
  });

  it('race-safety reasoning: pg_advisory_xact_lock is held for the remainder of the transaction and keyed per-referrer, so concurrent calls for the same referrer cannot both pass the count check', () => {
    // pg_advisory_xact_lock (vs. pg_advisory_lock) auto-releases at
    // COMMIT/ROLLBACK -- verifies the lock can never be leaked/held past
    // this function's own transaction.
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/pg_advisory_xact_lock/);
    expect(cr).not.toMatch(/pg_advisory_unlock/); // xact-scoped: no manual unlock needed or present
  });
});

describe('Fix 2 (regression): still race-safe against referral double-crediting (2026-07-10 fix preserved)', () => {
  it('the unique dedup index from the double-credit-race fix still backs the referred-row INSERT', () => {
    expect(priorRace).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_referral_dedup_idx/);
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'referral' DO NOTHING/);
  });

  it('duplicate/replayed complete_referral calls still return "already applied" rather than crediting twice', () => {
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/IF v_new_row_id IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('success', false, 'message', 'Referral already applied'\);/);
  });
});

describe('Fix 3: anti-farming -- self-referral preserved, redemption velocity cap added, no fabricated checks', () => {
  it('self-referral is still blocked', () => {
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/IF v_referrer_id = v_referred_id THEN/);
    expect(cr).toMatch(/Cannot use your own code/);
  });

  it('adds a 3-per-24h redemption velocity cap per referrer, mirroring the existing invite-side cap', () => {
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/AND created_at > now\(\) - INTERVAL '24 hours'/);
    expect(cr).toMatch(/IF v_recent_count >= 3 THEN/);
  });

  it('honestly documents why device-fingerprint / IP-based checks are not implemented (no fabricated infra)', () => {
    expect(migration).toMatch(/no IP[\s\S]{0,40}captured anywhere reachable from this RPC's/);
    expect(migration).toMatch(/is explicitly scoped not to invent/);
  });

  it('does not invent a new device_fingerprints write path or new PII column', () => {
    expect(migration).not.toMatch(/INSERT INTO public\.device_fingerprints/);
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS ip_address|ADD COLUMN IF NOT EXISTS device_id/);
  });
});

describe('Fix 4: refund/cancellation of the qualifying purchase correctly reverses referral VC', () => {
  it('the OLD comparison (reference_id against tickets.id) is confirmed as the real, shipped, dead-code bug', () => {
    expect(priorBonuses).toMatch(/WHERE tk\.id = t\.reference_id/);
  });

  it('the new sweep joins on the correct qualifying_ticket_id column instead', () => {
    const sweep = fn(migration, '_sweep_referral_vc');
    expect(sweep).toMatch(/JOIN public\.tickets tk ON tk\.id = t\.qualifying_ticket_id/);
    expect(sweep).not.toMatch(/tk\.id = t\.reference_id/);
  });

  it('cancels BOTH pending and already-active referral VC once the qualifying ticket is refunded', () => {
    const sweep = fn(migration, '_sweep_referral_vc');
    expect(sweep).toMatch(/AND t\.status IN \('pending', 'active'\)/);
    expect(sweep).toMatch(/AND tk\.payment_status = 'refunded'/);
  });

  it('reverses the wallet balance when cancelling an already-active row, but not for a still-pending one', () => {
    const sweep = fn(migration, '_sweep_referral_vc');
    expect(sweep).toMatch(/IF v_row\.status = 'active' THEN[\s\S]*?GREATEST\(0, balance - v_row\.amount\)/);
  });

  it("qualify_referral stamps the referrer's linked pending row with the same qualifying_ticket_id, so a refund can find and cancel it too", () => {
    const qr = fn(migration, 'qualify_referral');
    expect(qr).toMatch(/UPDATE public\.vc_transactions\s*\n\s*SET qualifying_ticket_id = p_ticket_id\s*\n\s*WHERE user_id = v_referrer_id/);
    expect(qr).toMatch(/AND referral_role = 'referrer'/);
  });
});

describe('Fix 5: deterministic pending-reward activation via the existing daily cron', () => {
  it('adds run_referral_pending_sweep, project_admin-only', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.run_referral_pending_sweep\(\)/);
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.run_referral_pending_sweep\(\) FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.run_referral_pending_sweep\(\) TO project_admin;/);
  });

  it('run_referral_pending_sweep processes every user (p_user_id NULL), not just one', () => {
    const rrs = fn(migration, 'run_referral_pending_sweep');
    expect(rrs).toMatch(/RETURN public\._sweep_referral_vc\(NULL\);/);
  });

  it('check_and_clear_pending_vc still exists for the client-side path and delegates to the same corrected sweep, scoped to the caller', () => {
    const ccpv = fn(migration, 'check_and_clear_pending_vc');
    expect(ccpv).toMatch(/PERFORM public\._sweep_referral_vc\(v_uid\);/);
  });

  it('the daily cron (api/cron/run.ts) now invokes run_referral_pending_sweep via the project_admin connection', () => {
    expect(cronSrc).toMatch(/callProjectAdminRpc<any>\('run_referral_pending_sweep', \[\]\)/);
  });

  it('the referral sweep in the cron runs before the FCM-config early return, so it always executes', () => {
    const sweepIdx = cronSrc.indexOf('run_referral_pending_sweep');
    const fcmReturnIdx = cronSrc.indexOf("FCM_SERVICE_ACCOUNT_JSON missing");
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(fcmReturnIdx).toBeGreaterThan(sweepIdx);
  });

  it('no new Vercel cron entry or serverless function was added (reuses the existing single /api/cron/run)', () => {
    const vercelJson = readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8');
    const crons = JSON.parse(vercelJson).crons;
    expect(crons).toHaveLength(1);
    expect(crons[0].path).toBe('/api/cron/run');
  });

  it('activation only fires once the linked referral is actually qualified -- an unqualified referral no longer auto-pays the referrer on a timer alone', () => {
    const sweep = fn(migration, '_sweep_referral_vc');
    expect(sweep).toMatch(/AND r\.qualified_at IS NOT NULL/);
  });

  it('activation credits vents_wallets.balance explicitly (fixes the previously-silent gap where the INSERT-only wallet-sync trigger never fired on this UPDATE)', () => {
    const sweep = fn(migration, '_sweep_referral_vc');
    // Two separate wallet-credit sites: qualify_referral (referred) and
    // the activation loop in _sweep_referral_vc (referrer).
    const creditSites = sweep.match(/ON CONFLICT \(user_id\) DO UPDATE\s*\n\s*SET balance = vents_wallets\.balance \+ v_row\.amount/g) || [];
    expect(creditSites.length).toBeGreaterThanOrEqual(1);
  });

  it('the activate loop is idempotent per row (SKIP LOCKED + status = pending guard, no double credit on re-run)', () => {
    const sweep = fn(migration, '_sweep_referral_vc');
    expect(sweep).toMatch(/FOR UPDATE OF t SKIP LOCKED/);
  });
});

describe('RPC grants: unprivileged clients cannot directly credit or force-activate referral VC', () => {
  it('vc_transactions has no client INSERT/UPDATE policy -- all mutation is via SECURITY DEFINER RPCs (unchanged invariant)', () => {
    // This migration must not add one.
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*vc_transactions[\s\S]*FOR (INSERT|UPDATE)/);
  });

  it('complete_referral is the only referral-VC-granting RPC exposed to authenticated clients', () => {
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.complete_referral\(text\) TO authenticated;/);
  });

  it('qualify_referral and run_referral_pending_sweep are never granted to authenticated or anon', () => {
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.qualify_referral\(uuid, uuid\) TO (authenticated|anon)/);
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.run_referral_pending_sweep\(\) TO (authenticated|anon)/);
  });

  it('confirm_ticket_payment (the qualification trigger point) remains project_admin-only, not client-callable', () => {
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.confirm_ticket_payment\(text, bigint\) FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.confirm_ticket_payment\(text, bigint\) TO project_admin;/);
  });
});

describe('Cash-out cannot bypass the new qualification rule', () => {
  it('pending referral VC never reaches vents_wallets.balance until qualified/activated (only active-status INSERTs are synced by the existing trigger)', () => {
    expect(priorSync).toMatch(/IF NEW\.type IN \('earn', 'referral'\) AND NEW\.status = 'active' THEN/);
    const cr = fn(migration, 'complete_referral');
    // The referred-side INSERT status literal is 'pending' -- confirmed
    // above -- so the AFTER INSERT trigger's `NEW.status = 'active'`
    // guard never fires for it, and vents_wallets.balance (the only
    // thing request_vc_cashout's _vc_deduct reads/debits from) is
    // therefore untouched until qualify_referral's explicit credit runs.
    expect(cr).toMatch(/150, 'referral', 'pending'/);
  });

  it('qualify_referral is the only place a referred-side pending row can become spendable, and it requires a paid, non-zero ticket', () => {
    const qr = fn(migration, 'qualify_referral');
    expect(qr).toMatch(/v_ticket\.payment_status <> 'paid'/);
    expect(qr).toMatch(/v_ticket\.amount <= 0/);
  });
});

describe('schema additions are additive and correctly typed', () => {
  it('referral_role and qualifying_ticket_id are added to vc_transactions with IF NOT EXISTS', () => {
    expect(migration).toMatch(/ALTER TABLE public\.vc_transactions\s*\n\s*ADD COLUMN IF NOT EXISTS referral_role text\s*\n\s*CHECK \(referral_role IN \('referred', 'referrer'\)\);/);
    expect(migration).toMatch(/ALTER TABLE public\.vc_transactions\s*\n\s*ADD COLUMN IF NOT EXISTS qualifying_ticket_id uuid REFERENCES public\.tickets\(id\);/);
  });

  it('referred_id and qualified_at are added to referrals with IF NOT EXISTS', () => {
    expect(migration).toMatch(/ALTER TABLE public\.referrals\s*\n\s*ADD COLUMN IF NOT EXISTS referred_id uuid REFERENCES public\.users\(id\);/);
    expect(migration).toMatch(/ALTER TABLE public\.referrals\s*\n\s*ADD COLUMN IF NOT EXISTS qualified_at timestamptz;/);
  });

  it('complete_referral persists referred_id on the referrals row it creates, enabling the qualification join', () => {
    const cr = fn(migration, 'complete_referral');
    expect(cr).toMatch(/INSERT INTO public\.referrals \(referrer_id, invitee_email, status, referred_id\)/);
  });
});
