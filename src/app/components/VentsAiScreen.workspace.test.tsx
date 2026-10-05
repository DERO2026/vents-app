import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiScreen } from './VentsAiScreen';

// Covers the Plan Workspace screen's P09 (allocation sheet), P10 (category
// detail), and P11 (Team tab) -- all reached via direct supabase.from/.rpc
// calls, never through sendVentsAiMessage (the Workspace is deliberately
// not a chat surface; see fetchPlanWorkspace's own comment). supabase is
// mocked per-table/per-rpc-name below since a single fixed mockReturnValue
// (as plannerUI.test.tsx uses for its simpler Plans-list-only cases) can't
// serve the Workspace's several different real tables/RPCs in one test.

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
  sessionStorage.clear();
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

// Every chain method returns itself; the chain is itself thenable
// (resolving the canned {data, error}), same pattern as
// aiTools.planTools.test.ts's makeChain for the real PostgrestFilterBuilder.
// `singleResult` lets one table mock serve two different real call shapes
// against the same table -- HomeView's Plans-list read (`.select().order()`,
// expects an array) and fetchPlanWorkspace's own single-plan read
// (`.select().eq().single()`, expects one row) both hit `plans`, and a real
// Postgrest client would resolve each differently too.
function makeChain(result: { data: any; error: any }, singleResult?: { data: any; error: any }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'insert']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(singleResult ?? result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(singleResult ?? result));
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const PLAN_ROW = { id: 'plan-1', title: 'Beach Wedding', event_type: 'wedding', status: 'active', event_date: '2026-12-12', city: 'Lagos', guests: 120, total_kobo: 800000000 };
const CATEGORY_ROWS = [
  { id: 'cat-decor', key: 'decoration', label: 'Decoration', allocated_kobo: 90000000, is_priority: false, sort: 1 },
  { id: 'cat-photo', key: 'photography', label: 'Photography', allocated_kobo: 50000000, is_priority: true, sort: 2 },
];
const ASSIGNMENT_ROWS = [
  { id: 'asg-1', category_id: 'cat-photo', provider_id: 'prov-1', own_vendor_name: null, agreed_kobo: 45000000, status: 'booked' },
];
const PROVIDER_ROWS = [{ id: 'prov-1', business_name: 'Ade Studios', category: 'Photography', location: 'Lekki' }];
const TASK_ROWS = [
  { id: 'task-1', category_id: 'cat-photo', title: 'Book photographer', offset_days: null, due_override: null, done_at: '2026-10-01T00:00:00Z', source: 'si', completes_on_booking: true },
  { id: 'task-2', category_id: 'cat-photo', title: 'Confirm arrival time', offset_days: 7, due_override: null, done_at: null, source: 'user', completes_on_booking: false },
];

function mockWorkspaceTables(overrides: Partial<Record<string, any>> = {}) {
  supabaseFrom.mockImplementation((table: string) => {
    if (overrides[table]) return overrides[table];
    switch (table) {
      case 'plans': return makeChain({ data: [PLAN_ROW], error: null }, { data: PLAN_ROW, error: null });
      case 'plan_categories': return makeChain({ data: CATEGORY_ROWS, error: null });
      case 'plan_assignments': return makeChain({ data: ASSIGNMENT_ROWS, error: null });
      case 'service_providers': return makeChain({ data: PROVIDER_ROWS, error: null });
      case 'plan_tasks': return makeChain({ data: TASK_ROWS, error: null });
      default: return makeChain({ data: [], error: null });
    }
  });
}

async function openWorkspace() {
  mount();
  clickTestId('si-room-plans');
  await flush();
  clickTestId('si-plan-open-workspace');
  await flush();
}

describe('Plan Workspace data (P07-P11): reads the real tables directly, never through the model', () => {
  it('fetchPlanWorkspace joins provider business_name/category/location onto each assignment', async () => {
    mockWorkspaceTables();
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-budget');
    await flush();

    expect(container!.textContent).toContain('Decoration');
    expect(container!.textContent).toContain('Photography');

    clickTestId('workspace-budget-row-photography');
    await flush();
    expect(container!.textContent).toContain('Ade Studios');
    expect(container!.textContent).toContain('Lekki');
  });
});

