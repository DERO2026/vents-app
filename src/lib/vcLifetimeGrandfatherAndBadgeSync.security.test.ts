import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents: one-time Lifetime VC grandfather for existing legitimate
// customer accounts (new_lifetime = GREATEST(old_lifetime, spendable)),
// plus the vc_badge display-sync fix this exposed: several screens
// (ProfileScreen, UserProfileScreen, HomeScreen, ExploreScreen,
// ConversationScreen) display the legacy users.vc_badge column directly
// rather than calling vc_tier_and_multiplier_for_user(), so raising
// vc_lifetime_earned alone would have left those screens showing a stale
// tier while VENTS Cents correctly showed the new one. Fixed by having
// award_vc_reward()/admin_credit_vents_cents() refresh vc_badge (via the
// existing vc_tier_for_lifetime() function -- no second tier calculation
// system) in the same statement as every future lifetime change, plus a
// one-time backfill scoped to exactly the grandfathered accounts.
//
// Live-verified against project slrtjxtzhowhwhebjprv:
//   - Dry run and real apply matched exactly: fc45414e (dero) 100,000 ->
//     398,700 lifetime (spendable was higher), tier/multiplier now
//     ('legend', 3.00) via vc_tier_and_multiplier_for_user, vc_badge now
//     'legend' (was stale 'gold'). 838beb9c/711b8a48/00a75bc6 moved from 0
//     lifetime to their spendable balances (350/250/100), all still below
//     Bronze's 500 threshold -- tier/vc_badge correctly null, not an error.
//   - Admin (c9eb5eb6), sub-admins (dfca505f, a4402494), and the three
//     identified test accounts (testerboy, testerboy2, vt_test_a_zk9x4)
//     all confirmed with vc_lifetime_earned unchanged at 0 after the
//     migration -- the exclusion list worked.
//   - admin_get_vc_pool_status() unchanged before/after both migrations:
//     pool_balance 899,401,160, total_user_vc_outstanding 100,587,940 --
//     this reconciliation moved no VC and touched neither the pool nor the
//     1,000,000,000 supply.

let m0150: string;
let m0151: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0150 = readFileSync(join(dir, '0150_vc_lifetime_grandfather_existing_customer_balances.sql'), 'utf8');
  m0151 = readFileSync(join(dir, '0151_vc_badge_display_sync_with_authoritative_tier.sql'), 'utf8');
});

describe('0150: Lifetime VC grandfather uses GREATEST (never lowers, idempotent if rerun)', () => {
  it('computes new_lifetime as GREATEST(old_lifetime, spendable), not an unconditional overwrite or addition', () => {
    expect(m0150).toMatch(/v_new_lifetime := GREATEST\(v_old_lifetime, v_spendable\);/);
  });

  it('never touches vents_wallets (spendable balance), vc_transactions, the system pool, or the 1B supply', () => {
    expect(m0150).not.toMatch(/UPDATE public\.vents_wallets/);
    expect(m0150).not.toMatch(/INSERT INTO public\.vc_transactions/);
    expect(m0150).not.toMatch(/vc_system_pool|_vc_pool_move/);
    expect(m0150).not.toMatch(/1000000000/);
  });

  it('excludes the house admin account, both sub-admin accounts, and the three identified test accounts by explicit id, not by a role/pattern filter alone', () => {
    const includedBlock = m0150.match(/v_included_ids uuid\[\] := ARRAY\[[\s\S]*?\]::uuid\[\];/)?.[0] ?? '';
    for (const excludedId of [
      'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', // house admin
      'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc', // sub-admin
      'a4402494-d7a0-4537-a83c-362fe71ec44f', // sub-admin
      '91b0afb4-b5dc-4289-ae00-8e6e58c60f5f', // testerboy
      '857d7606-f866-4895-864a-a39ea38b2aa3', // testerboy2
      '7af13434-47ce-4032-93df-2fb271b05e18', // vt_test_a_zk9x4
    ]) {
      expect(includedBlock).not.toContain(excludedId);
    }
  });

  it('includes exactly the four identified ordinary customer accounts', () => {
    const includedBlock = m0150.match(/v_included_ids uuid\[\] := ARRAY\[[\s\S]*?\]::uuid\[\];/)?.[0] ?? '';
    for (const includedId of [
      'fc45414e-6aef-494f-bbb4-b373dac5196b',
      '838beb9c-5ec6-455b-9420-295b8007358e',
      '711b8a48-f06d-479f-9191-2fb33c76f291',
      '00a75bc6-097a-40a6-96d5-966fdc54dc1f',
    ]) {
      expect(includedBlock).toContain(includedId);
    }
  });

  it('writes a structured audit trail row (account, old/spendable/new, reason, timestamp) with a per-user uniqueness guard against double-application', () => {
    expect(m0150).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_lifetime_grandfather_log/);
    for (const col of ['user_id', 'old_lifetime_vc', 'spendable_vc_used', 'new_lifetime_vc', 'reason', 'created_at']) {
      expect(m0150).toContain(col);
    }
    expect(m0150).toMatch(/UNIQUE \(user_id\)/);
    expect(m0150).toMatch(/ON CONFLICT \(user_id\) DO NOTHING/);
  });

  it('locks each row (FOR UPDATE OF u) before computing GREATEST, so a concurrent rerun cannot race past a stale read', () => {
    expect(m0150).toMatch(/FOR UPDATE OF u/);
  });
});

