import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiUnlockedScreen } from './VentsAiUnlockedScreen';

// The approved prototype's only actual "orb" (ai.ph.unlocked) -- every
// other VENTS AI view uses a plain text header, no orb.
//
// Regression coverage for a real accuracy bug: this screen used to say
// "VENTS AI is unlocked" unconditionally, for every user AiAccessScreen's
// onContinue() ever fires for -- which today includes everyone, since
// app_config.ai_entitlement_enforced is off in production and onContinue()
// fires with zero entitlement check in that case. A user with no real
// subscription was told their AI access was "unlocked," which was false.
// This now does its own get_my_ai_entitlement() read and only claims
// "unlocked" for a genuinely valid entitlement.

const rpc = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: { rpc: (...args: any[]) => rpc(...args) },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  rpc.mockReset();
});

async function mount(onStartPlanning = vi.fn(), onViewPlans = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<VentsAiUnlockedScreen onStartPlanning={onStartPlanning} onViewPlans={onViewPlans} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('VentsAiUnlockedScreen: genuine entitlement (real "unlocked")', () => {
  it('shows "VENTS AI is unlocked" and "Start planning" only for a real, currently-valid entitlement', async () => {
    rpc.mockResolvedValueOnce({ data: { plan_id: 'ai', status: 'active', period_end: null, grace_until: null }, error: null });
    const onStartPlanning = vi.fn();
    await mount(onStartPlanning);

    expect(container!.textContent).toContain('VENTS AI is unlocked');
    const button = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Start planning')!;
    expect(button).toBeTruthy();
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onStartPlanning).toHaveBeenCalledTimes(1);
  });

  it('trialing with no period_end (open-ended trial) still counts as real access', async () => {
    rpc.mockResolvedValueOnce({ data: { plan_id: 'trial', status: 'trialing', period_end: null, grace_until: null }, error: null });
    await mount();
    expect(container!.textContent).toContain('VENTS AI is unlocked');
  });
});

describe('VentsAiUnlockedScreen: no real access (honest preview, not a false "unlocked" claim)', () => {
  it('shows an honest preview message and a real "View Plans" action for a user with no entitlement row at all', async () => {
    rpc.mockResolvedValueOnce({ data: { plan_id: null, status: 'inactive' }, error: null });
    const onViewPlans = vi.fn();
    await mount(vi.fn(), onViewPlans);

    expect(container!.textContent).not.toContain('VENTS AI is unlocked');
    expect(container!.textContent).toContain('Welcome to VENTS AI');
    const viewPlansButton = container!.querySelector('button[data-testid="vents-ai-unlocked-view-plans"]') as HTMLButtonElement;
    expect(viewPlansButton).toBeTruthy();
    act(() => { viewPlansButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onViewPlans).toHaveBeenCalledTimes(1);
  });

  it('an expired entitlement past its grace window is also treated as no real access', async () => {
    rpc.mockResolvedValueOnce({
      data: { plan_id: 'ai', status: 'active', period_end: new Date(Date.now() - 86400000).toISOString(), grace_until: null },
      error: null,
    });
    await mount();
    expect(container!.textContent).not.toContain('VENTS AI is unlocked');
  });

  it('still lets the user continue into VENTS AI (enforcement being off means chat is still reachable either way)', async () => {
    rpc.mockResolvedValueOnce({ data: { plan_id: null, status: 'inactive' }, error: null });
    const onStartPlanning = vi.fn();
    await mount(onStartPlanning);

    const continueButton = container!.querySelector('button[data-testid="vents-ai-unlocked-continue"]') as HTMLButtonElement;
    expect(continueButton.textContent).toBe('Continue to VENTS AI');
    act(() => { continueButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onStartPlanning).toHaveBeenCalledTimes(1);
  });

  it('a failed entitlement read fails to the honest "no access" copy, never the false "unlocked" claim', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('network down') });
    await mount();
    expect(container!.textContent).not.toContain('VENTS AI is unlocked');
  });
});
