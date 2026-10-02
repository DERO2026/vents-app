import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents -- FINAL Lifetime VC rule (migration 0154), superseding the
// prior admin/sub-admin/house exclusion from migration 0150 per an explicit
// product decision: every existing account's spendable VC must be folded
// into its Lifetime VC, with no role exception and no cap, via
// new_lifetime = GREATEST(existing_lifetime, current_spendable).
//
// Applied live against slrtjxtzhowhwhebjprv and reconfirmed via its own
// audit table (vc_lifetime_final_reconciliation_log): 6 accounts changed
// (house admin "vents" 0->99,999,350/Legend/3.00x; sub-admin
// "ventsofficial" 0->188,250/Legend/3.00x; sub-admin
// blessingjackson442@gmail.com 0->200; three test accounts). The house
// account's balance is known pre-architecture test data, not earned --
// this is an intentional, documented consequence of the product decision,
// not an oversight. admin_get_vc_pool_status() unchanged by this migration
// (pool_balance 899,401,160 / total_user_vc_outstanding 100,500,940 /
// total_supply 1,000,000,000) since it only rewrites a running high-water
// mark counter, moving no VC.

let m0154: string;
let award: string;
let adminCredit: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0154 = readFileSync(join(migrationsDir, '0154_vc_lifetime_final_reconciliation_all_accounts.sql'), 'utf8');
  award = readFileSync(join(migrationsDir, '0151_vc_badge_display_sync_with_authoritative_tier.sql'), 'utf8');
  adminCredit = award;
});

describe('Migration 0154: applies GREATEST(existing, spendable) with no role exception and no cap', () => {
  it('uses GREATEST, never overwrites or reduces an existing higher lifetime value', () => {
    expect(m0154).toMatch(/GREATEST\(u\.vc_lifetime_earned, COALESCE\(w\.balance, 0\)\)/);
    expect(m0154).not.toMatch(/LEAST\(/);
  });

  it('is scoped to accounts whose spendable VC exceeds lifetime, not a blanket UPDATE of every row', () => {
    expect(m0154).toMatch(/WHERE COALESCE\(w\.balance, 0\) > u\.vc_lifetime_earned/);
  });

  it('contains no role-based WHERE/exclusion clause -- the whole point of this migration is no role exception', () => {
    const applyBlock = m0154.slice(m0154.indexOf('INSERT INTO public.vc_lifetime_final_reconciliation_log'), m0154.indexOf('UPDATE public.users'));
    expect(applyBlock).not.toMatch(/role\s*(!?=|NOT IN|<>)/);
    expect(applyBlock).not.toMatch(/WHERE id NOT IN/);
  });

  it('contains no artificial cap (no MIN() or hardcoded ceiling on the resulting lifetime value)', () => {
    expect(m0154).not.toMatch(/LEAST\(.*vc_lifetime_earned/);
  });

  it('derives tier and multiplier only from the existing authoritative functions, not a new calculation', () => {
    expect(m0154).toMatch(/public\.vc_tier_for_lifetime\(/);
    expect(m0154).toMatch(/public\.vc_multiplier_for_tier\(/);
    expect(m0154).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(m0154).not.toMatch(/CASE WHEN.*multiplier/i);
  });
});

describe('Migration 0154: touches only vc_lifetime_earned/vc_badge, moves no VC', () => {
  it('does not write to vents_wallets, vc_transactions, vc_system_pool, or vc_pool_ledger', () => {
    const codeOnly = m0154.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(codeOnly).not.toMatch(/UPDATE public\.vents_wallets/);
    expect(codeOnly).not.toMatch(/INSERT INTO public\.vc_transactions/);
    expect(codeOnly).not.toMatch(/vc_system_pool|vc_pool_ledger/);
  });

  it('only UPDATEs public.users, setting vc_lifetime_earned and vc_badge', () => {
    const updateMatch = m0154.match(/UPDATE public\.users u[\s\S]*?SET ([\s\S]*?)FROM/);
    expect(updateMatch).toBeTruthy();
    expect(updateMatch![1]).toMatch(/vc_lifetime_earned = log\.lifetime_after/);
    expect(updateMatch![1]).toMatch(/vc_badge = log\.resulting_tier/);
  });
});

describe('Migration 0154: idempotent, cannot silently re-run with a different snapshot', () => {
  it('guards the whole body behind a one-time check against its own audit table having rows', () => {
    expect(m0154).toMatch(/SELECT EXISTS\(SELECT 1 FROM public\.vc_lifetime_final_reconciliation_log\) INTO v_already_run/);
    expect(m0154).toMatch(/IF v_already_run THEN[\s\S]*?RETURN;\s*\n\s*END IF;/);
  });

  it('creates the audit table with CREATE TABLE IF NOT EXISTS, safe to re-run the migration file itself', () => {
    expect(m0154).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_lifetime_final_reconciliation_log/);
  });

  it('the audit table records the full before/after required fields for every changed account', () => {
    const tableMatch = m0154.match(/CREATE TABLE IF NOT EXISTS public\.vc_lifetime_final_reconciliation_log \(([\s\S]*?)\);/);
    expect(tableMatch).toBeTruthy();
    for (const col of ['user_id', 'username', 'role', 'spendable_before', 'lifetime_before', 'lifetime_after', 'resulting_tier', 'resulting_multiplier']) {
      expect(tableMatch![1]).toContain(col);
    }
  });
});

describe('Future earning paths remain unchanged by this migration (one-time reconciliation only)', () => {
  it('award_vc_reward still gates lifetime increase behind vc_reward_campaigns.counts_toward_lifetime', () => {
    expect(award).toMatch(/IF v_campaign\.counts_toward_lifetime THEN/);
  });

  it('migration 0154 does not redefine award_vc_reward or admin_credit_vents_cents', () => {
    expect(m0154).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.(award_vc_reward|admin_credit_vents_cents)/);
  });
});
