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

// The Plans room now reads get_plans_overview() (migration 0160), one
// aggregate RPC, rather than a plain `.from('plans').select().order()` --
// this dispatches by rpc name so other rpc calls in the same test (e.g.
// undo_plan_change) keep whatever default/override they already have.
function mockPlansOverview(result: { data: any; error: any }) {
  supabaseRpc.mockImplementation((name: string, ...args: any[]) => {
    if (name === 'get_plans_overview') return Promise.resolve(result);
    return Promise.resolve({ data: null, error: null });
  });
}

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
    mockPlansOverview({
      data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft', event_date: null, city: 'Lagos', guests: null, total_kobo: 100000000, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 0, committed_or_paid_kobo: 0, overdue_task_count: 0 }],
      error: null,
    });
    mount();
    expect(container!.textContent).toContain('Chat');
    expect(container!.textContent).toContain('Plans');

    clickTestId('si-room-plans');
    await flush();

    expect(container!.textContent).toContain('Beach Wedding');
    expect(container!.textContent).toContain('DRAFT');
    // P25's own layout: once plans exist, "+ New plan" is the small inline
    // link beside the UPCOMING header, not the big empty-state CTA.
    expect(container!.textContent).toContain('+ New plan');
  });

  it('shows the empty state when the user has no plans yet (S2)', async () => {
    mockPlansOverview({ data: [], error: null });
    mount();
    clickTestId('si-room-plans');
    await flush();
    expect(container!.textContent).toContain('No plans yet');
  });

  it('shows an error state when the plans query fails (S3)', async () => {
    mockPlansOverview({ data: null, error: { message: 'network down' } });
    mount();
    clickTestId('si-room-plans');
    await flush();
    expect(container!.textContent).toContain("Couldn't load your plans");
    expect(container!.textContent).toContain('network down');
  });

  it('S2-A: the empty Plans tab shows the exact mockup card (title/subtitle/chips/CTA), and a chip prefills the real plan-creation flow', async () => {
    mockPlansOverview({ data: [], error: null });
    mount();
    clickTestId('si-room-plans');
    await flush();

    expect(container!.textContent).toContain('No plans yet');
    expect(container!.textContent).toContain("Tell SI about an event and it'll build the plan with you.");
    expect(container!.textContent).toContain('Plan a wedding');
    expect(container!.textContent).toContain('Plan a birthday');
    expect(container!.textContent).toContain('Plan a conference');
    expect(container!.textContent).toContain('Start a plan');

    clickTestId('si-plans-empty-chip-wedding');
    await flush();
    const input = container!.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('Help me plan a wedding');
  });

  it('"+ New Plan" switches to Chat and prefills the composer rather than silently doing nothing', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    mount();
    clickTestId('si-room-plans');
    await flush();
    clickTestId('si-new-plan');
    await flush();
    const input = container!.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe("I'm planning an event.");
  });
});

