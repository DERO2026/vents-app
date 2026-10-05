import { describe, it, expect, vi } from 'vitest';
import {
  executeCreatePlanDraft,
  executeGetPlan,
  executeProposePlanUpdate,
  executeApplyPlanUpdate,
  executeRecommendProviders,
  executeAssignProvider,
  executeReschedulePlan,
  executeConfirmBrief,
  executePlanTool,
  PLAN_TOOLS,
  PLAN_TOOL_NAMES,
  PROPOSAL_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  ALL_TOOLS,
} from './aiTools';

// Minimal fake Supabase query-builder chain -- every chain method returns
// itself (so .from().select().eq().order() etc. all chain freely) and the
// chain is itself awaitable (thenable), resolving to the canned {data,
// error} for that call, same as the real PostgrestFilterBuilder.
// .single()/.maybeSingle() resolve the same way.
function makeChain(result: { data: any; error: any }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'update']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeFakeClient(opts: {
  from?: Record<string, { data: any; error: any }>;
  rpc?: { data: any; error: any } | ((name: string, args: any) => { data: any; error: any });
} = {}) {
  const fromCalls: { table: string }[] = [];
  const rpcCalls: { name: string; args: any }[] = [];
  const client: any = {
    from: vi.fn((table: string) => {
      fromCalls.push({ table });
      const result = opts.from?.[table] ?? { data: null, error: null };
      return makeChain(result);
    }),
    rpc: vi.fn((name: string, args: any) => {
      rpcCalls.push({ name, args });
      const result = typeof opts.rpc === 'function' ? opts.rpc(name, args) : opts.rpc ?? { data: null, error: null };
      return Promise.resolve(result);
    }),
  };
  return { client, fromCalls, rpcCalls };
}

describe('executeCreatePlanDraft', () => {
  it('seeds the wedding template categories, all unallocated, converting naira to kobo', async () => {
    const insertedCategories: any[] = [];
    const { client } = makeFakeClient({
      from: {
        plans: { data: { id: 'plan1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft', event_date: null, city: null, guests: null, total_kobo: 100000000 }, error: null },
      },
    });
    // Capture the categories insert payload directly, since makeFakeClient's
    // generic chain doesn't expose insert() args.
    client.from = vi.fn((table: string) => {
      if (table === 'plans') {
        return makeChain({ data: { id: 'plan1', title: 'Beach Wedding', event_type: 'wedding', status: 'draft', event_date: null, city: null, guests: null, total_kobo: 100000000 }, error: null });
      }
      if (table === 'plan_categories') {
        const chain: any = makeChain({ data: null, error: null });
        chain.insert = vi.fn((rows: any[]) => { insertedCategories.push(...rows); return chain; });
        return chain;
      }
      return makeChain({ data: null, error: null });
    });

    const result: any = await executeCreatePlanDraft(client, 'user1', {
      event_type: 'wedding',
      title: 'Beach Wedding',
      total_budget_naira: 1000000,
    });

    expect(result.plan_id).toBe('plan1');
    expect(result.total_budget_naira).toBe(1000000);
    expect(insertedCategories.map((c) => c.key)).toEqual(
      expect.arrayContaining(['venue', 'catering', 'photography', 'decoration'])
    );
    expect(insertedCategories.every((c) => c.allocated_kobo === 0)).toBe(true);
    expect(insertedCategories.every((c) => c.plan_id === 'plan1')).toBe(true);
  });

  it('rejects a missing event_type or title before touching the database', async () => {
    const { client } = makeFakeClient();
    await expect(executeCreatePlanDraft(client, 'user1', { title: 'x' })).rejects.toThrow(/event_type/);
    await expect(executeCreatePlanDraft(client, 'user1', { event_type: 'wedding' })).rejects.toThrow(/title/);
  });
});

