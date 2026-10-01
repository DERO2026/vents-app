import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ReferralScreen } from './ReferralScreen';

// VENTS Cents economy refactor, Batch F (frontend/UI): the VENTS Cents
// screen (ReferralScreen.tsx) is rebuilt around the Batch A-E authoritative
// backend -- lifetime-earned tier/multiplier (vc_tier_and_multiplier_for_user),
// real reward-campaign amounts (vc_reward_campaigns), and the new
// convert_vc_to_wallet conversion flow -- replacing the old purchased-badge
// UI, the "not withdrawable" banner, and the stale 300/150/50/100 VC
// earning-breakdown copy. No backend file (migrations, RPCs) was touched in
// this batch.

const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (...args: any[]) => fromMock(...args),
    rpc: (...args: any[]) => rpcMock(...args),
  },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/haptics', () => ({ haptics: { light: vi.fn() } }));

const getVcBalanceMock = vi.fn();
const invalidateVcBalanceCacheMock = vi.fn();
vi.mock('../../lib/vcBalanceCache', () => ({
  getVcBalance: (...args: any[]) => getVcBalanceMock(...args),
  invalidateVcBalanceCache: (...args: any[]) => invalidateVcBalanceCacheMock(...args),
}));

if (!(global as any).crypto?.randomUUID) {
  (global as any).crypto = { ...(global as any).crypto, randomUUID: () => 'test-uuid-0000' };
}

const TIER_LADDER = [
  { tier: 'bronze', rank: 1, min_lifetime_vc: 500, multiplier: '1.00' },
  { tier: 'silver', rank: 2, min_lifetime_vc: 1500, multiplier: '1.10' },
  { tier: 'gold', rank: 3, min_lifetime_vc: 4000, multiplier: '1.25' },
  { tier: 'platinum', rank: 4, min_lifetime_vc: 8000, multiplier: '1.50' },
  { tier: 'elite', rank: 5, min_lifetime_vc: 15000, multiplier: '2.00' },
  { tier: 'legend', rank: 6, min_lifetime_vc: 30000, multiplier: '3.00' },
];
const CAMPAIGNS = [
  { key: 'profile_complete', amount_vc: 100 },
  { key: 'referral_referred', amount_vc: 500 },
  { key: 'event_checkin', amount_vc: 250 },
  { key: 'referral_referrer_checkin', amount_vc: 1000 },
];

function chain(result: any) {
  const obj: any = {
    select: () => obj,
    eq: () => obj,
    order: () => obj,
    limit: () => obj,
    in: () => obj,
    maybeSingle: () => Promise.resolve({ data: Array.isArray(result) ? result[0] ?? null : result, error: null }),
    then: (resolve: any) => resolve({ data: result, error: null }),
  };
  return obj;
}

function setupMocks({ lifetimeEarned, tier, multiplier, spendable, activity = [] }: { lifetimeEarned: number; tier: string | null; multiplier: string; spendable: number; activity?: any[] }) {
  getVcBalanceMock.mockResolvedValue({ spendable, expired_this_call: 0 });
  fromMock.mockImplementation((table: string) => {
    switch (table) {
      case 'referrals': return chain([]);
      case 'users': return chain({ vc_featured_until: null });
      case 'vc_bonuses': return chain(null);
      case 'app_config': return chain({ vc_naira_per_1000: 500 });
      case 'vc_badge_tiers': return chain(TIER_LADDER);
      case 'vc_reward_campaigns': return chain(CAMPAIGNS);
      case 'vc_transactions': return chain(activity);
      default: throw new Error(`Unexpected supabase.from('${table}') call`);
    }
  });
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'vc_tier_and_multiplier_for_user') {
      return Promise.resolve({ data: [{ lifetime_earned: lifetimeEarned, tier, multiplier }], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

const currentUser = { id: 'user-1', email: 'u@example.com', full_name: 'Test User' };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  getVcBalanceMock.mockReset();
  invalidateVcBalanceCacheMock.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function renderScreen(onGoToWallet?: () => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ReferralScreen onBack={() => {}} currentUser={currentUser} onGoToWallet={onGoToWallet} />);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

function text() { return container!.textContent || ''; }
function byTestId(id: string) { return container!.querySelector(`[data-testid="${id}"]`); }

describe('VENTS Cents balance, tier, and multiplier render from real backend data', () => {
  it('renders spendable balance and lifetime-earned VC as two distinct figures', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1234 });
    await renderScreen();
    expect(byTestId('vc-spendable-balance')?.textContent).toContain('1,234');
    expect(byTestId('vc-lifetime-earned')?.textContent).toContain('5,000');
    expect(byTestId('vc-spendable-balance')?.textContent).not.toContain('5,000');
  });

  it('renders the correct tier and multiplier', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    expect(text()).toContain('Gold');
    expect(byTestId('vc-multiplier')?.textContent).toBe('1.25×');
  });

  it('renders next-tier progress toward Platinum', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    const progress = byTestId('vc-tier-progress')!.textContent!;
    expect(progress).toContain('3,000'); // 8000 - 5000 remaining to Platinum
    expect(progress).toContain('Platinum');
  });
});