describe('0151: vc_badge stays in sync with the one authoritative tier function, no second calculation system', () => {
  it('award_vc_reward sets vc_badge via the existing vc_tier_for_lifetime() function, in the same UPDATE as vc_lifetime_earned', () => {
    const fn = m0151.match(/CREATE OR REPLACE FUNCTION public\.award_vc_reward[\s\S]*?\$function\$;/)?.[0] ?? '';
    const updateStmt = fn.match(/UPDATE public\.users[\s\S]*?WHERE id = p_user_id;/)?.[0] ?? '';
    expect(updateStmt).toMatch(/vc_lifetime_earned = vc_lifetime_earned \+ v_amount/);
    expect(updateStmt).toMatch(/vc_badge = public\.vc_tier_for_lifetime\(vc_lifetime_earned \+ v_amount\)/);
  });

  it('admin_credit_vents_cents sets vc_badge the same way, only on the counts_toward_lifetime branch', () => {
    const fn = m0151.match(/CREATE OR REPLACE FUNCTION public\.admin_credit_vents_cents[\s\S]*?\$function\$;/)?.[0] ?? '';
    const branch = fn.match(/IF p_counts_toward_lifetime THEN[\s\S]*?END IF;/)?.[0] ?? '';
    expect(branch).toMatch(/vc_badge = public\.vc_tier_for_lifetime\(vc_lifetime_earned \+ v_amount\)/);
  });

  it('no new tier-threshold or multiplier logic is introduced -- only calls to the existing vc_tier_for_lifetime function', () => {
    expect(m0151).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.vc_tier_for_lifetime/);
    expect(m0151).not.toMatch(/CASE WHEN.*>=.*500/);
  });

  it('the one-time vc_badge backfill is scoped to exactly the four grandfathered accounts, not a blanket UPDATE over all users', () => {
    const backfill = m0151.match(/UPDATE public\.users\s*\n\s*SET vc_badge = public\.vc_tier_for_lifetime\(vc_lifetime_earned\)[\s\S]*?;/)?.[0] ?? '';
    expect(backfill).toMatch(/WHERE id IN \(/);
    for (const includedId of [
      'fc45414e-6aef-494f-bbb4-b373dac5196b',
      '838beb9c-5ec6-455b-9420-295b8007358e',
      '711b8a48-f06d-479f-9191-2fb33c76f291',
      '00a75bc6-097a-40a6-96d5-966fdc54dc1f',
    ]) {
      expect(backfill).toContain(includedId);
    }
    expect(backfill).not.toContain('c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832');
  });
});

describe('Frontend tier/badge displays all read from a column kept in sync server-side -- no client-side recomputation', () => {
  const componentsDir = join(__dirname, '..', 'app', 'components');
  const screensWithBadgeChip = ['ProfileScreen.tsx', 'UserProfileScreen.tsx', 'HomeScreen.tsx', 'ExploreScreen.tsx', 'ConversationScreen.tsx'];

  for (const file of screensWithBadgeChip) {
    it(`${file} renders <BadgeChip> from a fetched vc_badge value, not a locally computed tier`, () => {
      const src = readFileSync(join(componentsDir, file), 'utf8');
      expect(src).toMatch(/<BadgeChip tier=\{/);
      // None of these files should contain their own tier-threshold table --
      // confirms there is exactly one place thresholds live (vc_badge_tiers,
      // read by ReferralScreen/VentsCentsInfoModal/AdminVCScreen only).
      expect(src).not.toMatch(/500.*1500.*4000.*8000.*15000.*30000/s);
    });
  }

  it('ReferralScreen (VENTS Cents) and AdminVCScreen derive tier live from the authoritative RPCs, not from vc_badge', () => {
    const referral = readFileSync(join(componentsDir, 'ReferralScreen.tsx'), 'utf8');
    const admin = readFileSync(join(componentsDir, 'admin', 'AdminVCScreen.tsx'), 'utf8');
    expect(referral).toMatch(/vc_tier_and_multiplier_for_user/);
    expect(admin).toMatch(/admin_get_user_vc_summary/);
  });
});
