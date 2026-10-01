import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents economy refactor, Batch D ("Lifetime Badge/Tier Migration"):
// retires the old purchased-badge economy (purchase_badge()) without
// deleting or downgrading any historical badge data, and confirms the new
// lifetime-earned tier system (Batch A) is and remains the sole authority
// for a user's active VENTS Cents tier/multiplier. No thresholds,
// multipliers, referral logic, check-in reward logic, cash-out, wallet
// conversion, ticket redemption, or frontend code were touched.
//
// Pre-migration audit (production, project slrtjxtzhowhwhebjprv):
// total_users=42. Legacy vc_badge distribution: 36 none, 2 bronze, 1 gold,
// 1 platinum, 1 elite, 1 legend. All 6 badge holders have
// vc_lifetime_earned=0 (new tier = NULL, below Bronze) -- every one of
// them would show no active tier under the new system, which is exactly
// why their legacy badge history must be preserved separately rather than
// silently lost. vc_bonuses already contains a complete, timestamped,
// append-only purchase/upgrade history (bonus_type='badge_<tier>', 6 rows
// total, including one user's gold->legend upgrade as two separate rows)
// -- this already-existing table is the "separate legacy badge-history
// representation" the product decision called for; no new table was
// created, and neither users.vc_badge nor vc_bonuses was modified by this
// migration.
//
// Live-verified against production (every destructive statement run
// inside a rolled-back transaction; production confirmed clean
// afterward -- still 6 users with a legacy badge, still 6 badge_* rows in
// vc_bonuses, still 0 users with nonzero vc_lifetime_earned):
//   - calling purchase_badge() as an authenticated user now raises
//     "Badge purchases have been retired..." and performs zero side
//     effects: vc_badge unchanged, no new vc_bonuses row, (and by
//     construction of the new function body) no VC deduction and no call
//     to award_vc_reward or any lifetime-earned path.
//   - vc_tier_for_lifetime()/vc_multiplier_for_tier() return the exact
//     expected tier and multiplier at every boundary: 0 and 499 -> no
//     tier (1.0x default); 500/1,499 -> bronze (1.00x); 1,500/3,999 ->
//     silver (1.10x); 4,000/7,999 -> gold (1.25x); 8,000/14,999 ->
//     platinum (1.50x); 15,000/29,999 -> elite (2.00x); 30,000 -> legend
//     (3.00x) -- thresholds and multipliers are unchanged from the
//     already-approved Batch A values.
//   - spend invariance: a user seeded to Gold (5,000 lifetime VC) who
//     then has a 4,500 VC 'spend' transaction recorded still reads back
//     tier=gold, multiplier=1.25, lifetime_earned=5,000 from
//     vc_tier_and_multiplier_for_user() afterward -- spending current VC
//     provably cannot lower lifetime-earned, tier, or multiplier.
//   - as the `authenticated` role, a direct UPDATE to users.vc_badge
//     failed with "vc_badge can only be changed via purchase_badge()"
//     (protect_trust_signal_columns(), unchanged); a direct UPDATE to
//     vc_lifetime_earned failed with "vc_lifetime_earned can only be
//     changed via award_vc_reward()" -- both trust-signal protections
//     from Batch A remain fully intact and were not weakened by this
//     migration.
//   - purchase_badge grants are unchanged: still EXECUTE for
//     authenticated/postgres/project_admin, still REVOKEd from anon --
//     no privilege regression, since the function's grants were never
//     touched, only its body.

let m0145: string;

beforeAll(() => {
  m0145 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0145_vc_retire_purchase_badge.sql'), 'utf8');
});

describe('purchase_badge is retired without deleting or weakening anything', () => {
  it('always raises -- no code path can set vc_badge, deduct VC, or insert a vc_bonuses row', () => {
    const fn = m0145.match(/CREATE OR REPLACE FUNCTION public\.purchase_badge[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/RAISE EXCEPTION 'Badge purchases have been retired\./);
    expect(fn).not.toMatch(/UPDATE public\.users SET vc_badge/);
    expect(fn).not.toMatch(/INSERT INTO public\.vc_bonuses/);
    expect(fn).not.toMatch(/_vc_deduct/);
    expect(fn).not.toMatch(/award_vc_reward/);
    expect(fn).not.toMatch(/vc_lifetime_earned/);
  });

  it('still checks authentication before raising, matching its prior error-handling shape', () => {
    const fn = m0145.match(/CREATE OR REPLACE FUNCTION public\.purchase_badge[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;/);
  });

  it('does not touch protect_trust_signal_columns, vc_badge_tiers, or any tier/multiplier function, and alters no thresholds/multipliers', () => {
    const sqlOnly = m0145.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(sqlOnly).not.toMatch(/CREATE OR REPLACE FUNCTION public\.protect_trust_signal_columns/);
    expect(sqlOnly).not.toMatch(/CREATE TABLE/);
    expect(sqlOnly).not.toMatch(/vc_tier_for_lifetime|vc_multiplier_for_tier|vc_tier_and_multiplier_for_user/);
    expect(sqlOnly).not.toMatch(/vc_badge_tiers/);
    expect(sqlOnly).not.toMatch(/UPDATE public\.vc_reward_campaigns/);
  });
});