describe('Gold+ tier gate on VC-to-wallet conversion', () => {
  it('Bronze cannot convert -- modal explains the Gold requirement', async () => {
    setupMocks({ lifetimeEarned: 200, tier: null, multiplier: '1.00', spendable: 50000 });
    await renderScreen();
    await act(async () => { (byTestId('vc-balance-hero')!.querySelector('button') as HTMLButtonElement).click(); });
    expect(byTestId('convert-to-wallet-modal')!.textContent).toContain('Unlocks at Gold');
    expect(byTestId('convert-amount-input')).toBeNull();
  });

  it('Silver cannot convert', async () => {
    setupMocks({ lifetimeEarned: 1500, tier: 'silver', multiplier: '1.10', spendable: 50000 });
    await renderScreen();
    await act(async () => { (byTestId('vc-balance-hero')!.querySelector('button') as HTMLButtonElement).click(); });
    expect(byTestId('convert-to-wallet-modal')!.textContent).toContain('Unlocks at Gold');
  });

  it.each(['gold', 'platinum', 'elite', 'legend'])('%s can access the conversion flow', async (tier) => {
    setupMocks({ lifetimeEarned: 50000, tier, multiplier: '1.00', spendable: 50000 });
    await renderScreen();
    await act(async () => { (byTestId('vc-balance-hero')!.querySelector('button') as HTMLButtonElement).click(); });
    expect(byTestId('convert-amount-input')).not.toBeNull();
  });
});