describe('P10 Category detail', () => {
  it('shows the real assigned provider, the stat grid, and tasks with "via VENTS" locked on a completes_on_booking task', async () => {
    mockWorkspaceTables();
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-budget');
    await flush();
    clickTestId('workspace-budget-row-photography');
    await flush();

    expect(container!.textContent).toContain('₦500,000'); // allocated
    expect(container!.textContent).toContain('₦450,000'); // paid
    expect(container!.textContent).toContain('Book photographer');
    expect(container!.textContent).toContain('via VENTS');
    expect(container!.textContent).toContain('Confirm arrival time');
  });

  it('a completes_on_booking task cannot be unticked -- clicking it sends no update', async () => {
    mockWorkspaceTables();
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-budget');
    await flush();
    clickTestId('workspace-budget-row-photography');
    await flush();

    supabaseFrom.mockClear();
    const lockedRow = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.getAttribute('style')?.includes('cursor: default') && el.textContent === '✓');
    if (lockedRow) act(() => lockedRow.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(supabaseFrom).not.toHaveBeenCalledWith('plan_tasks');
  });

  it('a manual task CAN be toggled -- clicking it calls a real plan_tasks update, not a frontend-only flip', async () => {
    // plan_tasks is read by fetchPlanWorkspace's initial load AND written by
    // toggleTask's update -- one shared chain serves both call shapes
    // (select->eq, and update->eq) since supabase.from('plan_tasks') always
    // returns the same object regardless of which chain is built off it.
    const sharedPlanTasksChain = makeChain({ data: TASK_ROWS, error: null });
    sharedPlanTasksChain.update = vi.fn(() => makeChain({ data: null, error: null }));
    supabaseFrom.mockImplementation((table: string) => {
      if (table === 'plan_tasks') return sharedPlanTasksChain;
      if (table === 'plans') return makeChain({ data: [PLAN_ROW], error: null }, { data: PLAN_ROW, error: null });
      if (table === 'plan_categories') return makeChain({ data: CATEGORY_ROWS, error: null });
      if (table === 'plan_assignments') return makeChain({ data: ASSIGNMENT_ROWS, error: null });
      if (table === 'service_providers') return makeChain({ data: PROVIDER_ROWS, error: null });
      return makeChain({ data: [], error: null });
    });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-budget');
    await flush();
    clickTestId('workspace-budget-row-photography');
    await flush();

    const manualRow = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => (el as HTMLElement).style.cursor === 'pointer' && el.parentElement?.textContent?.includes('Confirm arrival time'));
    expect(manualRow).toBeTruthy();
    act(() => manualRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    expect(sharedPlanTasksChain.update).toHaveBeenCalledWith(expect.objectContaining({ done_at: expect.any(String) }));
  });
});

describe('P09 Allocation sheet: Save calls the real apply_plan_allocation_changes RPC directly', () => {
  it('opens from Category Detail\'s Edit link, and Save sends the real RPC with the edited amount', async () => {
    mockWorkspaceTables();
    supabaseRpc.mockImplementation((name: string) => {
      if (name === 'search_services_fuzzy_filtered') return Promise.resolve({ data: [{ starting_price: 450000 }, { starting_price: 500000 }], error: null });
      if (name === 'apply_plan_allocation_changes') return Promise.resolve({ data: 'change-log-1', error: null });
      return Promise.resolve({ data: null, error: null });
    });

    await openWorkspace();
    clickTestId('workspace-tab-budget');
    await flush();
    clickTestId('workspace-budget-row-decoration');
    await flush();
    clickTestId('ai-category-edit');
    await flush();

    expect(container!.textContent).toContain('2 found'); // the real floor-price/count line

    clickTestId('ai-allocation-plus');
    clickTestId('ai-allocation-plus'); // +₦100k (2 x ₦50k steps) over the ₦900,000 allocated

    clickTestId('ai-allocation-save');
    await flush();

    const applyCall = supabaseRpc.mock.calls.find((c) => c[0] === 'apply_plan_allocation_changes');
    expect(applyCall).toBeTruthy();
    const changes = applyCall![1].p_changes as { category_id: string; new_allocated_kobo: number }[];
    const decorChange = changes.find((c) => c.category_id === 'cat-decor');
    // Decoration starts at ₦900,000 (90,000,000 kobo); two +₦50k steps -> ₦1,000,000 = 100,000,000 kobo.
    expect(decorChange?.new_allocated_kobo).toBe(100000000);
    // The ₦100,000 delta is taken from Unallocated (the sheet's default source), never invented.
    expect(changes).toHaveLength(1);
  });

  it('Cancel closes the sheet without calling the RPC', async () => {
    mockWorkspaceTables();
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-budget');
    await flush();
    clickTestId('workspace-budget-row-decoration');
    await flush();
    clickTestId('ai-category-edit');
    await flush();
    clickByText('Cancel');

    expect(supabaseRpc.mock.calls.some((c) => c[0] === 'apply_plan_allocation_changes')).toBe(false);
  });
});

