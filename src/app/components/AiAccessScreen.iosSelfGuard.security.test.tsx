import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Apple App Store escalation (Guideline 3.1.1, Oct 2026): "VENTS AI plans
// or pricing are still appearing" on native iOS despite the App.tsx-level
// gate. This proves the defense-in-depth fix: AiAccessScreen now self-guards
// -- it renders VentsAiIosComingSoonScreen on iOS regardless of entitlement
// state, independent of whether App.tsx ever reaches this component at
// all, so no future route/refactor/direct-mount can bypass it.

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

describe('AiAccessScreen: native iOS self-guard', () => {
  it('iOS + no entitlement (would normally show the paywall) -> renders Coming Soon instead, never the paywall', async () => {
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
    expect(container!.textContent).toContain('Coming soon');
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('iOS + trial at hard ceiling (would normally show the upgrade CTA) -> renders Coming Soon, no upgrade CTA', async () => {
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
    expect(container!.textContent).toContain('Coming soon');
  });

  it('Android + no entitlement: real paywall renders unchanged, same as before the iOS fix', async () => {
    getPlatformMock.mockReturnValue('android');
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

  it('Web + no entitlement: real paywall renders unchanged, same as before the iOS fix', async () => {
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