describe('Plan thread (one pinned SI thread per plan)', () => {
  it('opening a plan sends "Show me this plan." carrying the plan_id as hidden context, and renders the real PlanSummaryCard', async () => {
    mockPlansOverview({
      data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft', event_date: null, city: 'Lagos', guests: null, total_kobo: 100000000, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 0, committed_or_paid_kobo: 0, overdue_task_count: 0 }],
      error: null,
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
    clickTestId('si-room-plans');
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
    mockPlansOverview({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft', event_date: null, city: null, guests: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 0, committed_or_paid_kobo: 0, overdue_task_count: 0 }], error: null });
    sendVentsAiMessage.mockResolvedValue({ type: 'message', text: 'ok', cards: [] });

    mount();
    clickTestId('si-room-plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);

    // Back to home, back into Plans, open the same plan again.
    const backBtn = container!.querySelector('[aria-label="Back"]') as HTMLElement;
    act(() => backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    clickTestId('si-room-plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    // No second "Show me this plan." turn fired -- the existing thread was reused.
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Suggestion vs direct change vs Undo (purple PlanUpdateCard, never the amber money card)', () => {
  it('propose_plan_update renders as a suggestion that has NOT been applied, with an Apply action', async () => {
    mockPlansOverview({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: null, city: null, guests: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 0, committed_or_paid_kobo: 0, overdue_task_count: 0 }], error: null });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: "Here's what I'd suggest.",
      cards: [{ type: 'propose_plan_update', data: { plan_id: 'plan-1', applied: false, proposed_changes: [{ category: 'decoration', label: 'Decoration', before_naira: 650000, after_naira: 450000 }] } }],
    });

    mount();
    clickTestId('si-room-plans');
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
    mockPlansOverview({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: null, city: null, guests: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 0, committed_or_paid_kobo: 0, overdue_task_count: 0 }], error: null });
    sendVentsAiMessage
      .mockResolvedValueOnce({ type: 'message', text: 'Suggestion', cards: [{ type: 'propose_plan_update', data: { plan_id: 'plan-1', applied: false, proposed_changes: [{ category: 'decoration', label: 'Decoration', before_naira: 650000, after_naira: 450000 }] } }] })
      .mockResolvedValueOnce({ type: 'message', text: 'Applied.', cards: [{ type: 'apply_plan_update', data: { plan_id: 'plan-1', change_log_id: 'log-1', applied: true, actor: 'si' } }] });

    mount();
    clickTestId('si-room-plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    clickTestId('ai-plan-update-apply');
    await flush();

    expect(sendVentsAiMessage).toHaveBeenCalledTimes(2);
    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toContain('Apply that change.');
    // P23's exact copy: a static "PLAN UPDATE" badge plus a separate green "✓ Applied · Undo" status line.
    expect(container!.textContent).toContain('PLAN UPDATE');
    expect(container!.textContent).toContain('✓ Applied');
    expect(container!.querySelector('[data-testid="ai-plan-update-undo"]')).toBeTruthy();
  });

  it('S1-C: while Apply is in flight it disables itself and says so, and a second tap does not send a duplicate request', async () => {
    mockPlansOverview({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: null, city: null, guests: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 0, committed_or_paid_kobo: 0, overdue_task_count: 0 }], error: null });
    let resolveApply: (v: any) => void;
    sendVentsAiMessage
      .mockResolvedValueOnce({ type: 'message', text: 'Suggestion', cards: [{ type: 'propose_plan_update', data: { plan_id: 'plan-1', applied: false, proposed_changes: [{ category: 'decoration', label: 'Decoration', before_naira: 650000, after_naira: 450000 }] } }] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveApply = resolve; }));

    mount();
    clickTestId('si-room-plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    clickTestId('ai-plan-update-apply');
    await flush();

    // Disabled + the exact mockup copy, never a fake instant "applied".
    expect(container!.textContent).toContain('Updating budget…');
    expect(container!.textContent).toContain('Apply disabled');
    expect(container!.querySelector('[data-testid="ai-plan-update-apply"]')).toBeFalsy();

    // A second tap (e.g. on the same still-visible card) must not fire a second request.
    clickTestId('ai-plan-update-applying');
    await flush();
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(2);

    await act(async () => { resolveApply!({ type: 'message', text: 'Applied.', cards: [{ type: 'apply_plan_update', data: { plan_id: 'plan-1', change_log_id: 'log-1', applied: true, actor: 'si' } }] }); await flush(); });
    expect(container!.querySelector('[data-testid="ai-plan-update-apply"]')).toBeTruthy(); // restored, not stuck disabled
  });

  it('S1-C: restores the real editable/error state if the Apply request fails, never pretending it succeeded', async () => {
    mockPlansOverview({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: null, city: null, guests: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 0, committed_or_paid_kobo: 0, overdue_task_count: 0 }], error: null });
    sendVentsAiMessage
      .mockResolvedValueOnce({ type: 'message', text: 'Suggestion', cards: [{ type: 'propose_plan_update', data: { plan_id: 'plan-1', applied: false, proposed_changes: [{ category: 'decoration', label: 'Decoration', before_naira: 650000, after_naira: 450000 }] } }] })
      .mockRejectedValueOnce(new Error('network down'));

    mount();
    clickTestId('si-room-plans');
    await flush();
    clickByText('Beach Wedding');
    await flush();

    clickTestId('ai-plan-update-apply');
    await flush();

    expect(container!.textContent).toContain('network down');
    // Apply is clickable again -- never stuck disabled, never silently "applied".
    expect(container!.querySelector('[data-testid="ai-plan-update-apply"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="ai-plan-update-undo"]')).toBeFalsy();
  });

  it('Undo calls the real undo_plan_change RPC directly, then refreshes the plan state', async () => {
    mockPlansOverview({ data: [{ id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: null, city: null, guests: null, total_kobo: null, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 0, committed_or_paid_kobo: 0, overdue_task_count: 0 }], error: null });
    sendVentsAiMessage
      .mockResolvedValueOnce({ type: 'message', text: 'Applied.', cards: [{ type: 'apply_plan_update', data: { plan_id: 'plan-1', change_log_id: 'log-1', applied: true, actor: 'user' } }] })
      .mockResolvedValueOnce({ type: 'message', text: 'Reverted.', cards: [] });

    mount();
    clickTestId('si-room-plans');
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

describe('P15 No suitable provider: real numbers only, never a dead end', () => {
  it('a price-ceiling no_match shows the real "N in {location} but all above ₦X" copy and a real "Raise to" amount', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: '',
      cards: [{
        type: 'recommend_providers',
        data: [{ no_match: true, category: 'sound', location: 'Lagos', max_price_naira: 300000, total_in_location: 3, cheapest_above_ceiling_naira: 380000 }],
      }],
    });

    mount();
    setInputAndSend('find sound providers under 300k in lagos');
    await flush();

    expect(container!.textContent).toContain('There are 3 in Lagos, but all start above ₦300,000.');
    expect(container!.textContent).toContain('Raise to ₦380,000');
    expect(container!.textContent).toContain('Add your own vendor');

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'ok', cards: [] });
    const raiseBtn = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent?.includes('Raise to ₦380,000'));
    act(() => raiseBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toContain('380,000');
  });

  it('zero providers in the location at all gets the "VENTS doesn\'t have" copy, not a misleading price comparison', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: '',
      cards: [{ type: 'recommend_providers', data: [{ no_match: true, category: 'sound', location: 'Kano', max_price_naira: 300000, total_in_location: 0, cheapest_above_ceiling_naira: null }] }],
    });

    mount();
    setInputAndSend('find sound providers in kano');
    await flush();

    expect(container!.textContent).toContain("VENTS doesn't have sound providers in Kano yet.");
    expect(container!.textContent).not.toContain('Raise to'); // no real floor price to raise to
  });
});