describe('P11 Team tab', () => {
  it('shows real assignment status glyphs (booked vs. open) and a real per-category match count for open slots', async () => {
    mockWorkspaceTables();
    supabaseRpc.mockImplementation((name: string) => {
      if (name === 'search_services_fuzzy_filtered') return Promise.resolve({ data: [{ starting_price: 450000 }], error: null });
      return Promise.resolve({ data: [], error: null });
    });

    await openWorkspace();
    clickTestId('workspace-tab-team');
    await flush();
    await flush();

    expect(container!.textContent).toContain('1 of 2 assigned');
    expect(container!.textContent).toContain('Ade Studios');
    expect(container!.textContent).toContain('Paid');
    // Decoration is open -- the real per-category provider search result shows up, not a fabricated count.
    expect(container!.textContent).toMatch(/1 on VENTS · from ₦450,000/);
  });
});

describe('P16 Tasks tab (+ P17 completed-task states folded in)', () => {
  const todayPlusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  it('buckets real tasks by due date (overdue vs. this week) and a completes_on_booking task cannot be manually toggled', async () => {
    mockWorkspaceTables({
      plan_tasks: makeChain({
        data: [
          { id: 't1', category_id: 'cat-photo', title: 'Confirm venue capacity', offset_days: null, due_override: todayPlusDays(-3), done_at: null, source: 'user', completes_on_booking: false },
          { id: 't2', category_id: 'cat-photo', title: 'Book photographer', offset_days: null, due_override: null, done_at: '2026-10-01T00:00:00Z', source: 'si', completes_on_booking: true },
        ],
        error: null,
      }),
    });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-tasks');
    await flush();

    expect(container!.textContent).toContain('OVERDUE · 1');
    expect(container!.textContent).toContain('Confirm venue capacity');
    expect(container!.textContent).toContain('Completed · 1'); // collapsed by default, per the mockup's own spec

    const showCompleted = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent?.includes('Completed · 1'));
    act(() => showCompleted!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container!.textContent).toContain('Book photographer');
    expect(container!.textContent).toContain('Done via VENTS booking');

    supabaseFrom.mockClear();
    const lockedBox = container!.querySelector('[data-testid="workspace-task-t2"]') as HTMLElement;
    act(() => lockedBox.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(supabaseFrom).not.toHaveBeenCalledWith('plan_tasks');
  });

  it('completing a manual task sends a real plan_tasks update and shows an Undo toast that reverts with another real write', async () => {
    const sharedTasksChain = makeChain({
      data: [{ id: 't1', category_id: 'cat-photo', title: 'Send save-the-dates', offset_days: null, due_override: todayPlusDays(2), done_at: null, source: 'user', completes_on_booking: false }],
      error: null,
    });
    sharedTasksChain.update = vi.fn(() => makeChain({ data: null, error: null }));
    supabaseFrom.mockImplementation((table: string) => {
      if (table === 'plan_tasks') return sharedTasksChain;
      if (table === 'plans') return makeChain({ data: [PLAN_ROW], error: null }, { data: PLAN_ROW, error: null });
      if (table === 'plan_categories') return makeChain({ data: CATEGORY_ROWS, error: null });
      if (table === 'plan_assignments') return makeChain({ data: ASSIGNMENT_ROWS, error: null });
      if (table === 'service_providers') return makeChain({ data: PROVIDER_ROWS, error: null });
      return makeChain({ data: [], error: null });
    });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-tasks');
    await flush();

    const box = container!.querySelector('[data-testid="workspace-task-t1"]') as HTMLElement;
    act(() => box.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(sharedTasksChain.update).toHaveBeenCalledWith(expect.objectContaining({ done_at: expect.any(String) }));

    const undoBtn = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Undo');
    expect(undoBtn).toBeTruthy();
    act(() => undoBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(sharedTasksChain.update).toHaveBeenCalledWith({ done_at: null });
  });
});

describe('P18 Timeline tab', () => {
  it('renders real milestones from plan_milestones with phase-relative real task counts', async () => {
    mockWorkspaceTables({
      plan_milestones: makeChain({
        data: [
          { id: 'm1', phase_key: 'lock_essentials', label: 'Lock the essentials', ends_offset_days: 70 },
          { id: 'm2', phase_key: 'style', label: 'Style & entertainment', ends_offset_days: 41 },
        ],
        error: null,
      }),
    });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-timeline');
    await flush();

    expect(container!.textContent).toContain('Lock the essentials');
    expect(container!.textContent).toContain('Style & entertainment');
    expect(container!.textContent).toContain('Event day');
  });

  it('shows the real "no timeline phases yet" empty state rather than fabricating milestones', async () => {
    mockWorkspaceTables({ plan_milestones: makeChain({ data: [], error: null }) });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-timeline');
    await flush();

    expect(container!.textContent).toContain('No timeline phases yet for this plan.');
  });
});

describe('P14 Provider-assigned success state', () => {
  it('shows the real green receipt once for a freshly booked category, with real task/surplus/booking lines, then relaxes to a normal row', async () => {
    mockWorkspaceTables({
      plan_assignments: makeChain({
        data: [{ id: 'asg-1', category_id: 'cat-photo', provider_id: 'prov-1', own_vendor_name: null, agreed_kobo: 45000000, status: 'booked', updated_at: new Date().toISOString() }],
        error: null,
      }),
      plan_tasks: makeChain({
        data: [{ id: 'task-1', category_id: 'cat-photo', title: 'Book photographer', offset_days: null, due_override: null, done_at: new Date().toISOString(), source: 'si', completes_on_booking: true }],
        error: null,
      }),
    });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-team');
    await flush();

    expect(container!.textContent).toContain('Ade Studios');
    expect(container!.textContent).toContain('Paid · just now');
    expect(container!.textContent).toContain('Task "Book photographer" completed');
    expect(container!.textContent).toContain('under — moved to Unallocated?'); // real surplus: ₦500k allocated - ₦450k paid
    expect(container!.textContent).toContain('Booking added to your VENTS bookings');
    // Real readiness toast -- computeReadiness(1 of 1 tasks done=50%, 1 of 2 categories assigned=17.5%, budget fully committed on the one category=5.6%) = 72%.
    expect(container!.textContent).toContain('72% ready');
  });

  it('tapping "Move" on the freed surplus calls the real apply_plan_allocation_changes RPC, never a frontend-only balance change', async () => {
    mockWorkspaceTables({
      plan_assignments: makeChain({
        data: [{ id: 'asg-1', category_id: 'cat-photo', provider_id: 'prov-1', own_vendor_name: null, agreed_kobo: 45000000, status: 'booked', updated_at: new Date().toISOString() }],
        error: null,
      }),
    });
    supabaseRpc.mockResolvedValue({ data: 'log-1', error: null });

    await openWorkspace();
    clickTestId('workspace-tab-team');
    await flush();

    clickTestId('workspace-team-move-surplus');
    await flush();

    const call = supabaseRpc.mock.calls.find((c) => c[0] === 'apply_plan_allocation_changes');
    expect(call).toBeTruthy();
    expect(call![1].p_changes).toEqual([{ category_id: 'cat-photo', new_allocated_kobo: 45000000 }]);
  });
});

describe('P20 Budget exceeded', () => {
  const OVER_CATEGORY_ROWS = [
    { id: 'cat-decor', key: 'decoration', label: 'Decoration', allocated_kobo: 90000000, is_priority: false, sort: 1 },
    { id: 'cat-conting', key: 'contingency', label: 'Contingency', allocated_kobo: 80000000, is_priority: false, sort: 2 },
    { id: 'cat-catering', key: 'catering', label: 'Catering', allocated_kobo: 200000000, is_priority: false, sort: 3 },
  ];
  const OVER_ASSIGNMENT_ROWS = [
    // Catering's real committed amount (240m kobo) exceeds its own allocation (200m) AND, combined
    // with the rest, pushes total committed+paid above the plan's total_kobo -- a real plan-level overage.
    { id: 'asg-1', category_id: 'cat-catering', provider_id: 'prov-2', own_vendor_name: null, agreed_kobo: 240000000, status: 'assigned', updated_at: '2026-01-01T00:00:00Z' },
  ];

  it('does NOT show the banner when real committed+paid stays within the real total_kobo (₦8m plan, ₦2.4m committed)', async () => {
    mockWorkspaceTables({
      plan_categories: makeChain({ data: OVER_CATEGORY_ROWS, error: null }),
      plan_assignments: makeChain({ data: OVER_ASSIGNMENT_ROWS, error: null }),
      service_providers: makeChain({ data: [{ id: 'prov-2', business_name: 'Ìdáná Kitchen', category: 'Catering', location: 'Lagos' }], error: null }),
    });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-budget');
    await flush();

    expect(container!.querySelector('[data-testid="workspace-budget-exceeded-banner"]')).toBeFalsy();
  });

  it('a plan whose real committed+paid exceeds its real total_kobo shows the banner, and "Use contingency" reduces the real contingency allocation', async () => {
    mockWorkspaceTables({
      plans: makeChain({ data: [{ ...PLAN_ROW, total_kobo: 200000000 }], error: null }, { data: { ...PLAN_ROW, total_kobo: 200000000 }, error: null }),
      plan_categories: makeChain({ data: OVER_CATEGORY_ROWS, error: null }),
      plan_assignments: makeChain({ data: OVER_ASSIGNMENT_ROWS, error: null }),
      service_providers: makeChain({ data: [{ id: 'prov-2', business_name: 'Ìdáná Kitchen', category: 'Catering', location: 'Lagos' }], error: null }),
    });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-tab-budget');
    await flush();

    expect(container!.querySelector('[data-testid="workspace-budget-exceeded-banner"]')).toBeTruthy();
    expect(container!.textContent).toContain('OVER BUDGET');
    // committed 240m - total 200m = 40m kobo = ₦400,000 real overage.
    expect(container!.textContent).toContain('+₦400,000');

    const useContingencyBtn = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent?.includes('Use contingency'));
    act(() => useContingencyBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    const call = supabaseRpc.mock.calls.find((c) => c[0] === 'apply_plan_allocation_changes');
    expect(call).toBeTruthy();
    // Contingency's own real allocation (80m) minus the real 40m overage = 40m left.
    expect(call![1].p_changes).toEqual([{ category_id: 'cat-conting', new_allocated_kobo: 40000000 }]);
  });
});

describe('P22 Date-change impact sheet', () => {
  it('opens from the header ⋯ menu, previews real impact (booked providers, real runway), and confirming calls the real plans.update plus a real plan_tasks insert', async () => {
    const plansChain = makeChain({ data: [PLAN_ROW], error: null }, { data: PLAN_ROW, error: null });
    plansChain.update = vi.fn(() => makeChain({ data: null, error: null }));
    const tasksInsertChain = makeChain({ data: [], error: null });
    tasksInsertChain.insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
    supabaseFrom.mockImplementation((table: string) => {
      if (table === 'plans') return plansChain;
      if (table === 'plan_categories') return makeChain({ data: CATEGORY_ROWS, error: null });
      if (table === 'plan_assignments') return makeChain({ data: ASSIGNMENT_ROWS, error: null });
      if (table === 'service_providers') return makeChain({ data: PROVIDER_ROWS, error: null });
      if (table === 'plan_tasks') return tasksInsertChain;
      return makeChain({ data: [], error: null });
    });
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-header-menu');
    clickTestId('workspace-menu-change-date');
    await flush();

    const dateInput = container!.querySelector('[data-testid="ai-date-change-input"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(dateInput, '2026-12-19');
      dateInput.dispatchEvent(new Event('input', { bubbles: true }));
      dateInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container!.textContent).toContain('provider was booked'); // real booked-provider count from ASSIGNMENT_ROWS
    expect(container!.textContent).toContain('Ade Studios');

    clickTestId('ai-date-change-confirm');
    await flush();

    expect(plansChain.update).toHaveBeenCalledWith({ event_date: '2026-12-19' });
    expect(tasksInsertChain.insert).toHaveBeenCalledWith([
      expect.objectContaining({ plan_id: 'plan-1', category_id: 'cat-photo', title: expect.stringContaining('Ade Studios') }),
    ]);
  });

  it('Cancel closes the sheet without writing anything', async () => {
    mockWorkspaceTables();
    supabaseRpc.mockResolvedValue({ data: [], error: null });

    await openWorkspace();
    clickTestId('workspace-header-menu');
    clickTestId('workspace-menu-change-date');
    await flush();

    supabaseFrom.mockClear();
    const cancelBtn = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Cancel');
    act(() => cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(supabaseFrom).not.toHaveBeenCalledWith('plans');
    expect(container!.querySelector('[data-testid="ai-date-change-sheet-backdrop"]')).toBeFalsy();
  });
});
