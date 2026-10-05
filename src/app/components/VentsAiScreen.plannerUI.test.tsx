import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiScreen } from './VentsAiScreen';

// Batch 4: VENTS SI Planner UI, implementing the frozen mockup's
// P01/P07/P08/P12/P13/P23/S1-S3 screens inside the existing SI chat shell
// (VentsAiScreen.tsx) rather than a second UI system. sendVentsAiMessage
// is mocked the same way VentsAiScreen.render.test.tsx already mocks it;
// supabase is mocked per-test since the Plans room reads the real `plans`
// table and Undo calls the real RPC directly.

const sendVentsAiMessage = vi.fn();
vi.mock('../../lib/ventsAi', () => ({
  sendVentsAiMessage: (...args: any[]) => sendVentsAiMessage(...args),
}));

const supabaseFrom = vi.fn();
const supabaseRpc = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (...args: any[]) => supabaseFrom(...args),
    rpc: (...args: any[]) => supabaseRpc(...args),
  },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  sendVentsAiMessage.mockReset();
  supabaseFrom.mockReset();
  supabaseRpc.mockReset();
  supabaseRpc.mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<VentsAiScreen onClose={() => {}} />);
  });
}

function clickByText(text: string) {
  const el = Array.from(container!.querySelectorAll('div, span')).find((d) => d.textContent === text);
  if (!el) throw new Error(`"${text}" not found`);
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function clickTestId(testId: string) {
  const el = container!.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`[data-testid="${testId}"] not found`);
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function sendArrowButton() {
  return Array.from(container!.querySelectorAll('div')).find(
    (d) => d.textContent === '↑' && d.style.position === 'absolute'
  ) as HTMLDivElement;
}

function setInputAndSend(text: string) {
  const input = container!.querySelector('input') as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => sendArrowButton().dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('Plans room (P01 entry)', () => {
  it('shows a Chat/Plans toggle, and lists real plans from the plans table when Plans is selected', async () => {
    supabaseFrom.mockReturnValue({
      select: () => ({
        order: () => Promise.resolve({
          data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft', event_date: null, city: 'Lagos', total_kobo: 100000000, currency: 'NGN', created_at: '2026-01-01' }],
          error: null,
        }),
      }),
    });
    mount();
    expect(container!.textContent).toContain('Chat');
    expect(container!.textContent).toContain('Plans');

    clickByText('Plans');
    await flush();

    expect(container!.textContent).toContain('Beach Wedding');
    expect(container!.textContent).toContain('DRAFT');
    expect(container!.textContent).toContain('+ New Plan');
  });

  it('shows the empty state when the user has no plans yet (S2)', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    mount();
    clickByText('Plans');
    await flush();
    expect(container!.textContent).toContain('No plans yet');
  });

  it('shows an error state when the plans query fails (S3)', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'network down' } }) }) });
    mount();
    clickByText('Plans');
    await flush();
    expect(container!.textContent).toContain("Couldn't load your plans");
    expect(container!.textContent).toContain('network down');
  });

  it('"+ New Plan" switches to Chat and prefills the composer rather than silently doing nothing', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    mount();
    clickByText('Plans');
    await flush();
    clickTestId('si-new-plan');
    await flush();
    const input = container!.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe("I'm planning an event.");
  });
});