describe('executeGetPlan', () => {
  it('separates estimated/committed/paid per category and never mixes them', async () => {
    const { client } = makeFakeClient();
    client.from = vi.fn((table: string) => {
      if (table === 'plans') return makeChain({ data: { id: 'plan1', title: 'T', event_type: 'wedding', status: 'active', event_date: null, end_date: null, city: null, guests: null, setting: null, total_kobo: 100000000 }, error: null });
      if (table === 'plan_categories') return makeChain({ data: [{ id: 'cat1', key: 'photography', label: 'Photography', allocated_kobo: 50000000, is_priority: false, is_contingency: false, sort: 0 }], error: null });
      if (table === 'plan_assignments') return makeChain({
        data: [
          { id: 'a1', category_id: 'cat1', provider_id: 'p1', own_vendor_name: null, agreed_kobo: 20000000, status: 'assigned', booking_id: null },
          { id: 'a2', category_id: 'cat1', provider_id: 'p2', own_vendor_name: null, agreed_kobo: 10000000, status: 'booked', booking_id: 'b1' },
        ],
        error: null,
      });
      if (table === 'plan_tasks') return makeChain({ data: [], error: null });
      if (table === 'plan_milestones') return makeChain({ data: [], error: null });
      if (table === 'plan_messages') return makeChain({ data: [], error: null });
      return makeChain({ data: null, error: null });
    });

    const result: any = await executeGetPlan(client, 'user1', { plan_id: 'plan1' });
    const cat = result.categories[0];
    // allocated 500,000 naira; committed (assigned) 200,000; paid (booked) 100,000;
    // estimated = allocated - committed - paid = 200,000.
    expect(cat.allocated_naira).toBe(500000);
    expect(cat.committed_naira).toBe(200000);
    expect(cat.paid_naira).toBe(100000);
    expect(cat.estimated_naira).toBe(200000);
  });

  it('throws when the plan is not found (RLS hides it rather than exposing a 403)', async () => {
    const { client } = makeFakeClient({ from: { plans: { data: null, error: null } } });
    await expect(executeGetPlan(client, 'user1', { plan_id: 'not-mine' })).rejects.toThrow(/not found/i);
  });
});

describe('propose vs apply (direct instruction vs SI suggestion)', () => {
  it('propose_plan_update never calls update or rpc -- it only computes a diff', async () => {
    const { client, rpcCalls } = makeFakeClient({
      from: { plan_categories: { data: { id: 'cat1', key: 'photography', label: 'Photography', allocated_kobo: 50000000 }, error: null } },
    });
    const result: any = await executeProposePlanUpdate(client, 'user1', {
      plan_id: 'plan1',
      changes: [{ category: 'photography', new_allocation_naira: 600000 }],
    });
    expect(result.applied).toBe(false);
    expect(result.proposed_changes[0]).toMatchObject({ before_naira: 500000, after_naira: 600000 });
    expect(rpcCalls.length).toBe(0);
  });

  it('apply_plan_update resolves the category and calls apply_plan_allocation_changes in kobo', async () => {
    const { client, rpcCalls } = makeFakeClient({
      from: { plan_categories: { data: { id: 'cat1', key: 'photography', label: 'Photography', allocated_kobo: 50000000 }, error: null } },
      rpc: { data: 'log1', error: null },
    });
    const result: any = await executeApplyPlanUpdate(client, 'user1', {
      plan_id: 'plan1',
      changes: [{ category: 'photography', new_allocation_naira: 600000 }],
      actor: 'user',
    });
    expect(result.applied).toBe(true);
    expect(result.change_log_id).toBe('log1');
    expect(rpcCalls[0].name).toBe('apply_plan_allocation_changes');
    expect(rpcCalls[0].args.p_plan_id).toBe('plan1');
    expect(rpcCalls[0].args.p_changes).toEqual([{ category_id: 'cat1', new_allocated_kobo: 60000000 }]);
    expect(rpcCalls[0].args.p_actor).toBe('user');
  });

  it('defaults actor to "user" for anything other than an explicit "si"', async () => {
    const { client, rpcCalls } = makeFakeClient({
      from: { plan_categories: { data: { id: 'cat1', key: 'photography', label: 'Photography', allocated_kobo: 0 }, error: null } },
      rpc: { data: 'log1', error: null },
    });
    await executeApplyPlanUpdate(client, 'user1', { plan_id: 'plan1', changes: [{ category: 'photography', new_allocation_naira: 1 }] });
    expect(rpcCalls[0].args.p_actor).toBe('user');
  });
});

