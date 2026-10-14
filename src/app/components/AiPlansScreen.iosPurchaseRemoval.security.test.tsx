import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Apple App Store rejection (Guideline 3.1.1, submission
// 3098bebc-a2ff-43de-8b7e-358a82693200, Oct 14 2026): VENTS AI/AI+ could be
// purchased in the iOS app through Paystack, a non-Apple payment mechanism.
// Fix: AiPlansScreen (the only purchase surface for VENTS AI/AI+) now
// checks Capacitor.getPlatform() === 'ios' and, on iOS only: never calls
// openPaystackPopup, shows no Subscribe button, and shows no link/CTA to
// pay elsewhere (that would trip Apple's separate 3.1.3 external-purchase-
// link rule). Android and web are completely unchanged. Existing
// entitlement display and self-cancellation are also unchanged on every
// platform, since Apple's objection is to the purchase mechanism, not to
// an iOS user keeping access they already paid for.

const getPlatformMock = vi.fn<() => string>(() => 'web');
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => getPlatformMock(),
    // isIosNative() (src/lib/platform.ts) requires both isNativePlatform()
    // and getPlatform() === 'ios' -- mirror that here instead of hardcoding
    // true, so this mock stays accurate if a 'web'-platform case is ever
    // added to this suite.
    isNativePlatform: () => getPlatformMock() !== 'web',
  },
}));

const fetchAiPlansPublic = vi.fn();
const initiateAiSubscriptionPayment = vi.fn();
const verifyAiSubscriptionPayment = vi.fn();
vi.mock('../../lib/aiSubscription', () => ({
  fetchAiPlansPublic: (...args: any[]) => fetchAiPlansPublic(...args),
  initiateAiSubscriptionPayment: (...args: any[]) => initiateAiSubscriptionPayment(...args),
  verifyAiSubscriptionPayment: (...args: any[]) => verifyAiSubscriptionPayment(...args),
}));

const openPaystackPopup = vi.fn();
vi.mock('../../lib/paystack', () => ({
  openPaystackPopup: (...args: any[]) => openPaystackPopup(...args),
}));

const rpc = vi.fn((..._args: any[]) => Promise.resolve({ data: null, error: null }));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: () => Promise.resolve({ data: { user: { email: 'buyer@example.com', user_metadata: { full_name: 'Buyer' } } } }) },
    rpc: (...args: any[]) => rpc(...args),
  },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  getPlatformMock.mockReset();
  getPlatformMock.mockReturnValue('web');
  fetchAiPlansPublic.mockReset();
  initiateAiSubscriptionPayment.mockReset();
  verifyAiSubscriptionPayment.mockReset();
  openPaystackPopup.mockReset();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

const PLANS = [
  { plan_id: 'ai', label: 'VENTS AI', included_units: 50, hard_ceiling: 75, price_kobo: 750000, currency: 'NGN', billing_period_days: 30 },
  { plan_id: 'ai_plus', label: 'VENTS AI+', included_units: 100, hard_ceiling: 150, price_kobo: 1350000, currency: 'NGN', billing_period_days: 30 },
];

async function mount() {
  const { AiPlansScreen } = await import('./AiPlansScreen');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AiPlansScreen onClose={() => {}} onSubscribed={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AiPlansScreen: iOS purchase removal (Guideline 3.1.1 fix, hardened per Oct 2026 Apple escalation)', () => {
  it('renders only the Coming Soon screen on iOS -- no plans, no prices, no purchase UI reaches the DOM at all', async () => {
    getPlatformMock.mockReturnValue('ios');
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    await mount();
    // The self-guard added in response to Apple's Oct 2026 escalation
    // replaces the ENTIRE screen on iOS -- not just the Subscribe button --
    // so none of the per-element testids below should exist, and neither
    // should the real Naira price text, which the older per-element guard
    // never covered.
    expect(container!.querySelector('[data-testid="ai-plan-subscribe-ai"]')).toBeFalsy();
    expect(container!.querySelector('[data-testid="ai-plan-subscribe-ai_plus"]')).toBeFalsy();
    expect(container!.querySelector('[data-testid="ai-plans-ios-purchase-unavailable"]')).toBeFalsy();
    expect(container!.querySelector('[data-testid="ai-plan-unavailable-ios-ai"]')).toBeFalsy();
    expect(container!.textContent).not.toContain('VENTS AI+');
    expect(container!.textContent).not.toMatch(/₦/);
    // No external purchase link/CTA -- Apple's separate 3.1.3 restriction.
    expect(container!.querySelector('a[href*="getvents.com"]')).toBeFalsy();
    expect(container!.textContent?.toLowerCase()).not.toContain('subscribe on');
    expect(container!.textContent).toContain('Coming soon');
  });

  it('never calls openPaystackPopup or initiateAiSubscriptionPayment on iOS -- the real screen content never renders', async () => {
    getPlatformMock.mockReturnValue('ios');
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    await mount();
    // The self-guard is a render-level early return after the data-loading
    // hooks (React's rules of hooks require every hook to run
    // unconditionally), so the background plans fetch may still fire, but
    // nothing it loads ever reaches the DOM, and no purchase handler is
    // reachable from any rendered element.
    expect(initiateAiSubscriptionPayment).not.toHaveBeenCalled();
    expect(openPaystackPopup).not.toHaveBeenCalled();
  });

  it('Android: purchasing is completely unchanged -- the real Subscribe button works exactly as before', async () => {
    getPlatformMock.mockReturnValue('android');
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    initiateAiSubscriptionPayment.mockResolvedValueOnce({ reference: 'aisub_x', amount_kobo: 1350000, plan_id: 'ai_plus' });
    await mount();
    const button = container!.querySelector('[data-testid="ai-plan-subscribe-ai_plus"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(initiateAiSubscriptionPayment).toHaveBeenCalledWith('ai_plus');
    expect(openPaystackPopup).toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="ai-plans-ios-purchase-unavailable"]')).toBeFalsy();
  });

  it('Web: purchasing is completely unchanged -- the real Subscribe button works exactly as before', async () => {
    getPlatformMock.mockReturnValue('web');
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    initiateAiSubscriptionPayment.mockResolvedValueOnce({ reference: 'aisub_y', amount_kobo: 750000, plan_id: 'ai' });
    await mount();
    const button = container!.querySelector('[data-testid="ai-plan-subscribe-ai"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(initiateAiSubscriptionPayment).toHaveBeenCalledWith('ai');
    expect(openPaystackPopup).toHaveBeenCalled();
  });

  it('iOS: an existing subscriber sees Coming Soon too, not their plan/cancel UI -- Apple\'s Oct 2026 escalation objects to ANY AI plan/price/subscription surface on iOS, with no carve-out for existing subscribers', async () => {
    getPlatformMock.mockReturnValue('ios');
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    rpc.mockImplementation((fn: string) => {
      if (fn === 'get_my_ai_entitlement') {
        return Promise.resolve({
          data: { plan_id: 'ai_plus', status: 'active', period_end: '2026-11-14T00:00:00Z', grace_until: null },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    await mount();
    expect(container!.textContent).not.toContain('VENTS AI+');
    expect(container!.textContent).not.toContain('Your current plan');
    expect(container!.querySelector('[data-testid="ai-plans-cancel-start"]')).toBeFalsy();
    expect(container!.querySelector('[data-testid="ai-plan-unavailable-ios-ai"]')).toBeFalsy();
    // Coming Soon's own copy says as much: manage any existing subscription
    // from Android or the web instead, nothing is lost, it's just not shown
    // on iOS.
    expect(container!.textContent).toContain('Coming soon');
  });
});