describe('Plan thread (one pinned SI thread per plan)', () => {
  it('opening a plan sends "Show me this plan." carrying the plan_id as hidden context, and renders the real PlanSummaryCard', async () => {
    supabaseFrom.mockReturnValue({
      select: () => ({
        order: () => Promise.resolve({
          data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft', event_date: null, city: 'Lagos', total_kobo: 100000000, currency: 'NGN', created_at: '2026-01-01' }],
          error: null,
        }),
      }),
    });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Here is your plan.',
      cards: [{
        type: 'get_plan',
        data: {
          plan_id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft',
          total_budget_naira: 1000000,
          budget_summary: { total_committed_naira: 0, total_paid_naira: 0 },
          categories: [{ category_id: 'cat-1', key: 'decoration', label: 'Decoration', allocated_naira: 650000, estimated_naira: 650000, committed_naira: 0, paid_naira: 0, assignments: [] }],
        },
      }],
    });

    mount();
    clickByText('Plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    const sentMessages = sendVentsAiMessage.mock.calls[0][0];
    expect(sentMessages[sentMessages.length - 1].content).toBe('[plan_id: plan-1] Show me this plan.');
    // The displayed bubble (not the API payload) stays clean, no leaked context tag.
    expect(container!.textContent).toContain('Show me this plan.');
    expect(container!.textContent).not.toContain('[plan_id:');

    expect(container!.textContent).toContain('Decoration');
    expect(container!.textContent).toContain('₦650,000');
    expect(container!.textContent).toContain('Plan thread · SI sees this plan');
  });

  it('reopening an already-open plan thread reuses it instead of starting a second competing one', async () => {
    supabaseFrom.mockReturnValue({
      select: () => ({
        order: () => Promise.resolve({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft', event_date: null, city: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01' }], error: null }),
      }),
    });
    sendVentsAiMessage.mockResolvedValue({ type: 'message', text: 'ok', cards: [] });

    mount();
    clickByText('Plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);

    // Back to home, back into Plans, open the same plan again.
    const backBtn = container!.querySelector('[aria-label="Back"]') as HTMLElement;
    act(() => backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    clickByText('Plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    // No second "Show me this plan." turn fired -- the existing thread was reused.
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Suggestion vs direct change vs Undo (purple PlanUpdateCard, never the amber money card)', () => {
  it('propose_plan_update renders as a suggestion that has NOT been applied, with an Apply action', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: null, city: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01' }], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: "Here's what I'd suggest.",
      cards: [{ type: 'propose_plan_update', data: { plan_id: 'plan-1', applied: false, proposed_changes: [{ category: 'decoration', label: 'Decoration', before_naira: 650000, after_naira: 450000 }] } }],
    });

    mount();
    clickByText('Plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    expect(container!.textContent).toContain('SUGGESTED CHANGE');
    expect(container!.querySelector('[data-testid="ai-plan-update-apply"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="ai-plan-update-undo"]')).toBeFalsy();
    // Never the amber money confirmation card for a plan edit.
    expect(container!.querySelector('[data-testid="ai-confirmation-card"]')).toBeFalsy();
  });

  it('tapping Apply sends a real follow-up turn through the normal pipeline, not a frontend-only state flip', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: null, city: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01' }], error: null }) }) });
    sendVentsAiMessage
      .mockResolvedValueOnce({ type: 'message', text: 'Suggestion', cards: [{ type: 'propose_plan_update', data: { plan_id: 'plan-1', applied: false, proposed_changes: [{ category: 'decoration', label: 'Decoration', before_naira: 650000, after_naira: 450000 }] } }] })
      .mockResolvedValueOnce({ type: 'message', text: 'Applied.', cards: [{ type: 'apply_plan_update', data: { plan_id: 'plan-1', change_log_id: 'log-1', applied: true, actor: 'si' } }] });

    mount();
    clickByText('Plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    clickTestId('ai-plan-update-apply');
    await flush();

    expect(sendVentsAiMessage).toHaveBeenCalledTimes(2);
    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toContain('Apply that change.');
    expect(container!.textContent).toContain('PLAN UPDATED');
    expect(container!.querySelector('[data-testid="ai-plan-update-undo"]')).toBeTruthy();
  });

  it('Undo calls the real undo_plan_change RPC directly, then refreshes the plan state', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: null, city: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01' }], error: null }) }) });
    sendVentsAiMessage
      .mockResolvedValueOnce({ type: 'message', text: 'Applied.', cards: [{ type: 'apply_plan_update', data: { plan_id: 'plan-1', change_log_id: 'log-1', applied: true, actor: 'user' } }] })
      .mockResolvedValueOnce({ type: 'message', text: 'Reverted.', cards: [] });

    mount();
    clickByText('Plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    clickTestId('ai-plan-update-undo');
    await flush();

    expect(supabaseRpc).toHaveBeenCalledWith('undo_plan_change', { p_change_log_id: 'log-1' });
    // The second AI call is the refresh asking for updated state, not a frontend-only revert.
    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toContain('Show me the updated plan');
    expect(container!.textContent).toContain('Reverted to the previous allocation.');
  });
});

describe('Provider recommendation and assignment (assigned is never booked)', () => {
  it('recommend_providers always shows the "confirm availability" note and never claims a date is available', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Here are some photographers.',
      cards: [{ type: 'recommend_providers', data: [{ provider_id: 'p1', business_name: 'Shutter Co', category: 'Photography', location: 'Lagos', starting_price_naira: 250000, is_sponsored: false, availability_note: 'Confirm availability with provider.' }] }],
    });

    mount();
    setInputAndSend('find photographers under 300k in lagos');
    await flush();

    expect(container!.textContent).toContain('Confirm availability with provider.');
    expect(container!.textContent).not.toMatch(/available on/i);
    expect(container!.textContent).toContain('Shutter Co');
  });

  it('assign_provider renders "assigned", never "booked"/"paid"/"confirmed booking", when booked is false', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Assigned.',
      cards: [{ type: 'assign_provider', data: { category: 'photography', provider_id: 'p1', agreed_amount_naira: 250000, status: 'assigned', booked: false } }],
    });

    mount();
    setInputAndSend('assign shutter co to photography');
    await flush();

    expect(container!.textContent).toContain('Provider assigned');
    expect(container!.textContent).not.toContain('Provider booked');
    expect(container!.textContent).toMatch(/not booked yet/i);
  });
});