describe('Pre-plan guided flow (P02-P06): offer -> question -> brief -> build, no plan row until the end', () => {
  it('offer_plan_intent renders the extracted-field tiles and "Plan this event with SI" sends a real follow-up turn', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Congratulations. I can plan this with you end to end.',
      cards: [{ type: 'offer_plan_intent', data: { event_type: 'wedding', guests: 120, city: 'Lagos', total_budget_naira: 8000000, questions_remaining: 4 } }],
    });

    mount();
    setInputAndSend("I'm planning a beach wedding for 120 people in Lagos with a ₦8 million budget.");
    await flush();

    expect(container!.textContent).toContain('I CAUGHT');
    expect(container!.textContent).toContain('120');
    expect(container!.textContent).toContain('Lagos');
    expect(container!.textContent).toContain('₦8,000,000');
    expect(container!.textContent).toContain('About 4 quick questions to go.');

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'First question...', cards: [] });
    clickTestId('ai-plan-offer-card'); // no-op click on the card itself, just confirming it's present
    const acceptBtn = Array.from(container!.querySelectorAll('span')).find((s) => s.textContent === 'Plan this event with SI');
    act(() => acceptBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toBe('Yes, plan this event with SI.');
  });

  it('"Just chat" dismisses the offer card locally without sending anything', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Congratulations.',
      cards: [{ type: 'offer_plan_intent', data: { event_type: 'wedding' } }],
    });

    mount();
    setInputAndSend('plan my wedding');
    await flush();
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);

    const dismissBtn = Array.from(container!.querySelectorAll('span')).find((s) => s.textContent === 'Just chat');
    act(() => dismissBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container!.textContent).not.toContain('I CAUGHT');
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);
  });

  it('ask_plan_question (single_choice): tapping an option sends its exact label as a real follow-up turn', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: '',
      cards: [{
        type: 'ask_plan_question',
        data: {
          step: 2, step_count_estimate: 4, lead_in: '68 days — very doable.', question: 'Do you already have a venue?',
          question_type: 'single_choice',
          options: [{ id: 'has_one', label: 'Yes, I have one' }, { id: 'help', label: 'Help me find one' }],
        },
      }],
    });

    mount();
    setInputAndSend('Saturday 12 December');
    await flush();
    expect(container!.textContent).toContain('Do you already have a venue?');

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'ok', cards: [] });
    const optionRow = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent?.includes('Help me find one'));
    act(() => optionRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toBe('Help me find one');
  });

  it('ask_plan_question (multi_select): toggling chips then Done sends the comma-joined labels, capped at max_select', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: '',
      cards: [{
        type: 'ask_plan_question',
        data: {
          step: 4, question: 'What matters most?', question_type: 'multi_select', max_select: 2,
          options: [{ id: 'food', label: 'Great food' }, { id: 'photo', label: 'Photography' }, { id: 'music', label: 'Live music' }],
        },
      }],
    });

    mount();
    setInputAndSend('Elegant, modern, beachy');
    await flush();

    const chip = (label: string) => Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent?.includes(label))!;
    act(() => chip('Great food').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => chip('Photography').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // Third tap is over max_select (2) and is a no-op.
    act(() => chip('Live music').dispatchEvent(new MouseEvent('click', { bubbles: true })));

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'ok', cards: [] });
    const doneBtn = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Done');
    act(() => doneBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toBe('Great food, Photography');
  });

  it('preview_plan_brief renders the brief and "Build my plan" sends every field (title/type/date/city/setting/guests/budget/style/priorities) as a real follow-up turn', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: '',
      cards: [{
        type: 'preview_plan_brief',
        data: {
          title: 'Beach Wedding', event_type: 'wedding', city: 'Lagos', setting: 'Outdoor', guests: 120,
          total_budget_naira: 8000000, style: ['Elegant', 'Modern', 'Beach'], priorities: ['Great food', 'Photography', 'Live music'],
        },
      }],
    });

    mount();
    setInputAndSend('that covers it');
    await flush();

    expect(container!.textContent).toContain('Beach Wedding');
    expect(container!.textContent).toContain('₦8,000,000');
    expect(container!.textContent).toContain('1 · Great food');
    expect(container!.textContent).toContain('Not booked yet'); // no venue_status given -- shown in amber, not fabricated.

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'Building...', cards: [] });
    const buildBtn = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Build my plan');
    act(() => buildBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    const sentText = sendVentsAiMessage.mock.calls[1][0].at(-1).content;
    expect(sentText.toLowerCase()).toMatch(/^build my plan/);
    expect(sentText).toContain('Beach Wedding');
    expect(sentText).toContain('Lagos');
    expect(sentText).toContain('120');
    expect(sentText).toContain('₦8,000,000');
    expect(sentText).toContain('Great food');
  });

  it('P05 editors: editing guests and budget updates the card immediately and those edited values (not the originals) are what Build sends', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: '',
      cards: [{ type: 'preview_plan_brief', data: { title: 'Beach Wedding', event_type: 'wedding', city: 'Lagos', guests: 120, total_budget_naira: 8000000 } }],
    });

    mount();
    setInputAndSend('that covers it');
    await flush();
    expect(container!.textContent).toContain('120'); // original guest count showing

    // Open the Guests row, bump it up twice, confirm with Done.
    clickTestId('ai-brief-row-guests');
    clickTestId('ai-brief-guests-plus');
    clickTestId('ai-brief-guests-plus');
    clickTestId('ai-brief-row-guests-done');
    // Card reflects the edit immediately, without anything sent yet.
    expect(container!.textContent).toContain('122');
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);

    // Open Budget, replace the value, confirm.
    clickTestId('ai-brief-row-budget');
    const budgetInput = container!.querySelector('[data-testid="ai-plan-brief-card"] input[type="number"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(budgetInput, '9500000');
      budgetInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    clickTestId('ai-brief-row-budget-done');
    expect(container!.textContent).toContain('₦9,500,000');

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'Building...', cards: [] });
    const buildBtn = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Build my plan');
    act(() => buildBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    // The EDITED values reach the real chat turn, not the original 120 / ₦8,000,000.
    const sentText = sendVentsAiMessage.mock.calls[1][0].at(-1).content;
    expect(sentText).toContain('guests 122');
    expect(sentText).toContain('₦9,500,000');
    expect(sentText).not.toContain('guests 120');
    expect(sentText).not.toContain('₦8,000,000');
  });

  it('P05 editors: re-tapping an open row cancels that edit without committing it', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: '',
      cards: [{ type: 'preview_plan_brief', data: { title: 'Beach Wedding', event_type: 'wedding', guests: 120 } }],
    });

    mount();
    setInputAndSend('that covers it');
    await flush();

    clickTestId('ai-brief-row-guests');
    expect(container!.querySelector('[data-testid="ai-brief-guests-plus"]')).toBeTruthy();
    clickTestId('ai-brief-guests-plus'); // bump the in-progress draft, but never confirm with Done
    clickTestId('ai-brief-row-guests'); // tapping the row again cancels, discarding the draft
    expect(container!.querySelector('[data-testid="ai-brief-guests-plus"]')).toBeFalsy();
    expect(container!.textContent).toContain('120'); // unchanged -- the uncommitted draft never landed
  });

  it('P05 editors: the date row uses a native date input defaulting to today or later, and city opens the real PickerSheet', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: '',
      cards: [{ type: 'preview_plan_brief', data: { title: 'Beach Wedding', event_type: 'wedding' } }],
    });

    mount();
    setInputAndSend('that covers it');
    await flush();

    clickTestId('ai-brief-row-date');
    const dateInput = container!.querySelector('[data-testid="ai-plan-brief-card"] input[type="date"]') as HTMLInputElement;
    expect(dateInput).toBeTruthy();
    const todayIso = new Date().toISOString().slice(0, 10);
    expect(dateInput.min).toBe(todayIso);

    clickTestId('ai-brief-row-location');
    const cityTrigger = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Choose a city');
    act(() => cityTrigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container!.textContent).toContain('Lagos'); // the real PickerSheet's own option list, not a fabricated one
  });

  it('P06: the "Build my plan." turn shows BuildingPlanLoader instead of the generic typing dots while it is in flight', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    let resolveSend: (v: any) => void;
    sendVentsAiMessage.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));

    mount();
    setInputAndSend('Build my plan.');
    await flush();

    expect(container!.querySelector('[data-testid="ai-building-plan-loader"]')).toBeTruthy();
    expect(container!.textContent).toContain('Usually under 20 seconds.');

    await act(async () => { resolveSend!({ type: 'message', text: 'Your plan is ready.', cards: [] }); await flush(); });
    expect(container!.querySelector('[data-testid="ai-building-plan-loader"]')).toBeFalsy();
  });

  it('S3-A: a failed "Build my plan." turn shows the real error card, and "Try again" re-sends the exact same turn', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockRejectedValueOnce(new Error('network down'));

    mount();
    setInputAndSend('Build my plan with these final details: title "X".');
    await flush();

    expect(container!.querySelector('[data-testid="ai-plan-build-error-card"]')).toBeTruthy();
    expect(container!.textContent).toContain("Couldn't build your plan");
    expect(container!.textContent).toContain('Nothing was charged or changed.');
    // The generic banner is replaced by this specific card, not shown alongside it.
    expect(container!.querySelector('[data-testid="ai-generic-error-retry"]')).toBeFalsy();

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'Built it.', cards: [] });
    clickTestId('ai-plan-build-error-retry');
    await flush();

    expect(sendVentsAiMessage).toHaveBeenCalledTimes(2);
    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toBe('Build my plan with these final details: title "X".');
    expect(container!.querySelector('[data-testid="ai-plan-build-error-card"]')).toBeFalsy();
  });

  it('S3-A: "Edit brief" sends a real chat turn asking to edit, never a dead button', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockRejectedValueOnce(new Error('network down'));

    mount();
    setInputAndSend('Build my plan with these final details: title "X".');
    await flush();

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'Sure, what would you like to change?', cards: [] });
    clickTestId('ai-plan-build-error-edit');
    await flush();

    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toContain('edit the brief');
  });

  it('S3-D: a generic (non-plan-build) failed turn keeps the existing banner, and Retry re-sends the exact same turn', async () => {
    supabaseFrom.mockReturnValue({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) });
    sendVentsAiMessage.mockRejectedValueOnce(new Error('network down'));

    mount();
    setInputAndSend('What providers do you have for catering?');
    await flush();

    expect(container!.textContent).toContain('network down');
    expect(container!.querySelector('[data-testid="ai-plan-build-error-card"]')).toBeFalsy();
    expect(container!.querySelector('[data-testid="ai-generic-error-retry"]')).toBeTruthy();

    sendVentsAiMessage.mockResolvedValueOnce({ type: 'message', text: 'Here you go.', cards: [] });
    clickTestId('ai-generic-error-retry');
    await flush();

    expect(sendVentsAiMessage).toHaveBeenCalledTimes(2);
    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toBe('What providers do you have for catering?');
  });
});