describe('executeRecommendProviders', () => {
  it('never marks a result sponsored, always adds the no-availability note, and never double-converts a naira price', async () => {
    const { client, rpcCalls } = makeFakeClient({
      rpc: {
        data: [{ provider_id: 'p1', business_name: 'Biz', provider_category: 'Photography', location: 'Lagos', starting_price: 250000, service_id: 's1', service_name: 'Shoot', service_price: 250000 }],
        error: null,
      },
    });
    const result: any = await executeRecommendProviders(client, 'user1', { query: 'photographer', location: 'Lagos', max_price_naira: 300000 });
    expect(result[0].is_sponsored).toBe(false);
    expect(result[0].availability_note).toBe('Confirm availability with provider.');
    expect(result[0].starting_price_naira).toBe(250000);
    expect(rpcCalls[0].name).toBe('search_services_fuzzy_filtered');
    expect(rpcCalls[0].args.p_max_starting_price).toBe(300000);
    expect(rpcCalls[0].args.p_location).toBe('Lagos');
  });

  it('rejects a negative max price before calling the database', async () => {
    const { client } = makeFakeClient();
    await expect(executeRecommendProviders(client, 'user1', { query: 'x', max_price_naira: -1 })).rejects.toThrow();
  });
});

describe('executeAssignProvider', () => {
  it('reports assigned-not-booked for a fresh assignment', async () => {
    const { client } = makeFakeClient({
      from: { plan_categories: { data: { id: 'cat1', key: 'photography', label: 'Photography', allocated_kobo: 0 }, error: null } },
      rpc: { data: { provider_id: 'p1', agreed_kobo: 25000000, status: 'assigned' }, error: null },
    });
    const result: any = await executeAssignProvider(client, 'user1', { plan_id: 'plan1', category: 'photography', provider_id: 'p1', agreed_amount_naira: 250000 });
    expect(result.status).toBe('assigned');
    expect(result.booked).toBe(false);
    expect(result.agreed_amount_naira).toBe(250000);
  });

  it('surfaces the RPC error when a category already has a paid booking', async () => {
    const { client } = makeFakeClient({
      from: { plan_categories: { data: { id: 'cat1', key: 'photography', label: 'Photography', allocated_kobo: 0 }, error: null } },
      rpc: { data: null, error: { message: "This category already has a paid booking -- it can't be replaced from here" } },
    });
    await expect(
      executeAssignProvider(client, 'user1', { plan_id: 'plan1', category: 'photography', provider_id: 'p1' })
    ).rejects.toThrow(/paid booking/);
  });
});

describe('executeReschedulePlan', () => {
  it('flags that an assigned provider needs date confirmation, without touching any booking', async () => {
    const { client } = makeFakeClient();
    client.from = vi.fn((table: string) => {
      if (table === 'plans') return makeChain({ data: { id: 'plan1', event_date: '2026-12-01', end_date: null }, error: null });
      if (table === 'plan_categories') return makeChain({ data: [{ id: 'cat1' }], error: null });
      if (table === 'plan_assignments') return makeChain({ data: [{ id: 'a1' }], error: null });
      return makeChain({ data: null, error: null });
    });
    const result: any = await executeReschedulePlan(client, 'user1', { plan_id: 'plan1', event_date: '2026-12-01' });
    expect(result.has_assigned_providers).toBe(true);
    expect(result.note).toMatch(/confirm the new date/i);
  });

  it('requires an event_date', async () => {
    const { client } = makeFakeClient();
    await expect(executeReschedulePlan(client, 'user1', { plan_id: 'plan1' })).rejects.toThrow(/event_date/);
  });
});

describe('executeConfirmBrief', () => {
  it('flips status from draft to active', async () => {
    const { client } = makeFakeClient({ from: { plans: { data: { id: 'plan1', status: 'active' }, error: null } } });
    const result: any = await executeConfirmBrief(client, 'user1', { plan_id: 'plan1' });
    expect(result.status).toBe('active');
  });

  it('throws if the plan is not a draft (or not the caller\'s)', async () => {
    const { client } = makeFakeClient({ from: { plans: { data: null, error: null } } });
    await expect(executeConfirmBrief(client, 'user1', { plan_id: 'plan1' })).rejects.toThrow();
  });
});

