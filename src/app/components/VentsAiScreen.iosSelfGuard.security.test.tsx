import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Apple App Store escalation (Guideline 3.1.1, Oct 2026): "VENTS AI plans
// or pricing are still appearing" on native iOS. VentsAiScreen's own
// HomeView renders a subscription status pill and "View Plans" CTA, and
// this screen mounts its own internal <AiPlansScreen> when showPlans is
// set -- both are reachable the instant this screen itself mounts, which
// is a path the single App.tsx-level gate doesn't cover if this screen is
// ever reached some other way (a future route, a direct render, a
// refactor). This proves the self-guard: on iOS this screen rendered ONLY
// VentsAiIosComingSoonScreen, never HomeView/ConversationView or any plan
// UI.
//
// Extended to Android (Phase 2, Oct 2026 Android release-readiness audit):
// same Google Play Payments Policy concern as the iOS fix -- Android got
// the identical Coming Soon treatment; only web keeps the real chat
// screen unchanged.
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

const sendVentsAiMessage = vi.fn();
vi.mock('../../lib/ventsAi', () => ({
  sendVentsAiMessage: (...args: any[]) => sendVentsAiMessage(...args),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

import { VentsAiScreen } from './VentsAiScreen';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  sendVentsAiMessage.mockReset();
  getPlatformMock.mockReturnValue('web');
});

function mount(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<VentsAiScreen onClose={onClose} />);
  });
  return { onClose };
}

describe('VentsAiScreen: native iOS/Android self-guard', () => {
  it('iOS: renders nothing -- no HomeView, no status pill, no "View Plans", no composer, no placeholder', async () => {
    getPlatformMock.mockReturnValue('ios');
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('input')).toBeFalsy();
    expect(container!.textContent).not.toContain('View Plans');
    expect(container!.textContent).not.toContain('Coming soon');
    expect(container!.textContent).toBe('');
  });

  it('iOS: no close/back button exists -- nothing on screen to close', async () => {
    getPlatformMock.mockReturnValue('ios');
    const { onClose } = mount();
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('button')).toBeFalsy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Android: renders nothing -- no HomeView, no status pill, no "View Plans", no composer, no placeholder', async () => {
    getPlatformMock.mockReturnValue('android');
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('input')).toBeFalsy();
    expect(container!.textContent).not.toContain('View Plans');
    expect(container!.textContent).not.toContain('Coming soon');
    expect(container!.textContent).toBe('');
  });

  it('Android: no close/back button exists either, same as iOS', async () => {
    getPlatformMock.mockReturnValue('android');
    const { onClose } = mount();
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('button')).toBeFalsy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Web: real HomeView (composer input) renders unchanged, same as before the mobile fix', async () => {
    getPlatformMock.mockReturnValue('web');
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('input')).toBeTruthy();
    expect(container!.textContent).not.toContain('Coming soon');
  });
});