// A plain `.update()/.delete().eq('id', ...)` chain, thenable at `.eq()` --
// matches exactly how PlansListView's rename/archive/delete calls are
// shaped (no `.select()` chained after), unlike the read-side makeChain
// used elsewhere in this file.
function plansActionChain(result: { data: any; error: any } = { data: null, error: null }) {
  const chain: any = {};
  chain.update = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.eq = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('P25 Plans list: Rename/Archive/Delete/Duplicate only ever touch the caller\'s own plan', () => {
  const PLAN_ROW = { id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: '2026-12-12', city: 'Lagos', guests: 120, total_kobo: 800000000, currency: 'NGN', created_at: '2026-01-01', readiness_pct: 47, committed_or_paid_kobo: 435000000, overdue_task_count: 0 };

  it('Rename calls a real plans.update scoped to this plan\'s id, never a client-side-only title change', async () => {
    const actionChain = plansActionChain();
    mockPlansOverview({ data: [PLAN_ROW], error: null });
    supabaseFrom.mockImplementation(() => actionChain);

    mount();
    clickTestId('si-room-plans');
    await flush();
    clickTestId(`si-plan-menu-${PLAN_ROW.id}`);
    await flush();
    clickTestId(`si-plan-rename-${PLAN_ROW.id}`);
    await flush();

    const input = container!.querySelector('[data-testid="si-plan-rename-input"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Beach Wedding (updated)');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    clickTestId('si-plan-rename-save');
    await flush();

    expect(supabaseFrom).toHaveBeenCalledWith('plans');
    expect(actionChain.update).toHaveBeenCalledWith({ title: 'Beach Wedding (updated)' });
    expect(actionChain.eq).toHaveBeenCalledWith('id', PLAN_ROW.id);
  });

  it('Archive updates status to archived via plans.update, scoped to this plan\'s row', async () => {
    const actionChain = plansActionChain();
    mockPlansOverview({ data: [PLAN_ROW], error: null });
    supabaseFrom.mockImplementation(() => actionChain);

    mount();
    clickTestId('si-room-plans');
    await flush();
    clickTestId(`si-plan-menu-${PLAN_ROW.id}`);
    await flush();
    clickTestId(`si-plan-archive-${PLAN_ROW.id}`);
    await flush();

    expect(actionChain.update).toHaveBeenCalledWith({ status: 'archived' });
    expect(actionChain.eq).toHaveBeenCalledWith('id', PLAN_ROW.id);
  });

  it('Delete requires confirmation, then calls plans.delete scoped to this plan\'s id', async () => {
    const actionChain = plansActionChain();
    mockPlansOverview({ data: [PLAN_ROW], error: null });
    supabaseFrom.mockImplementation(() => actionChain);

    mount();
    clickTestId('si-room-plans');
    await flush();
    clickTestId(`si-plan-menu-${PLAN_ROW.id}`);
    await flush();
    clickTestId(`si-plan-delete-${PLAN_ROW.id}`);
    await flush();

    // Not deleted yet -- ConfirmDialog still showing.
    expect(actionChain.delete).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('This can\'t be undone');

    clickTestId('si-plan-delete-confirm');
    await flush();

    expect(actionChain.delete).toHaveBeenCalled();
    expect(actionChain.eq).toHaveBeenCalledWith('id', PLAN_ROW.id);
  });

  it('Duplicate as template calls the real duplicate_plan_as_template RPC with this plan\'s id, never a frontend-only copy', async () => {
    mockPlansOverview({ data: [PLAN_ROW], error: null });
    supabaseRpc.mockImplementation((name: string) => {
      if (name === 'duplicate_plan_as_template') return Promise.resolve({ data: { id: 'plan-2' }, error: null });
      if (name === 'get_plans_overview') return Promise.resolve({ data: [PLAN_ROW], error: null });
      return Promise.resolve({ data: null, error: null });
    });

    mount();
    clickTestId('si-room-plans');
    await flush();
    clickTestId(`si-plan-menu-${PLAN_ROW.id}`);
    await flush();
    clickTestId(`si-plan-duplicate-${PLAN_ROW.id}`);
    await flush();

    expect(supabaseRpc).toHaveBeenCalledWith('duplicate_plan_as_template', { p_plan_id: PLAN_ROW.id, p_title: 'Beach Wedding (template)' });
  });
});

describe('P27 Plan disambiguation: picking a plan attaches THIS thread to it, never guesses', () => {
  it('renders real candidates with real per-plan estimates, and "Something else" continues as a normal provider search', async () => {
    mockPlansOverview({ data: [], error: null });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Is this for one of your plans?',
      cards: [{
        type: 'disambiguate_plans',
        data: {
          category_hint: 'caterer',
          candidates: [
            { plan_id: 'plan-mum', title: "Mum's 60th", status: 'active', event_date: '2026-11-07', city: 'Ibadan', category_estimated_naira: 450000 },
            { plan_id: 'plan-dinner', title: 'Team end-of-year dinner', status: 'draft', event_date: null, city: 'Lagos', category_estimated_naira: null },
          ],
        },
      }],
    }).mockResolvedValueOnce({ type: 'message', text: 'Sure, searching generally.', cards: [] });

    mount();
    setInputAndSend('I still need a caterer');
    await flush();

    expect(container!.textContent).toContain("Mum's 60th");
    expect(container!.textContent).toContain('₦450,000');
    expect(container!.textContent).toContain('Something else');

    clickTestId('ai-plan-disambiguation-something-else');
    await flush();

    expect(sendVentsAiMessage.mock.calls[1][0].at(-1).content).toContain('Something else');
  });

  it('picking a candidate attaches the thread to that plan (header chip appears) and continues the original request with plan context', async () => {
    mockPlansOverview({ data: [], error: null });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Is this for one of your plans?',
      cards: [{
        type: 'disambiguate_plans',
        data: {
          category_hint: 'caterer',
          candidates: [{ plan_id: 'plan-mum', title: "Mum's 60th", status: 'active', event_date: '2026-11-07', city: 'Ibadan', category_estimated_naira: 450000 }],
        },
      }],
    }).mockResolvedValueOnce({ type: 'message', text: 'Looking at caterers for that plan.', cards: [] });

    mount();
    setInputAndSend('I still need a caterer');
    await flush();

    clickTestId('ai-plan-disambiguation-option-plan-mum');
    await flush();

    const secondCallMessages = sendVentsAiMessage.mock.calls[1][0];
    expect(secondCallMessages.at(-1).content).toBe('[plan_id: plan-mum] Use my "Mum\'s 60th" plan for this.');
    expect(container!.textContent).toContain('Plan thread · SI sees this plan');
  });

  it('a disambiguate_plans result with zero candidates renders no card -- the model\'s own prose explains why instead', async () => {
    mockPlansOverview({ data: [], error: null });
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Every one of your plans already has catering sorted.',
      cards: [{ type: 'disambiguate_plans', data: { category_hint: 'caterer', candidates: [] } }],
    });

    mount();
    setInputAndSend('I still need a caterer');
    await flush();

    expect(container!.querySelector('[data-testid="ai-plan-disambiguation-card"]')).toBeFalsy();
    expect(container!.textContent).toContain('Every one of your plans already has catering sorted.');
  });
});
