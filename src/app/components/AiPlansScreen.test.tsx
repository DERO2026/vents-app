import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AiPlansScreen } from './AiPlansScreen';

// Real VENTS AI paywall: every price/plan shown comes from
// get_ai_plans_public() (never hardcoded), and a purchase only ever
// "succeeds" client-side after the server's own verify call returns
// status: success -- the Paystack popup's own callback is never trusted
// alone. Paystack itself is mocked at the lib boundary (same seam
// CustomerWalletScreen's own tests use) so these exercise real component
// logic, not a real payment popup.

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

vi.mock('../../lib/supabase', () => ({
  supabase: { auth: { getUser: () => Promise.resolve({ data: { user: { email: 'buyer@example.com', user_metadata: { full_name: 'Buyer' } } } }) } },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchAiPlansPublic.mockReset();
  initiateAiSubscriptionPayment.mockReset();
  verifyAiSubscriptionPayment.mockReset();
  openPaystackPopup.mockReset();
});

async function mount(onSubscribed = () => {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AiPlansScreen onClose={() => {}} onSubscribed={onSubscribed} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const PLANS = [
  { plan_id: 'ai', label: 'VENTS AI', included_units: 50, hard_ceiling: 75, price_kobo: 750000, currency: 'NGN', billing_period_days: 30 },
  { plan_id: 'ai_plus', label: 'VENTS AI+', included_units: 100, hard_ceiling: 150, price_kobo: 1350000, currency: 'NGN', billing_period_days: 30 },
];

describe('AiPlansScreen: real plan list (never hardcoded pricing)', () => {
  it('renders exactly the plans and NGN prices get_ai_plans_public() returns', async () => {
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    await mount();
    expect(container!.textContent).toContain('VENTS AI');
    expect(container!.textContent).toContain('₦7,500');
    expect(container!.textContent).toContain('VENTS AI+');
    expect(container!.textContent).toContain('₦13,500');
    // ai_pro was never returned by the mock (matching the real RPC, which
    // excludes it server-side) -- confirms this screen doesn't invent it.
    expect(container!.textContent).not.toContain('Pro');
  });

  it('shows a real error state when the plan list fails to load', async () => {
    fetchAiPlansPublic.mockRejectedValueOnce(new Error('network down'));
    await mount();
    expect(container!.textContent).toContain('network down');
  });

  it('shows "no plans available" rather than fabricating one when the list is empty', async () => {
    fetchAiPlansPublic.mockResolvedValueOnce([]);
    await mount();
    expect(container!.textContent).toContain('No plans are available for purchase right now.');
  });
});

describe('AiPlansScreen: purchase flow (never grants access from a client-side signal alone)', () => {
  it('initiates a real pending payment, opens Paystack with the server-returned amount, and only shows success after verify() confirms it', async () => {
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    initiateAiSubscriptionPayment.mockResolvedValueOnce({ reference: 'aisub_abc123', amount_kobo: 750000, currency: 'NGN', plan_id: 'ai', label: 'VENTS AI' });
    verifyAiSubscriptionPayment.mockResolvedValueOnce({ status: 'success', planId: 'ai' });
    const onSubscribed = vi.fn();
    await mount(onSubscribed);

    const subscribeBtn = container!.querySelector('button[data-testid="ai-plan-subscribe-ai"]') as HTMLButtonElement;
    await act(async () => {
      subscribeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(initiateAiSubscriptionPayment).toHaveBeenCalledWith('ai');
    expect(openPaystackPopup).toHaveBeenCalledTimes(1);
    const popupArgs = openPaystackPopup.mock.calls[0][0];
    expect(popupArgs.amountKobo).toBe(750000);
    expect(popupArgs.ref).toBe('aisub_abc123');
    expect(popupArgs.email).toBe('buyer@example.com');

    // Simulate the popup's own success callback -- this alone must not be
    // enough; the component must call verifyAiSubscriptionPayment and wait
    // for its result before reporting success.
    await act(async () => {
      await popupArgs.onSuccess({ reference: 'aisub_abc123' });
    });

    expect(verifyAiSubscriptionPayment).toHaveBeenCalledWith('aisub_abc123');
    expect(onSubscribed).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain('VENTS AI is now active.');
  });

  it('does NOT report success when verify() reports a failed payment, even though Paystack\'s popup called back', async () => {
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    initiateAiSubscriptionPayment.mockResolvedValueOnce({ reference: 'aisub_xyz', amount_kobo: 750000, currency: 'NGN', plan_id: 'ai', label: 'VENTS AI' });
    verifyAiSubscriptionPayment.mockResolvedValueOnce({ status: 'failed' });
    const onSubscribed = vi.fn();
    await mount(onSubscribed);

    const subscribeBtn = container!.querySelector('button[data-testid="ai-plan-subscribe-ai"]') as HTMLButtonElement;
    await act(async () => { subscribeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    const popupArgs = openPaystackPopup.mock.calls[0][0];
    await act(async () => { await popupArgs.onSuccess({ reference: 'aisub_xyz' }); });

    expect(onSubscribed).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('Payment failed. You have not been charged.');
    expect(container!.textContent).not.toContain('is now active');
  });

  it('refuses to purchase a plan the server has not priced (e.g. an unpublished plan) and shows a clear message, not a silent failure', async () => {
    fetchAiPlansPublic.mockResolvedValueOnce(PLANS);
    initiateAiSubscriptionPayment.mockRejectedValueOnce(new Error('plan_not_purchasable'));
    await mount();

    const subscribeBtn = container!.querySelector('button[data-testid="ai-plan-subscribe-ai"]') as HTMLButtonElement;
    await act(async () => { subscribeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });

    expect(openPaystackPopup).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('This plan is not available for purchase yet.');
  });
});
