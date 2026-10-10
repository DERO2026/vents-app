import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiScreen } from './VentsAiScreen';

// "VENTS AI Home Review.dc.html" implementation: a real status pill
// (sourced from get_my_ai_entitlement(), never fabricated), Mood/Budget/
// Area chips that compose into the real composer text, a 16px composer
// input (mobile Safari zoom-on-focus fix), and "Recent conversations"
// omitted entirely when there are none (not an empty-state filler line).

const sendVentsAiMessage = vi.fn();
vi.mock('../../lib/ventsAi', () => ({
  sendVentsAiMessage: (...args: any[]) => sendVentsAiMessage(...args),
}));

const rpc = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
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
  sendVentsAiMessage.mockReset();
  rpc.mockReset();
});

async function mount() {
  rpc.mockImplementation((name: string) => {
    if (name === 'get_plans_overview') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<VentsAiScreen onClose={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('VentsAiScreen Home: real plan label (get_my_ai_entitlement, not fabricated, never clickable)', () => {
  it('shows "PLAN: VENTS AI" for a real active ai entitlement', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_my_ai_entitlement') return Promise.resolve({ data: { plan_id: 'ai', status: 'active', used_units: 3, included_units: 50, hard_ceiling: 75 }, error: null });
      if (name === 'get_plans_overview') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<VentsAiScreen onClose={() => {}} />); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('PLAN: VENTS AI');
  });

  it('shows "PLAN: VENTS AI TRIAL" for a real trialing entitlement', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_my_ai_entitlement') return Promise.resolve({ data: { plan_id: 'trial', status: 'trialing', used_units: 2, hard_ceiling: 15 }, error: null });
      if (name === 'get_plans_overview') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<VentsAiScreen onClose={() => {}} />); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('PLAN: VENTS AI TRIAL');
  });

  it('shows an honest non-subscriber message for an expired entitlement, never a fabricated plan name', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_my_ai_entitlement') return Promise.resolve({ data: { plan_id: 'ai', status: 'expired' }, error: null });
      if (name === 'get_plans_overview') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<VentsAiScreen onClose={() => {}} />); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('No active VENTS AI subscription');
    expect(container.textContent).not.toContain('PLAN: VENTS AI');
  });

  it('the plan label itself is not a clickable button -- only the separate "View Plans" action opens the paywall', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_ai_plans_public') return Promise.resolve({ data: [], error: null });
      if (name === 'get_plans_overview') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await mount();
    const label = container!.querySelector('[data-testid="vents-ai-plan-label"]')!;
    expect(label.getAttribute('role')).not.toBe('button');
    await act(async () => {
      label.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    // Clicking the plan label does nothing -- AiPlansScreen must not open.
    expect(container!.textContent).not.toContain('VENTS AI Plans');

    const viewPlansButton = container!.querySelector('[data-testid="vents-ai-view-plans"]') as HTMLButtonElement;
    await act(async () => {
      viewPlansButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('VENTS AI Plans');
  });

  // Regression test: a prior report claimed AiPlansScreen was imported but
  // never rendered, and that opening it required subscription enforcement
  // to be on. Neither was true on inspection (the import already had a
  // real `{showPlans && <AiPlansScreen .../>}` render and an unconditional
  // onClick), but this test pins down exactly the two things that report
  // was actually right to ask for: (1) an explicit, unmistakable "View
  // Plans" action distinct from the small status pill, not just the pill
  // alone, and (2) it must be reachable with no enforcement/entitlement
  // mock at all -- this test's own rpc mock never references
  // ai_entitlement_enforced or any "enforcement on" state, because
  // HomeView's plans entry point was never gated on that flag to begin
  // with. If AiPlansScreen is ever imported again without being rendered,
  // or this button stops calling onViewPlans, this test fails.
  it('a visible "View Plans" button (not just the status pill) opens AiPlansScreen, with no enforcement flag involved', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_ai_plans_public') return Promise.resolve({ data: [], error: null });
      if (name === 'get_plans_overview') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await mount();

    const viewPlansButton = container!.querySelector('button[data-testid="vents-ai-view-plans"]') as HTMLButtonElement;
    expect(viewPlansButton).toBeTruthy();
    expect(viewPlansButton.textContent).toContain('View Plans');
    expect(container!.textContent).not.toContain('VENTS AI Plans');

    await act(async () => {
      viewPlansButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('VENTS AI Plans');
    // No RPC call this test made ever referenced enforcement -- the path
    // from "View Plans" tap to AiPlansScreen rendering never checked it.
    expect(rpc.mock.calls.some(([name]) => name === 'ai_entitlement_enforced')).toBe(false);
  });

  it('closing AiPlansScreen returns to the real VENTS AI Home screen, not a blank or stuck state', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_ai_plans_public') return Promise.resolve({ data: [], error: null });
      if (name === 'get_plans_overview') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await mount();

    const viewPlansButton = container!.querySelector('button[data-testid="vents-ai-view-plans"]') as HTMLButtonElement;
    await act(async () => { viewPlansButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(container!.textContent).toContain('VENTS AI Plans');

    const closeButton = Array.from(container!.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Close')!;
    expect(closeButton).toBeTruthy();
    act(() => { closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container!.textContent).not.toContain('VENTS AI Plans');
    expect(container!.querySelector('input[placeholder="Ask about events or plans"]')).toBeTruthy();
  });
});

describe('VentsAiScreen Home: Mood/Budget/Area chips', () => {
  it('selecting a Mood option composes it into the real composer text', async () => {
    await mount();
    const moodChip = Array.from(container!.querySelectorAll('div[role="button"]')).find((d) => d.textContent?.includes('Mood'))!;
    act(() => { moodChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const option = Array.from(container!.querySelectorAll('div,span')).find((el) => el.textContent?.trim() === 'Chill')!;
    expect(option).toBeTruthy();
    act(() => { option.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const input = container!.querySelector('input[placeholder="Ask about events or plans"]') as HTMLInputElement;
    expect(input.value.toLowerCase()).toContain('chill');
  });

  it('combines Mood + a custom Budget amount into one composer line', async () => {
    // Budget presets ("under 10k"/"over 150k") were removed -- the only
    // way to set a budget now is the custom-amount field, see the
    // dedicated coverage in VentsAiScreen.homeRedesign.test.tsx.
    await mount();
    const moodChip = Array.from(container!.querySelectorAll('div[role="button"]')).find((d) => d.textContent?.includes('Mood'))!;
    act(() => { moodChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => {
      Array.from(container!.querySelectorAll('div,span')).find((el) => el.textContent?.trim() === 'Adventure')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const budgetChip = Array.from(container!.querySelectorAll('div[role="button"]')).find((d) => d.textContent?.includes('Budget'))!;
    act(() => { budgetChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const customInput = container!.querySelector('[data-testid="vents-ai-tune-budget-custom"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(customInput, '20000');
      customInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      (container!.querySelector('[data-testid="vents-ai-tune-budget-custom-apply"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const input = container!.querySelector('input[placeholder="Ask about events or plans"]') as HTMLInputElement;
    expect(input.value.toLowerCase()).toContain('20,000');
  });
});

describe('VentsAiScreen Home: composer avoids mobile Safari zoom-on-focus', () => {
  it('the Home composer input is 16px (not under the 16px Safari-zoom threshold)', async () => {
    await mount();
    const input = container!.querySelector('input[placeholder="Ask about events or plans"]') as HTMLInputElement;
    expect(input.style.fontSize).toBe('16px');
  });
});

describe('VentsAiScreen Home: Recent Conversations omitted (not empty-filler) when none exist', () => {
  it('does not render a "Recent" section or filler text with zero conversations this session', async () => {
    await mount();
    expect(container!.textContent).not.toContain('RECENT CONVERSATIONS');
    expect(container!.textContent).not.toContain('No conversations yet');
  });

  it('shows the real section once a conversation exists (seeded by a real sent message)', async () => {
    sendVentsAiMessage.mockResolvedValueOnce({ type: 'text', text: 'Here you go.', cards: [] });
    await mount();

    const input = container!.querySelector('input[placeholder="Ask about events or plans"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Plan a birthday');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendBtn = Array.from(container!.querySelectorAll('div')).find((d) => d.textContent === '↑' && d.style.position === 'absolute') as HTMLDivElement;
    await act(async () => {
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Back to Home (close the conversation) to check the Recent list.
    const backArrow = Array.from(container!.querySelectorAll('div')).find((d) => d.textContent === '←')!;
    act(() => { backArrow.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container!.textContent).toContain('RECENT CONVERSATIONS');
    expect(container!.textContent).toContain('Plan a birthday');
  });
});
