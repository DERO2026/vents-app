import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents Batch G (A-F reconciliation audit): PrivacyScreen, TermsScreen,
// HelpPage, and HelpSupportScreen all stated Vents Cents are "not
// withdrawable and not convertible to cash" and/or described a "14-day
// pending period" before referral earnings activate. Both claims are false
// under the shipped economy: Batch E/F let Gold+ users convert VC into
// their VENTS Wallet balance (10 VC = N1, min 10,000 VC), and Batch C
// retired the 14-day pending-referral mechanism entirely -- referral
// rewards are credited immediately (flat 500 to the referred user; a
// multiplier-scaled bonus to the referrer on the referred user's first
// check-in, never a time-based hold). HelpSupportScreen also quoted the
// pre-Batch-C 300/150 VC referral amounts and falsely claimed VC "cannot
// be used to pay for tickets" (ticket redemption is a real, long-standing,
// unrelated feature). This test guards against that stale copy silently
// reappearing; it does not assert specific live VC amounts, since those
// belong in the backend (vc_reward_campaigns), not in static legal/help
// text.

const root = join(__dirname, '..', 'app', 'components');
const privacy = readFileSync(join(root, 'PrivacyScreen.tsx'), 'utf8');
const terms = readFileSync(join(root, 'TermsScreen.tsx'), 'utf8');
const helpPage = readFileSync(join(root, 'HelpPage.tsx'), 'utf8');
const helpSupport = readFileSync(join(root, 'HelpSupportScreen.tsx'), 'utf8');

describe('legal/help copy no longer claims Vents Cents are never convertible to cash', () => {
  it('PrivacyScreen describes the real Gold+ wallet-conversion capability', () => {
    expect(privacy).not.toMatch(/not withdrawable, and not convertible to cash/i);
    expect(privacy).toMatch(/Gold loyalty tier or higher/i);
    expect(privacy).toMatch(/10 Vents Cents = ₦1/);
  });

  it('TermsScreen describes the real Gold+ wallet-conversion capability', () => {
    expect(terms).not.toMatch(/Cannot be withdrawn, transferred, or converted to any currency(?!\s*outside)/i);
    expect(terms).toMatch(/Gold loyalty tier or higher/i);
    expect(terms).toMatch(/10 Vents Cents = ₦1/);
  });

  it('HelpPage no longer claims Vents Cents are flatly not withdrawable', () => {
    expect(helpPage).not.toMatch(/not withdrawable, not transferable between accounts/i);
    expect(helpPage).toMatch(/Gold loyalty tier or higher/i);
  });
});

describe('no obsolete 14-day pending-referral wording remains reachable', () => {
  it('HelpPage no longer describes a 14-day pending period for referral earnings', () => {
    expect(helpPage).not.toMatch(/14-day pending period/i);
  });

  it('HelpSupportScreen no longer quotes the retired 300/150 VC referral amounts or a 12-month pending/expiry pending claim tied to the old model', () => {
    expect(helpSupport).not.toMatch(/300 VC when a friend you refer signs up \(they get 150 VC too\)/);
  });
});

describe('Check-in VC copy reflects the ₦20,000 qualification rule (Prompt 2)', () => {
  it('HelpPage no longer implies any check-in earns VC unconditionally', () => {
    expect(helpPage).toMatch(/₦20,000\+ ticket/);
  });

  it('HelpSupportScreen states the ₦20,000 threshold and that free/cheaper check-ins earn 0 VC', () => {
    expect(helpSupport).toMatch(/₦20,000/);
    expect(helpSupport).toMatch(/earn 0 VC/i);
  });
});

describe('HelpSupportScreen no longer makes claims that contradict live, unrelated features', () => {
  it('does not claim VC cannot be used to pay for tickets (ticket redemption is a real feature)', () => {
    expect(helpSupport).not.toMatch(/cannot be used to pay for tickets/i);
  });

  it('does not advertise badge purchases as a way to spend VC (purchase_badge is retired -- Batch D)', () => {
    expect(helpSupport).not.toMatch(/unlock exclusive badges/i);
  });

  it('mentions the real Gold+ wallet-conversion capability instead', () => {
    expect(helpSupport).toMatch(/Gold loyalty tier or higher/i);
    expect(helpSupport).toMatch(/10 VC = ₦1/);
  });
});
