import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Phase 9 -- VENTS AI subscription/entitlement foundation UI. These tests
// prove the gate's decision logic against exactly what
// get_my_ai_entitlement()/ai_entitlement_enforced() can return -- never
// against anything the client itself computes. supabase.rpc is mocked at
// the module level (same approach as elsewhere in this repo); no real
// network/Anthropic/Supabase call happens.

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

describe('AiAccessScreen: enforcement OFF (current production default)', () => {
  it('calls onContinue immediately and renders nothing, without ever fetching entitlement', async () => {
    mockRpc.mockImplementation(rpcImpl({ ai_entitlement_enforced: { data: false, error: null } }));
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalledWith('get_my_ai_entitlement');
    expect(container!.textContent).toBe('');
  });

  it('treats an unreadable enforcement flag the same as off -- never gates on an error', async () => {
    mockRpc.mockImplementation(rpcImpl({ ai_entitlement_enforced: { data: null, error: new Error('boom') } }));
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('AiAccessScreen: enforcement ON', () => {
  function withEntitlement(entitlement: any) {
    mockRpc.mockImplementation(
      rpcImpl({
        ai_entitlement_enforced: { data: true, error: null },
        get_my_ai_entitlement: { data: entitlement, error: null },
      })
    );
  }

  it('no entitlement row at all -> paywall, trial offer shown, onContinue never called', async () => {
    withEntitlement({ plan_id: null, status: 'inactive', trial_used: false });
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('premium feature');
    expect(container!.textContent).toContain('free');
  });

  it('trial already used -> paywall shows plans, no trial CTA, onContinue never called', async () => {
    withEntitlement({ plan_id: null, status: 'inactive', trial_used: true });
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).not.toHaveBeenCalled();
    expect(container!.textContent).not.toContain('Start your free');
    expect(container!.textContent).toContain('Choose a plan');
  });

  it('active trial under its ceiling -> onContinue fires, nothing rendered', async () => {
    withEntitlement({ plan_id: 'trial', status: 'trialing', trial_used: true, used_units: 5, included_units: 15, hard_ceiling: 15 });
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toBe('');
  });

  it('trial at its hard ceiling -> blocked, upgrade CTA, onContinue never called', async () => {
    withEntitlement({ plan_id: 'trial', status: 'trialing', trial_used: true, used_units: 15, included_units: 15, hard_ceiling: 15 });
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('trial is complete');
  });

  it('active paid plan under included allowance -> onContinue fires', async () => {
    withEntitlement({ plan_id: 'ai', status: 'active', trial_used: true, used_units: 10, included_units: 50, hard_ceiling: 75 });
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('active paid plan AT the hard ceiling (even if over included) -> blocked, never allowed through', async () => {
    withEntitlement({ plan_id: 'ai', status: 'active', trial_used: true, used_units: 75, included_units: 50, hard_ceiling: 75 });
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("reached this period's AI limit");
  });

  it('explicit status=expired -> expired/renewal state, onContinue never called', async () => {
    withEntitlement({ plan_id: 'ai', status: 'expired', trial_used: true, used_units: 10, included_units: 50, hard_ceiling: 75 });
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('plan has ended');
  });

  it('period_end in the past with no grace_until -> treated as expired for display, even if status is stale', async () => {
    withEntitlement({
      plan_id: 'ai', status: 'active', trial_used: true, used_units: 10, included_units: 50, hard_ceiling: 75,
      period_end: new Date(Date.now() - 86400000).toISOString(), grace_until: null,
    });
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('plan has ended');
  });

  it('entitlement RPC error while enforcement is genuinely on -> FAILS CLOSED, onContinue never called', async () => {
    mockRpc.mockImplementation(
      rpcImpl({
        ai_entitlement_enforced: { data: true, error: null },
        get_my_ai_entitlement: { data: null, error: new Error('db unavailable') },
      })
    );
    const onContinue = vi.fn();
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={onContinue} />);
    });
    await flush();
    expect(onContinue).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("couldn't check your access");
  });

  it('no onUpgrade/onStartTrial provided -> CTA shows a "not yet available" notice, never a fake success', async () => {
    withEntitlement({ plan_id: null, status: 'inactive', trial_used: false });
    act(() => {
      root!.render(<AiAccessScreen onClose={() => {}} onContinue={() => {}} />);
    });
    await flush();
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Start your free'));
    expect(btn).toBeTruthy();
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container!.textContent).toMatch(/open soon|not .*available/i);
  });
});
