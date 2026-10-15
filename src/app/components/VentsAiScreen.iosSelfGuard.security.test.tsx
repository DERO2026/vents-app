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
// refactor). This proves the self-guard: on iOS this screen renders ONLY
// VentsAiIosComingSoonScreen, never HomeView/ConversationView or any plan
// UI.
//
// Extended to Android (Phase 2, Oct 2026 Android release-readiness audit):
// same Google Play Payments Policy concern as the iOS fix -- Android now
// gets the identical Coming Soon treatment; only web keeps the real chat
// screen unchanged.

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

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<VentsAiScreen onClose={() => {}} />);
  });
}

describe('VentsAiScreen: native iOS/Android self-guard', () => {
  it('iOS: renders only Coming Soon -- no HomeView, no status pill, no "View Plans", no composer', async () => {
    getPlatformMock.mockReturnValue('ios');
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('input')).toBeFalsy();
    expect(container!.textContent).not.toContain('View Plans');
    expect(container!.textContent).toContain('Coming soon');
  });

  it('iOS: onClose is wired through to Coming Soon’s close action', async () => {
    getPlatformMock.mockReturnValue('ios');
    const onClose = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<VentsAiScreen onClose={onClose} />); });
    await act(async () => { await Promise.resolve(); });
    const closeBtn = Array.from(container!.querySelectorAll('button')).find((b) => /back to vents/i.test(b.textContent || ''));
    expect(closeBtn).toBeTruthy();
    act(() => { closeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Android: renders only Coming Soon -- no HomeView, no status pill, no "View Plans", no composer', async () => {
    getPlatformMock.mockReturnValue('android');
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('input')).toBeFalsy();
    expect(container!.textContent).not.toContain('View Plans');
    expect(container!.textContent).toContain('Coming soon');
  });

  it('Android: onClose is wired through to Coming Soon’s close action, same as iOS', async () => {
    getPlatformMock.mockReturnValue('android');
    const onClose = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<VentsAiScreen onClose={onClose} />); });
    await act(async () => { await Promise.resolve(); });
    const closeBtn = Array.from(container!.querySelectorAll('button')).find((b) => /back to vents/i.test(b.textContent || ''));
    expect(closeBtn).toBeTruthy();
    act(() => { closeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Web: real HomeView (composer input) renders unchanged, same as before the iOS fix', async () => {
    getPlatformMock.mockReturnValue('web');
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(container!.querySelector('input')).toBeTruthy();
    expect(container!.textContent).not.toContain('Coming soon');
  });
});