describe('offer_plan_intent / ask_plan_question / preview_plan_brief (P02-P05 pre-plan cards)', () => {
  it('offer_plan_intent writes nothing and just echoes/normalizes the extracted fields', async () => {
    const { client, fromCalls, rpcCalls } = makeFakeClient();
    const result: any = await executePlanTool('offer_plan_intent', client, 'user1', {
      event_type: 'wedding',
      title: 'Beach wedding',
      guests: 120,
      city: 'Lagos',
      total_budget_naira: 8000000,
      questions_remaining: 4,
    });
    expect(result).toEqual({
      event_type: 'wedding',
      title: 'Beach wedding',
      guests: 120,
      city: 'Lagos',
      total_budget_naira: 8000000,
      questions_remaining: 4,
    });
    // Pure formatting -- no table or RPC touched.
    expect(fromCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it('offer_plan_intent leaves unknown fields as null rather than guessing a value', async () => {
    const { client } = makeFakeClient();
    const result: any = await executePlanTool('offer_plan_intent', client, 'user1', { event_type: 'wedding' });
    expect(result.title).toBeNull();
    expect(result.guests).toBeNull();
    expect(result.city).toBeNull();
    expect(result.total_budget_naira).toBeNull();
  });

  it('ask_plan_question normalizes options and defaults question_type/allow_skip', async () => {
    const { client } = makeFakeClient();
    const result: any = await executePlanTool('ask_plan_question', client, 'user1', {
      step: 2,
      question: 'Do you already have a venue?',
      options: [{ id: 'has_one', label: 'Yes, I have one', hint: 'Add details' }, { id: 'help', label: 'Help me find one' }],
    });
    expect(result.question_type).toBe('single_choice');
    expect(result.allow_skip).toBe(true);
    expect(result.options).toEqual([
      { id: 'has_one', label: 'Yes, I have one', hint: 'Add details' },
      { id: 'help', label: 'Help me find one', hint: null },
    ]);
  });

  it('ask_plan_question respects an explicit multi_select type and allow_skip: false', async () => {
    const { client } = makeFakeClient();
    const result: any = await executePlanTool('ask_plan_question', client, 'user1', {
      step: 4,
      question: 'What matters most?',
      question_type: 'multi_select',
      max_select: 3,
      allow_skip: false,
      options: [{ id: 'food', label: 'Great food' }],
    });
    expect(result.question_type).toBe('multi_select');
    expect(result.max_select).toBe(3);
    expect(result.allow_skip).toBe(false);
  });

  it('preview_plan_brief writes nothing and normalizes style/priorities arrays', async () => {
    const { client, fromCalls, rpcCalls } = makeFakeClient();
    const result: any = await executePlanTool('preview_plan_brief', client, 'user1', {
      title: 'Beach Wedding',
      event_type: 'wedding',
      city: 'Lagos',
      guests: 120,
      total_budget_naira: 8000000,
      style: ['Elegant', 'Modern', 'Beach'],
      priorities: ['Great food', 'Photography', 'Live music'],
    });
    expect(result.style).toEqual(['Elegant', 'Modern', 'Beach']);
    expect(result.priorities).toEqual(['Great food', 'Photography', 'Live music']);
    expect(fromCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });
});

describe('tool wiring/categorization regression', () => {
  it('every PLAN_TOOLS name is in PLAN_TOOL_NAMES and in ALL_TOOLS', () => {
    for (const t of PLAN_TOOLS) {
      expect(PLAN_TOOL_NAMES.has(t.name)).toBe(true);
      expect(ALL_TOOLS.some((at) => at.name === t.name)).toBe(true);
    }
  });

  it('no plan tool is also a PROPOSAL_TOOL or READ_ONLY_TOOL -- the three categories never overlap', () => {
    for (const name of PLAN_TOOL_NAMES) {
      expect(PROPOSAL_TOOL_NAMES.has(name)).toBe(false);
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it('apply_plan_update and propose_plan_update specifically never go through the money confirmation flow', () => {
    expect(PROPOSAL_TOOL_NAMES.has('apply_plan_update')).toBe(false);
    expect(PROPOSAL_TOOL_NAMES.has('propose_plan_update')).toBe(false);
  });
});
