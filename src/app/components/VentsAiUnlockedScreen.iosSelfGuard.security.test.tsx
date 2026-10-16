import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Apple App Store escalation (Guideline 3.1.1, Oct 2026): "VENTS AI plans
// or pricing are still appearing" on native iOS. VentsAiUnlockedScreen's
// "Welcome to VENTS AI" copy and "View Plans" CTA imply a subscription to
// sell, so it now self-guards -- it rendered VentsAiIosComingSoonScreen on
// iOS regardless of entitlement state, independent of the App.tsx-level
// gate.
//
// Extended to Android (Phase 2, Oct 2026 Android release-readiness audit):
// same Google Play Payments Policy concern as the iOS fix. The gate is now
// isMobileNativeForAiGate() (true on iOS OR Android); web is unaffected.
//
// VENTS AI web-only release: a "coming soon" placeholder is no longer
// acceptable on either mobile platform either -- this screen now renders
// nothing at all (null) on mobile, with no close button to wire up since
// there is nothing on screen to close.

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

describe('VentsAiUnlockedScreen: native iOS/Android self-guard', () => {
  it('iOS + no real entitlement (would normally show "Welcome"/"View Plans") -> renders nothing', async () => {
    getPlatformMock.mockReturnValue('ios');
    rpc.mockResolvedValue({ data: { plan_id: null, status: 'inactive' }, error: null });
    await mount();
    expect(container!.textContent).not.toContain('Welcome to VENTS AI');
    expect(container!.textContent).not.toContain('View Plans');
    expect(container!.querySelector('[data-testid="vents-ai-unlocked-view-plans"]')).toBeFalsy();
    expect(container!.textContent).not.toContain('Coming soon');
    expect(container!.textContent).toBe('');
  });

  it('iOS + a genuinely active entitlement (would normally say "unlocked") -> still renders nothing, not the unlocked copy', async () => {
    getPlatformMock.mockReturnValue('ios');
    rpc.mockResolvedValue({ data: { plan_id: 'ai_plus', status: 'active' }, error: null });
    await mount();
    expect(container!.textContent).not.toContain('VENTS AI is unlocked');
    expect(container!.textContent).toBe('');
  });

  it('iOS: no close/back button exists -- nothing on screen to close', async () => {
    getPlatformMock.mockReturnValue('ios');
    rpc.mockResolvedValue({ data: { plan_id: null, status: 'inactive' }, error: null });
    const { onStartPlanning } = await mount();
    expect(container!.querySelector('button')).toBeFalsy();
    expect(onStartPlanning).not.toHaveBeenCalled();
  });

  it('Android + a genuinely active entitlement (would normally say "unlocked") -> renders nothing, not the unlocked copy', async () => {
    getPlatformMock.mockReturnValue('android');
    rpc.mockResolvedValue({ data: { plan_id: 'ai_plus', status: 'active' }, error: null });
    await mount();
    expect(container!.textContent).not.toContain('VENTS AI is unlocked');
    expect(container!.textContent).not.toContain('View Plans');
    expect(container!.querySelector('[data-testid="vents-ai-unlocked-view-plans"]')).toBeFalsy();
    expect(container!.textContent).not.toContain('Coming soon');
    expect(container!.textContent).toBe('');
  });

  it('Android: no close/back button exists either, same as iOS', async () => {
    getPlatformMock.mockReturnValue('android');
    rpc.mockResolvedValue({ data: { plan_id: null, status: 'inactive' }, error: null });
    const { onStartPlanning } = await mount();
    expect(container!.querySelector('button')).toBeFalsy();
    expect(onStartPlanning).not.toHaveBeenCalled();
  });

  it('Web: real "View Plans" CTA renders unchanged, same as before the mobile fix', async () => {
    getPlatformMock.mockReturnValue('web');
    rpc.mockResolvedValue({ data: { plan_id: null, status: 'inactive' }, error: null });
    await mount();
    expect(container!.querySelector('[data-testid="vents-ai-unlocked-view-plans"]')).toBeTruthy();
    expect(container!.textContent).not.toContain('Coming soon');
  });
});
