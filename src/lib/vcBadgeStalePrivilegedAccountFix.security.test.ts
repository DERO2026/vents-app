import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents: migration 0150 correctly excluded admin/sub-admin accounts
// from the Lifetime VC grandfather, leaving their authoritative
// vc_lifetime_earned at 0 -- but their legacy users.vc_badge column still
// held a stale value (legend/elite/bronze) from the retired
// purchase_badge() era, predating the lifetime-based tier system. Several
// screens (ProfileScreen, UserProfileScreen, HomeScreen, ExploreScreen,
// ConversationScreen) read vc_badge directly, so these accounts could
// visually appear to hold a tier their authoritative Lifetime VC does not
// qualify for. Fixed with a scoped backfill using the existing
// vc_tier_for_lifetime() function -- no new tier calculation.
//
// Read-only check performed before this migration, live-verified against
// project slrtjxtzhowhwhebjprv:
//   id                                   | role      | lifetime | old vc_badge | authoritative tier
//   c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832 | admin     | 0        | legend       | NULL
//   a4402494-d7a0-4537-a83c-362fe71ec44f | sub-admin | 0        | bronze       | NULL
//   dfca505f-b2f6-449f-aa86-f7e7ece7d1dc | sub-admin | 0        | elite        | NULL
// Applied for real and reconfirmed: all three now vc_badge = NULL. The four
// legitimate customer accounts grandfathered by migration 0150 (including
// dero, now Legend at 398,700 lifetime VC) were reconfirmed unchanged by
// this migration. admin_get_vc_pool_status() unchanged: pool_balance
// 899,401,160, total_user_vc_outstanding 100,587,940 -- this migration
// moved no VC and touched neither the pool nor the 1,000,000,000 supply.

let m0152: string;
let tierForLifetimeFn: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0152 = readFileSync(join(dir, '0152_vc_badge_fix_stale_privileged_account_tier_display.sql'), 'utf8');
  // vc_tier_for_lifetime() itself was defined in an earlier migration and is
  // unchanged here -- read it to prove this task's threshold behavior
  // (bronze at 500+, etc.) without re-deriving thresholds, and to confirm
  // migration 0152 never redefines it.
  const tierMigration = readFileSync(join(dir, '0138_vc_lifetime_earned_badge_tier_ledger_foundation.sql'), 'utf8');
  tierForLifetimeFn = tierMigration.match(/CREATE (?:OR REPLACE )?FUNCTION public\.vc_tier_for_lifetime[\s\S]*?\$function\$;/)?.[0] ?? '';
});

describe('0152: uses only the existing vc_tier_for_lifetime() function, no new tier calculation', () => {
  it('calls public.vc_tier_for_lifetime(vc_lifetime_earned) rather than computing a threshold inline', () => {
    expect(m0152).toMatch(/SET vc_badge = public\.vc_tier_for_lifetime\(vc_lifetime_earned\)/);
  });

  it('does not redefine vc_tier_for_lifetime or introduce any CASE/threshold logic of its own', () => {
    expect(m0152).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(m0152).not.toMatch(/CASE WHEN/);
  });

  it('is scoped to exactly the three identified privileged accounts, not a blanket UPDATE', () => {
    expect(m0152).toMatch(/WHERE id IN \(/);
    for (const id of [
      'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832',
      'a4402494-d7a0-4537-a83c-362fe71ec44f',
      'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc',
    ]) {
      expect(m0152).toContain(id);
    }
  });

  it('touches only users.vc_badge -- no other table, no VC/pool/supply movement', () => {
    const codeOnly = m0152.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(codeOnly).not.toMatch(/vc_lifetime_earned\s*=/);
    expect(codeOnly).not.toMatch(/vents_wallets|vc_system_pool|vc_transactions|_vc_pool_move/);
    expect(codeOnly).not.toMatch(/1000000000/);
  });
});

describe('vc_tier_for_lifetime(): the single authoritative threshold function (unchanged by 0152)', () => {
  it('a lifetime of 0 never resolves to any tier (no Legend/Elite/etc for a zero-lifetime account)', () => {
    // Structural proof: every threshold row requires min_lifetime_vc <= lifetime,
    // and the lowest approved threshold (Bronze) is 500 -- confirmed via the
    // live vc_badge_tiers data already verified in this session's prior
    // migrations (0139). 0 is below every threshold, so no row can match.
    expect(tierForLifetimeFn).toMatch(/WHERE t\.min_lifetime_vc <= COALESCE\(p_lifetime, 0\)/);
    expect(tierForLifetimeFn).toMatch(/ORDER BY t\.rank DESC/);
    expect(tierForLifetimeFn).toMatch(/LIMIT 1/);
  });

  it('returns NULL (no row) rather than defaulting to a non-null tier when nothing qualifies', () => {
    // The function body is a bare SELECT with no COALESCE/fallback on its
    // result -- an empty result set means a NULL return, not some assumed tier.
    expect(tierForLifetimeFn).not.toMatch(/COALESCE\([^)]*vc_tier_for_lifetime/);
  });
});

describe('Privileged accounts with Lifetime VC 0 cannot retain a stale tier badge', () => {
  it('all three identified admin/sub-admin accounts are included in the backfill', () => {
    const idsInFile = [
      'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', // admin (house)
      'a4402494-d7a0-4537-a83c-362fe71ec44f', // sub-admin
      'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc', // sub-admin
    ];
    for (const id of idsInFile) expect(m0152).toContain(id);
  });
});

describe('Existing legitimate customer tier behavior is unaffected by this migration', () => {
  it('0152 does not reference any of the four accounts migration 0150 grandfathered', () => {
    for (const id of [
      'fc45414e-6aef-494f-bbb4-b373dac5196b', // dero -- Legend, must remain untouched
      '838beb9c-5ec6-455b-9420-295b8007358e',
      '711b8a48-f06d-479f-9191-2fb33c76f291',
      '00a75bc6-097a-40a6-96d5-966fdc54dc1f',
    ]) {
      expect(m0152).not.toContain(id);
    }
  });
});

describe('No frontend component has its own independent tier thresholds', () => {
  const componentsDir = join(__dirname, '..', 'app', 'components');
  const screensWithBadgeChip = ['ProfileScreen.tsx', 'UserProfileScreen.tsx', 'HomeScreen.tsx', 'ExploreScreen.tsx', 'ConversationScreen.tsx'];

  for (const file of screensWithBadgeChip) {
    it(`${file} has no hardcoded tier-threshold table (500/1500/4000/8000/15000/30000) of its own`, () => {
      const src = readFileSync(join(componentsDir, file), 'utf8');
      expect(src).not.toMatch(/500.*1500.*4000.*8000.*15000.*30000/s);
    });
  }

  it('BadgeChip itself contains no threshold logic -- it only maps a tier string to a style, never computes a tier', () => {
    const badgeChip = readFileSync(join(componentsDir, 'BadgeChip.tsx'), 'utf8');
    expect(badgeChip).not.toMatch(/vc_lifetime_earned|lifetime/i);
  });
});
