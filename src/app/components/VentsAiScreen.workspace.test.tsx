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
