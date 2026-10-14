import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Apple App Store escalation (Guideline 3.1.1, Oct 2026): "VENTS AI plans
// or pricing are still appearing" on native iOS. VentsAiUnlockedScreen's
// "Welcome to VENTS AI" copy and "View Plans" CTA imply a subscription to
// sell, so it now self-guards -- it renders VentsAiIosComingSoonScreen on
// iOS regardless of entitlement state, independent of the App.tsx-level
// gate. It has no onClose prop (only onStartPlanning/onViewPlans), so this
// also proves onStartPlanning is what Coming Soon's close action is wired
// to on iOS.

const getPlatformMock = vi.fn<() => string>(() => 'web');
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => getPlatformMock(),
    isNativePlatform: () => getPlatformMock() !== 'web',
  },
}));

const rpc = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: { rpc: (...args: any[]) => rpc(...args) },
}));

import { VentsAiUnlockedScreen } from './VentsAiUnlockedScreen';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  rpc.mockReset();
  getPlatformMock.mockReturnValue('web');
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
  return { onStartPlanning, onViewPlans };
}

describe('VentsAiUnlockedScreen: native iOS self-guard', () => {
  it('iOS + no real entitlement (would normally show "Welcome"/"View Plans") -> renders Coming Soon instead', async () => {
    getPlatformMock.mockReturnValue('ios');
    rpc.mockResolvedValue({ data: { plan_id: null, status: 'inactive' }, error: null });
    await mount();
    expect(container!.textContent).not.toContain('Welcome to VENTS AI');
    expect(container!.textContent).not.toContain('View Plans');
    expect(container!.querySelector('[data-testid="vents-ai-unlocked-view-plans"]')).toBeFalsy();
    expect(container!.textContent).toContain('Coming soon');
  });

  it('iOS + a genuinely active entitlement (would normally say "unlocked") -> still renders Coming Soon, not the unlocked copy', async () => {
    getPlatformMock.mockReturnValue('ios');
    rpc.mockResolvedValue({ data: { plan_id: 'ai_plus', status: 'active' }, error: null });
    await mount();
    expect(container!.textContent).not.toContain('VENTS AI is unlocked');
    expect(container!.textContent).toContain('Coming soon');
  });

  it('iOS: Coming Soon’s close action is wired to onStartPlanning (this screen has no onClose prop)', async () => {
    getPlatformMock.mockReturnValue('ios');
    rpc.mockResolvedValue({ data: { plan_id: null, status: 'inactive' }, error: null });
    const { onStartPlanning } = await mount();
    const closeBtn = Array.from(container!.querySelectorAll('button')).find((b) => /back to vents/i.test(b.textContent || ''));
    expect(closeBtn).toBeTruthy();
    act(() => { closeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onStartPlanning).toHaveBeenCalledTimes(1);
  });

  it('Android: real "View Plans" CTA and unlocked copy render unchanged, same as before the iOS fix', async () => {
    getPlatformMock.mockReturnValue('android');
    rpc.mockResolvedValue({ data: { plan_id: 'ai_plus', status: 'active' }, error: null });
    await mount();
    expect(container!.textContent).toContain('VENTS AI is unlocked');
    expect(container!.textContent).not.toContain('Coming soon');
  });

  it('Web: real "View Plans" CTA renders unchanged, same as before the iOS fix', async () => {
    getPlatformMock.mockReturnValue('web');
    rpc.mockResolvedValue({ data: { plan_id: null, status: 'inactive' }, error: null });
    await mount();
    expect(container!.querySelector('[data-testid="vents-ai-unlocked-view-plans"]')).toBeTruthy();
    expect(container!.textContent).not.toContain('Coming soon');
  });
});
