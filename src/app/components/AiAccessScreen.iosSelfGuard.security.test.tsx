import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Apple App Store escalation (Guideline 3.1.1, Oct 2026): "VENTS AI plans
// or pricing are still appearing" on native iOS despite the App.tsx-level
// gate. This proves the defense-in-depth fix: AiAccessScreen now self-guards
// -- it renders nothing on iOS regardless of entitlement state, independent
// of whether App.tsx ever reaches this component at all, so no future
// route/refactor/direct-mount can bypass it.
//
// Extended to Android (Phase 2, Oct 2026 Android release-readiness audit):
// Google Play Payments Policy treats VENTS AI/AI+'s Paystack checkout the
// same way Apple's 3.1.1 does. isMobileNativeForAiGate() now covers both
// native platforms; web stays fully unrestricted.
//
// VENTS AI web-only release: a "coming soon" placeholder is no longer
// acceptable on either mobile platform either -- this screen now renders
// nothing at all on mobile instead of VentsAiIosComingSoonScreen.

const getPlatformMock = vi.fn<() => string>(() => 'web');
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => getPlatformMock(),
    isNativePlatform: () => getPlatformMock() !== 'web',
  },
}));

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: mockRpc } }));

import { AiAccessScreen } from './AiAccessScreen';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockRpc.mockReset();
  getPlatformMock.mockReturnValue('web');
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rpcImpl(responses: Record<string, any>) {
  return (fn: string) => Promise.resolve(responses[fn] ?? { data: null, error: new Error(`unmocked rpc ${fn}`) });
}

describe('AiAccessScreen: native iOS/Android self-guard', () => {
  it('iOS + no entitlement (would normally show the paywall) -> renders nothing, never the paywall', async () => {
    getPlatformMock.mockReturnValue('ios');
    mockRpc.mockImplementation(
      rpcImpl({
        ai_entitlement_enforced: { data: true, error: null },
        get_my_ai_entitlement: { data: { plan_id: null, status: 'inactive', trial_used: false }, error: null },
      })
    );
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(container!.textContent).not.toContain('premium feature');
    expect(container!.textContent).not.toContain('Choose a plan');
    expect(container!.textContent).not.toContain('Coming soon');
    expect(container!.textContent).toBe('');
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('iOS + trial at hard ceiling (would normally show the upgrade CTA) -> renders nothing, no upgrade CTA', async () => {
    getPlatformMock.mockReturnValue('ios');
    mockRpc.mockImplementation(
      rpcImpl({
        ai_entitlement_enforced: { data: true, error: null },
        get_my_ai_entitlement: {
          data: { plan_id: 'trial', status: 'trialing', trial_used: true, used_units: 15, included_units: 15, hard_ceiling: 15 },
          error: null,
        },
      })
    );
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={() => {}} onUpgrade={() => {}} />);
    });
    await flush();
    expect(container!.textContent).not.toContain('trial is complete');
    expect(container!.textContent).toBe('');
  });

  it('Android + no entitlement (would normally show the paywall) -> renders nothing, same as iOS', async () => {
    getPlatformMock.mockReturnValue('android');
    const onContinue = vi.fn();
    mockRpc.mockImplementation(
      rpcImpl({
        ai_entitlement_enforced: { data: true, error: null },
        get_my_ai_entitlement: { data: { plan_id: null, status: 'inactive', trial_used: false }, error: null },
      })
    );
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(container!.textContent).not.toContain('premium feature');
    expect(container!.textContent).not.toContain('Choose a plan');
    expect(container!.textContent).toBe('');
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('Web + no entitlement: real paywall renders unchanged, same as before the mobile fix', async () => {
    getPlatformMock.mockReturnValue('web');
    mockRpc.mockImplementation(
      rpcImpl({
        ai_entitlement_enforced: { data: true, error: null },
        get_my_ai_entitlement: { data: { plan_id: null, status: 'inactive', trial_used: false }, error: null },
      })
    );
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={() => {}} />);
    });
    await flush();
    expect(container!.textContent).toContain('premium feature');
    expect(container!.textContent).not.toContain('Coming soon');
  });
});
