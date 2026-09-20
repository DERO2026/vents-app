import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static source-assertion tests for VENTS Cents Batch F2 (user-facing VC
// help experience + ReferralScreen/VcCashoutScreen reconciliation),
// mirroring this repo's own convention (see vcConfig.security.test.ts,
// vcCashoutLimits.security.test.ts) of asserting against the actual shipped
// source rather than a re-implementation that could silently drift.

let referralSrc: string;
let cashoutSrc: string;
let helpModalSrc: string;
let migration0086: string;

beforeAll(() => {
  const componentsDir = join(__dirname, '..', 'app', 'components');
  referralSrc = readFileSync(join(componentsDir, 'ReferralScreen.tsx'), 'utf8');
  cashoutSrc = readFileSync(join(componentsDir, 'VcCashoutScreen.tsx'), 'utf8');
  helpModalSrc = readFileSync(join(componentsDir, 'VcHelpModal.tsx'), 'utf8');
  migration0086 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0086_vc_config_badge_tiers.sql'),
    'utf8'
  );
});

describe('ReferralScreen.tsx and VcCashoutScreen.tsx consume get_vc_config(), no hardcoded economy literals', () => {
  it('ReferralScreen.tsx calls get_vc_config() (via the shared useVcConfig hook)', () => {
    expect(referralSrc).toMatch(/useVcConfig/);
    expect(helpModalSrc).toMatch(/supabase\.rpc\('get_vc_config'/);
  });

  it('VcCashoutScreen.tsx calls get_vc_config() instead of selecting app_config directly', () => {
    expect(cashoutSrc).toMatch(/supabase\.rpc\('get_vc_config'/);
    expect(cashoutSrc).not.toMatch(/from\('app_config'/);
  });

  it('ReferralScreen.tsx no longer declares a hardcoded CENTS_PER_REFERRAL = 300 constant', () => {
    expect(referralSrc).not.toMatch(/const\s+CENTS_PER_REFERRAL\s*=\s*300/);
  });

  it('ReferralScreen.tsx no longer declares a static BADGE_CONFIG array with hardcoded prices', () => {
    expect(referralSrc).not.toMatch(/cost:\s*300/);
    expect(referralSrc).not.toMatch(/cost:\s*800/);
    expect(referralSrc).not.toMatch(/cost:\s*2000/);
    expect(referralSrc).not.toMatch(/cost:\s*5000/);
    expect(referralSrc).not.toMatch(/cost:\s*12000/);
    expect(referralSrc).not.toMatch(/cost:\s*25000/);
  });

  it('VcCashoutScreen.tsx no longer declares a hardcoded MIN_VC=1000-style default equal to a bare 1000 literal for the min gate', () => {
    // The screen may keep a *display fallback* default (DEFAULT_MIN_VC) used
    // only until the real config loads, but it must not be a bare literal of
    // 1000 -- and the real min must come from get_vc_config()'s cashout_min_vc.
    expect(cashoutSrc).toMatch(/cashout_min_vc/);
    expect(cashoutSrc).not.toMatch(/const\s+MIN_VC\s*=\s*1000\b/);
  });
});

describe('ReferralScreen.tsx no longer contains the false attendance/redemption copy', () => {
  it('does not claim attendance/check-in earns VC (in rendered copy, not explanatory comments)', () => {
    const codeOnly = referralSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(codeOnly).not.toMatch(/Attend events/i);
    expect(codeOnly).not.toMatch(/earn cents automatically/i);
    expect(codeOnly).not.toMatch(/check in with a ticket/i);
  });

  it('does not claim VC can be redeemed toward any ticket purchase', () => {
    expect(referralSrc).not.toMatch(/Use cents as credit toward any ticket purchase/i);
    expect(referralSrc).not.toMatch(/Redeem for tickets/i);
  });

  it('does not mention DB-internal terms in rendered UI copy (comments excluded)', () => {
    for (const src of [referralSrc, cashoutSrc, helpModalSrc]) {
      const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      expect(codeOnly).not.toMatch(/advisory lock/i);
      expect(codeOnly).not.toMatch(/xact_lock/i);
      expect(codeOnly).not.toMatch(/pg_advisory/i);
    }
  });
});

describe('VcCashoutScreen.tsx displays the server-enforced limits, not just fetches them', () => {
  it('has state for max/daily/request/cooldown/maturation', () => {
    expect(cashoutSrc).toMatch(/setMaxVc/);
    expect(cashoutSrc).toMatch(/setDailyMaxVc/);
    expect(cashoutSrc).toMatch(/setDailyMaxRequests/);
    expect(cashoutSrc).toMatch(/setCooldownMinutes/);
    expect(cashoutSrc).toMatch(/setMaturationHours/);
  });

  it('renders JSX labels for each of those limits', () => {
    expect(cashoutSrc).toMatch(/Max per request/);
    expect(cashoutSrc).toMatch(/Daily max amount/);
    expect(cashoutSrc).toMatch(/Daily max requests/);
    expect(cashoutSrc).toMatch(/Cooldown between requests/);
    expect(cashoutSrc).toMatch(/Hold on newly-earned VC/);
  });

  it('reads all limit fields from the get_vc_config() response', () => {
    for (const field of [
      'cashout_max_vc',
      'cashout_daily_max_vc',
      'cashout_daily_max_requests',
      'cashout_cooldown_minutes',
      'cashout_maturation_hold_hours',
    ]) {
      expect(cashoutSrc).toContain(field);
    }
  });
});

describe('all 6 badge tier prices are sourced from config in the UI', () => {
  it('ReferralScreen.tsx reads badge_<tier>_price for all 6 tiers via vcConfig', () => {
    expect(referralSrc).toMatch(/badge_\$\{type\}_price/);
    expect(referralSrc).toMatch(/BADGE_TIERS/);
  });

  it('migration 0086 exposes all 6 badge prices from get_vc_config()', () => {
    for (const key of [
      'badge_bronze_price',
      'badge_silver_price',
      'badge_gold_price',
      'badge_platinum_price',
      'badge_elite_price',
      'badge_legend_price',
    ]) {
      expect(migration0086).toContain(`'${key}'`);
    }
  });

  it('migration 0086 does not redefine purchase_badge() or change any badge price there', () => {
    expect(migration0086).not.toMatch(/CREATE OR REPLACE FUNCTION public\.purchase_badge/);
  });

  it('migration 0086 re-grants get_vc_config() to anon and authenticated (still client-safe/read-only)', () => {
    expect(migration0086).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_vc_config\(\) TO anon, authenticated;/);
  });
});

describe('VC help content states ticket redemption is unavailable and does not claim attendance rewards', () => {
  it('VcHelpModal.tsx contains the exact "not currently available" line for ticket redemption', () => {
    expect(helpModalSrc).toMatch(/Using VENTS Cents toward ticket purchases is not currently available/);
  });

  it('VcHelpModal.tsx does not claim attendance/check-in rewards or organizer/campaign rewards in its rendered copy', () => {
    // Strip comment lines first -- explanatory comments here legitimately
    // NAME "attendance" while stating it is NOT offered; only the rendered
    // JSX copy itself must never claim it.
    const codeOnly = helpModalSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(codeOnly).not.toMatch(/attend(ing|ed)?\s+(an\s+)?event/i);
    expect(codeOnly).not.toMatch(/check-?in/i);
    expect(codeOnly).not.toMatch(/organizer reward/i);
    expect(codeOnly).not.toMatch(/campaign reward/i);
  });

  it('VcHelpModal.tsx states the real cash-out rate distinctly (cashout_rate_naira_per_1000), not the display estimate', () => {
    expect(helpModalSrc).toMatch(/cashout_rate_naira_per_1000/);
  });

  it('ReferralScreen.tsx wires the "?" button to open VcHelpModal', () => {
    expect(referralSrc).toMatch(/VcHelpModal/);
    expect(referralSrc).toMatch(/setShowHelp\(true\)/);
  });
});

describe('no attendance/check-in reward claimed anywhere in VC-related UI copy', () => {
  it('none of ReferralScreen.tsx, VcCashoutScreen.tsx, VcHelpModal.tsx claim attendance-based earning in rendered copy (comments excluded)', () => {
    for (const src of [referralSrc, cashoutSrc, helpModalSrc]) {
      const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      expect(codeOnly).not.toMatch(/attend(ing|ed)?\s+(an\s+)?event.*earn/i);
      expect(codeOnly).not.toMatch(/earn.*attend(ing|ed)?\s+(an\s+)?event/i);
    }
  });
});