describe('Conversion amount validation and NGN calculation', () => {
  async function openConvert() {
    setupMocks({ lifetimeEarned: 50000, tier: 'gold', multiplier: '1.25', spendable: 50000 });
    await renderScreen();
    await act(async () => { (byTestId('vc-balance-hero')!.querySelector('button') as HTMLButtonElement).click(); });
  }
  function setAmount(v: string) {
    const input = byTestId('convert-amount-input') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => { nativeSetter.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true })); });
  }

  it('enforces the 10,000 VC minimum in the UI', async () => {
    await openConvert();
    setAmount('5000');
    expect(byTestId('convert-validation-error')?.textContent).toMatch(/minimum/i);
    expect((byTestId('convert-continue-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the exact NGN amount for 25,000 VC', async () => {
    await openConvert();
    setAmount('25000');
    expect(byTestId('convert-naira-preview')?.textContent).toContain('2,500');
  });

  it('rejects a non-divisible-by-10 amount without rounding', async () => {
    await openConvert();
    setAmount('10005');
    expect(byTestId('convert-validation-error')?.textContent).toMatch(/multiple of 10/i);
    expect(byTestId('convert-naira-preview')).toBeNull();
  });

  it('rejects an amount exceeding the spendable balance', async () => {
    setupMocks({ lifetimeEarned: 50000, tier: 'gold', multiplier: '1.25', spendable: 12000 });
    await renderScreen();
    await act(async () => { (byTestId('vc-balance-hero')!.querySelector('button') as HTMLButtonElement).click(); });
    setAmount('20000');
    expect(byTestId('convert-validation-error')?.textContent).toMatch(/insufficient/i);
  });

  it('confirmation step shows the exact VC and NGN amounts', async () => {
    await openConvert();
    setAmount('10000');
    await act(async () => { (byTestId('convert-continue-button') as HTMLButtonElement).click(); });
    const summary = byTestId('convert-confirm-summary')!.textContent!;
    expect(summary).toContain('10,000');
    expect(summary).toContain('1,000');
  });
});

describe('Conversion execution never shows false success and preserves idempotency on retry', () => {
  async function openToConfirm(amount = '10000') {
    setupMocks({ lifetimeEarned: 50000, tier: 'gold', multiplier: '1.25', spendable: 50000 });
    await renderScreen();
    await act(async () => { (byTestId('vc-balance-hero')!.querySelector('button') as HTMLButtonElement).click(); });
    const input = byTestId('convert-amount-input') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => { nativeSetter.call(input, amount); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (byTestId('convert-continue-button') as HTMLButtonElement).click(); });
  }

  it('a successful conversion shows success and refreshes the VC balance', async () => {
    await openToConfirm();
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'convert_vc_to_wallet') return Promise.resolve({ data: { converted: true, vc_amount: 10000, wallet_credit_naira: 1000 }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await act(async () => { (byTestId('convert-confirm-button') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(byTestId('convert-success-state')).not.toBeNull();
    expect(byTestId('vc-spendable-balance')?.textContent).toContain('40,000'); // 50000 - 10000, refreshed
    expect(invalidateVcBalanceCacheMock).toHaveBeenCalled();
  });

  it('a backend rejection (e.g. insufficient balance) never shows success', async () => {
    await openToConfirm();
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'convert_vc_to_wallet') return Promise.resolve({ data: null, error: { message: 'Insufficient Vents Cents balance' } });
      return Promise.resolve({ data: null, error: null });
    });
    await act(async () => { (byTestId('convert-confirm-button') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(byTestId('convert-success-state')).toBeNull();
    expect(byTestId('convert-error-state')?.textContent).toContain('Insufficient Vents Cents balance');
  });

  it('backend returning converted:false never shows success', async () => {
    await openToConfirm();
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'convert_vc_to_wallet') return Promise.resolve({ data: { converted: false }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await act(async () => { (byTestId('convert-confirm-button') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(byTestId('convert-success-state')).toBeNull();
    expect(byTestId('convert-error-state')).not.toBeNull();
  });

  it('a timeout-style failure followed by Retry reuses the SAME idempotency key', async () => {
    await openToConfirm();
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'convert_vc_to_wallet') return Promise.reject(new Error('Network request failed'));
      return Promise.resolve({ data: null, error: null });
    });
    await act(async () => { (byTestId('convert-confirm-button') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(byTestId('convert-error-state')?.textContent).toMatch(/connection issue/i);

    const firstCallKey = rpcMock.mock.calls.find((c) => c[0] === 'convert_vc_to_wallet')?.[1]?.p_idempotency_key;

    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'convert_vc_to_wallet') return Promise.resolve({ data: { converted: true, idempotent_replay: false, vc_amount: 10000, wallet_credit_naira: 1000 }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await act(async () => { (byTestId('convert-retry-button') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });

    const secondCallKey = rpcMock.mock.calls.filter((c) => c[0] === 'convert_vc_to_wallet').pop()?.[1]?.p_idempotency_key;
    expect(secondCallKey).toBe(firstCallKey);
    expect(byTestId('convert-success-state')).not.toBeNull();
  });
});

describe('Stale/retired UI is absent', () => {
  it('no badge-purchase UI is present anywhere on the screen', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    expect(text()).not.toMatch(/profile badges/i);
    expect(text()).not.toMatch(/buy.*badge/i);
    expect(text()).not.toContain('25,000 VC'); // old Legend badge price
  });

  it('no direct VC cash-out / bank-withdrawal UI is present', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    expect(text()).not.toMatch(/cash.?out/i);
    expect(text()).not.toMatch(/not withdrawable or convertible to cash/i);
    expect(text()).not.toMatch(/bank account/i);
  });

  it('the conversion confirmation makes clear this is a Wallet credit, not a bank transfer', async () => {
    setupMocks({ lifetimeEarned: 50000, tier: 'gold', multiplier: '1.25', spendable: 50000 });
    await renderScreen();
    await act(async () => { (byTestId('vc-balance-hero')!.querySelector('button') as HTMLButtonElement).click(); });
    const input = byTestId('convert-amount-input') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => { nativeSetter.call(input, '10000'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (byTestId('convert-continue-button') as HTMLButtonElement).click(); });
    expect(text()).toMatch(/does not initiate a bank transfer/i);
  });
});

describe('VENTS Cents "?" info experience (Prompt 2)', () => {
  it('opens the info modal when the ? button is tapped, and closes it again', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    expect(byTestId('vc-info-modal')).toBeNull();
    await act(async () => { (byTestId('vc-info-button') as HTMLButtonElement).click(); });
    const modal = byTestId('vc-info-modal');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('What are VENTS Cents?');
    await act(async () => { (modal!.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click(); });
    expect(byTestId('vc-info-modal')).toBeNull();
  });

  it('passes the real campaign amounts and tier ladder into the info modal, not hardcoded copy', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    await act(async () => { (byTestId('vc-info-button') as HTMLButtonElement).click(); });
    const modal = byTestId('vc-info-modal')!.textContent!;
    expect(modal).toContain('+100 VC'); // profile_complete from CAMPAIGNS fixture
    expect(modal).toContain('+500 VC'); // referral_referred
    expect(modal).toContain('+250 VC'); // event_checkin
    expect(modal).toContain('+1000 VC'); // referral_referrer_checkin
    expect(modal).toContain('4,000 lifetime VC'); // gold threshold from TIER_LADDER fixture
  });
});

describe('Stale check-in copy is fixed to reflect the ₦20,000 qualification rule', () => {
  it('"How it works" no longer claims every check-in earns VC unconditionally', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    expect(text()).not.toMatch(/earn cents automatically every time you check in with a ticket/i);
    expect(text()).toMatch(/₦20,000\+ ticket/);
  });
});

describe('Layout is responsive, not a fixed mobile-only width', () => {
  it('the scroll container caps width for desktop rather than forcing a phone-sized layout', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    const scroll = container!.querySelector('.vc-scroll') as HTMLElement;
    expect(scroll.style.maxWidth).toBe('720px');
    expect(scroll.style.width).toBe('100%');
    expect(scroll.style.margin).toBe('0px auto');
  });

  it('the root container fills its host (mobile-safe, no fixed pixel width)', async () => {
    setupMocks({ lifetimeEarned: 5000, tier: 'gold', multiplier: '1.25', spendable: 1000 });
    await renderScreen();
    const rootDiv = container!.firstElementChild as HTMLElement;
    expect(rootDiv.style.width).toBe('100%');
    expect(rootDiv.style.height).toBe('100%');
  });
});
