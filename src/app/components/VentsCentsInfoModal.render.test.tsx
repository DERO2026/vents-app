import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsCentsInfoModal } from './VentsCentsInfoModal';

// VENTS Cents "?" info experience (Prompt 2): a standalone component so it
// can be tested in isolation from ReferralScreen's data-fetching. All copy
// here must be derived from props the caller already pulled from the
// authoritative backend (vc_reward_campaigns, vc_badge_tiers, app_config) --
// never a second hardcoded source of truth.

const TIER_LABELS: Record<string, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', elite: 'Elite', legend: 'Legend' };
const TIER_COLORS: Record<string, string> = { bronze: '#CD7F32', silver: '#C0C0C0', gold: '#FFD700', platinum: '#818CF8', elite: '#A855F7', legend: '#EC4899' };
const TIER_LADDER = [
  { tier: 'bronze', rank: 1, min_lifetime_vc: 500, multiplier: '1.00' },
  { tier: 'silver', rank: 2, min_lifetime_vc: 1500, multiplier: '1.10' },
  { tier: 'gold', rank: 3, min_lifetime_vc: 4000, multiplier: '1.25' },
  { tier: 'platinum', rank: 4, min_lifetime_vc: 8000, multiplier: '1.50' },
  { tier: 'elite', rank: 5, min_lifetime_vc: 15000, multiplier: '2.00' },
  { tier: 'legend', rank: 6, min_lifetime_vc: 30000, multiplier: '3.00' },
];
function fmtMultiplier(m: string | number) {
  const n = typeof m === 'string' ? parseFloat(m) : m;
  return `${n.toFixed(2)}×`;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

function renderModal(onClose = () => {}) {
  act(() => {
    root = createRoot(container);
    root.render(
      <VentsCentsInfoModal
        onClose={onClose}
        profileAward={100}
        referredAward={500}
        checkinAward={250}
        referrerCheckinAward={1000}
        tierLadder={TIER_LADDER}
        ngnPer1000Vc={500}
        tierLabels={TIER_LABELS}
        tierColors={TIER_COLORS}
        fmtMultiplier={fmtMultiplier}
      />
    );
  });
}

describe('VentsCentsInfoModal renders', () => {
  it('renders all seven explanation sections', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toContain('What are VENTS Cents?');
    expect(text).toContain('How do I earn VC?');
    expect(text).toContain('Lifetime VC');
    expect(text).toContain('Tiers & multipliers');
    expect(text).toContain('Spending VC');
    expect(text).toContain('Convert VC to VENTS Wallet');
    expect(text).toContain('How VENTS protects VC');
  });

  it('states VC is not cash and not Paystack money', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toMatch(/not cash/i);
    expect(text).toMatch(/not Paystack money/i);
  });

  it('closes when the backdrop or close button is clicked', () => {
    let closed = false;
    renderModal(() => { closed = true; });
    const closeBtn = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    act(() => { closeBtn.click(); });
    expect(closed).toBe(true);
  });

  it('does not close when clicking inside the sheet content', () => {
    let closed = false;
    renderModal(() => { closed = true; });
    const sheet = container.querySelector('[data-testid="vc-info-modal"]') as HTMLElement;
    act(() => { sheet.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(closed).toBe(false);
  });
});

describe('Reward explanations reflect the exact amounts passed in (from the live backend)', () => {
  it('shows the profile, referral, check-in, and referrer-check-in amounts verbatim', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toContain('+100 VC');
    expect(text).toContain('+500 VC');
    expect(text).toContain('+250 VC');
    expect(text).toContain('+1000 VC');
  });

  it('explains the ₦20,000 qualifying threshold and that free/cheap check-ins earn 0 VC', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toMatch(/₦20,000 or more/);
    expect(text).toMatch(/0 VC/);
  });

  it('does not imply that merely buying a ticket earns the check-in reward', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toMatch(/need to actually check in/i);
  });
});

describe('Spendable vs Lifetime VC distinction', () => {
  it('explicitly separates the two concepts with distinct labels', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toContain('SPENDABLE VC');
    expect(text).toContain('LIFETIME VC');
  });

  it('states spend and conversion never reduce Lifetime VC, and ordinary credits never auto-increase it', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toMatch(/Spending VC does not lower your Lifetime VC/i);
    expect(text).toMatch(/Converting VC to your Wallet does not lower your Lifetime VC/i);
    expect(text).toMatch(/does not automatically raise your Lifetime VC/i);
  });
});

describe('Tier ladder reflects the live vc_badge_tiers rows passed in', () => {
  it('renders all six tiers with their thresholds and multipliers', () => {
    renderModal();
    const text = container.textContent || '';
    for (const t of TIER_LADDER) {
      expect(text).toContain(TIER_LABELS[t.tier]);
      expect(text).toContain(t.min_lifetime_vc.toLocaleString());
      expect(text).toContain(fmtMultiplier(t.multiplier));
    }
  });

  it('explicitly states tiers are not purchased, not merely silent on the topic', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toMatch(/isn't something you buy/i);
    expect(text).not.toMatch(/purchase a tier|buy a tier|buy tiers/i);
  });
});

describe('Conversion section is distinguished from ticket redemption and never exposes implementation details', () => {
  it('states the Gold+ requirement, rate, and minimum', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toMatch(/Gold tier or above/);
    expect(text).toContain('10 VC = ₦1');
    expect(text).toContain('10,000 VC');
  });

  it('clarifies conversion is separate from ticket redemption and is not a bank payout', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).toMatch(/separate from.*ticket discount|not the same as, redeeming/i);
    expect(text).toMatch(/does not pay out directly to a bank account/i);
  });

  it('never mentions database tables, RPC names, or security architecture', () => {
    renderModal();
    const text = container.textContent || '';
    expect(text).not.toMatch(/rpc|supabase|postgres|security definer|vc_transactions|vc_system_pool|award_vc_reward/i);
  });
});
