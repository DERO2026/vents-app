import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { VentsWorkScreen } from './VentsWorkScreen';
import { VentsEarningsScreen } from './VentsEarningsScreen';
import { RepresentativeDashboardScreen } from './RepresentativeDashboardScreen';

// Batch E render tests: the Representative dashboard (funnel, monthly,
// reward lifecycle, team, expenses, wallet), the VENTS Work hub shortcuts
// and the earnings screen's 0203 additions. Every figure must be the
// backend's own value; every button must call a real function or open a
// real screen; a missing backend function must show an honest state.

const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (...args: any[]) => fromMock(...args),
    rpc: (...args: any[]) => rpcMock(...args),
  },
}));
const getVcBalanceMock = vi.fn();
vi.mock('../../../lib/vcBalanceCache', () => ({ getVcBalance: (...a: any[]) => getVcBalanceMock(...a) }));
vi.mock('../SettingsScreen', () => ({ CACVerificationScreen: () => <div data-testid="cac-screen" /> }));

function chain(result: any, error: any = null) {
  const obj: any = {
    select: () => obj, eq: () => obj, order: () => obj, limit: () => obj, in: () => obj, is: () => obj,
    maybeSingle: () => Promise.resolve({ data: Array.isArray(result) ? result[0] ?? null : result, error }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: result, error }).then(resolve, reject),
  };
  return obj;
}

let tables: Record<string, any>;
let rpcs: Record<string, any>;
const rpcCalls: { name: string; args: any }[] = [];

beforeEach(() => {
  rpcCalls.length = 0;
  tables = {
    organizer_requests: null,
    service_provider_requests: null,
    service_providers: null,
    recruiters: null,
    organizer_wallets: null,
    organizer_withdrawal_requests: [],
    recruiter_partnerships: [],
    earnings_recoveries: [],
  };
  rpcs = {
    vc_tier_and_multiplier_for_user: { data: [{ tier: 'silver', lifetime_earned: 4900 }], error: null },
    get_my_referral_confirmations: { data: [], error: null },
    get_my_wallet: { data: [{ balance_kobo: 320000 }], error: null },
    get_my_representative_rewards: { data: { representative: null }, error: null },
    // Not deployed in these tests unless a test sets it.
    get_my_representative_performance: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
    get_earnings_holds: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
  };
  getVcBalanceMock.mockResolvedValue({ spendable: 1250 });
  fromMock.mockImplementation((t: string) => {
    if (!(t in tables)) throw new Error(`unexpected table ${t}`);
    return chain(tables[t]);
  });
  rpcMock.mockImplementation((name: string, args: any) => {
    rpcCalls.push({ name, args });
    const r = rpcs[name];
    return Promise.resolve(typeof r === 'function' ? r(args) : r ?? { data: null, error: { message: `missing ${name}` } });
  });
});

let container: HTMLDivElement;
let root: Root;
async function render(el: ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(el); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
afterEach(() => { act(() => root.unmount()); container.remove(); });
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

const user = { id: 'u1', role: 'user', isOrganizer: false, is_service_provider: false, is_verified: false };


const perf = (over: any = {}) => ({
  representative: { status: 'active', created_at: '2026-10-03T09:00:00Z' },
  programme_open: true, payouts_enabled: true, current_month: '2026-10-01',
  rate_review_threshold: 9, base_reward_kobo: 5000000, settlement_hold_days: 7,
  funnel: { invitations_sent: 9, invitations_pending: 2, invitations_accepted: 5, invitations_declined: 1, invitations_withdrawn: 1,
    partnerships_active: 4, partnerships_ended: 1, organizers_attributed: 4, organizers_hosting: 3, organizers_qualified: 2, organizers_paid: 1 },
  lifecycle: {
    pending_organizer: { count: 1, amount_kobo: 5000000 }, pending_review: { count: 1, amount_kobo: 5000000 },
    approved: { count: 0, amount_kobo: 0 }, funded: { count: 1, amount_kobo: 5000000 }, credited: { count: 1, amount_kobo: 5000000 },
    rejected: { count: 0, amount_kobo: 0 }, reversed: { count: 0, amount_kobo: 0 },
  },
  months: ['2026-10-01', '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01', '2026-05-01'].map((m, i) => ({
    month: m, qualifying: i === 0 ? 2 : i === 1 ? 9 : 0, rate_kobo: i === 0 ? 7500000 : 5000000, submitted: i < 2 ? 3 : 0, paid_kobo: i === 1 ? 5000000 : 0,
  })),
  expenses: { submitted: { count: 1, amount_kobo: 250000 }, approved: { count: 1, amount_kobo: 400000 }, rejected: { count: 1, amount_kobo: 90000 } },
  wallet: { balance_kobo: 5000000, pending_kobo: 1000000, on_hold_kobo: 300000 },
  ...over,
});
const at = (i: number) => new Date(Date.UTC(2026, 9, 28) - i * 3600_000).toISOString();
const claim = (id: string, status: string, i = 0) => ({ id, at: at(i), organizer_id: `o-${id}`, organizer_name: `Org ${id}`, event_title: `Event ${id}`, status, amount_kobo: 5000000, reward_month: '2026-10-01', decision_reason: null });
const rewards = (over: any = {}) => ({
  representative: { status: 'active' }, payouts_enabled: true, programme_open: true, funding_available: true,
  current_rate_kobo: 7500000, rate_review_threshold: 9, qualifying_this_month: 2, qualifying_last_month: 9,
  ...over,
});

// The server's paged history (get_my_representative_history): newest first,
// filtered by status, keyset cursor -- the same contract as the SQL.
let history: Record<string, any[]>;
let historyFail: ((args: any) => any) | null;
const historyRpc = (args: any) => {
  if (historyFail) { const r = historyFail(args); if (r) return r; }
  let rows = (history[args.p_kind] ?? []).filter((r) => !args.p_status || r.status === args.p_status);
  if (args.p_before_id) rows = rows.slice(rows.findIndex((r) => r.id === args.p_before_id) + 1);
  const page = rows.slice(0, args.p_limit);
  const last = page[page.length - 1];
  return { data: { items: page, next: rows.length > args.p_limit ? { at: last.at, id: last.id } : null }, error: null };
};
const historyCalls = () => rpcCalls.filter((c) => c.name === 'get_my_representative_history').map((c) => c.args);
const lastHistory = () => historyCalls()[historyCalls().length - 1];

const dash = async (tab?: any, onNavigate = vi.fn()) => {
  await render(<RepresentativeDashboardScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={onNavigate} initialTab={tab} />);
  return onNavigate;
};
const money = /₦\s?\d/;

describe('Representative dashboard', () => {
  beforeEach(() => {
    rpcs.get_my_representative_performance = { data: perf(), error: null };
    rpcs.get_my_representative_rewards = { data: rewards(), error: null };
    rpcs.get_my_representative_history = historyRpc;
    historyFail = null;
    history = {
      claims: [claim('a', 'pending_organizer', 0), claim('b', 'pending_review', 1), claim('c', 'funded', 2), claim('d', 'credited', 3)],
      expenses: [
        { id: 'x1', at: at(0), category: 'transport', amount_kobo: 250000, description: 'Bus to Ikeja', incurred_on: '2026-10-21', status: 'submitted', decision_reason: null },
        { id: 'x2', at: at(1), category: 'support', amount_kobo: 400000, description: 'Flyers', incurred_on: '2026-10-10', status: 'approved', decision_reason: null },
        { id: 'x3', at: at(2), category: 'transport', amount_kobo: 90000, description: 'Taxi', incurred_on: '2026-10-02', status: 'rejected', decision_reason: 'No receipt' },
      ],
      attributions: [],
    };
  });

  it('overview: wallet and this month are the backend values', async () => {
    const onNavigate = await dash();
    expect(byTestId('rep-wallet-available')?.textContent).toContain('₦50,000');
    expect(byTestId('rep-wallet-pending')?.textContent).toContain('₦10,000');
    expect(byTestId('rep-wallet-pending')?.textContent).toContain('₦3,000 on hold');
    expect(byTestId('rep-month-progress')?.textContent).toContain('2 qualifying organizers');
    expect(byTestId('rep-month-progress')?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2');
    await click(byTestId('rep-withdraw')!);
    expect(onNavigate).toHaveBeenCalledWith('wallet');
    await click(byTestId('rep-invite')!);
    expect(onNavigate).toHaveBeenCalledWith('representatives');
  });

  it('funnel: plain counts with no conversion percentages', async () => {
    await dash();
    expect(byTestId('rep-funnel')?.textContent).not.toMatch(/%/);
    expect(byTestId('rep-referred')?.textContent).not.toMatch(/%|of the step before/);
    expect(byTestId('funnel-sent')?.textContent).toMatch(/Invitations sent.*9/);
    expect(byTestId('funnel-attributed')?.textContent).toMatch(/4$/);
    expect(byTestId('funnel-hosting')?.textContent).toMatch(/3$/);
    expect(byTestId('funnel-qualified')?.textContent).toMatch(/not reversed2$/);
    expect(byTestId('funnel-paid')?.textContent).toMatch(/1$/);
  });

  it('funnel: accepted-ever is shown apart from the partnerships active now', async () => {
    await dash();
    expect(byTestId('funnel-accepted')?.textContent).toMatch(/Accepted \(all time\)Includes partnerships that have since ended5/);
    expect(byTestId('funnel-active')?.textContent).toMatch(/Active partnerships nowYour current team4/);
    expect(byTestId('funnel-ended')?.textContent).toMatch(/Ended after accepting1/);
    expect(byTestId('funnel-withdrawn')?.textContent).toMatch(/Withdrawn by you1/);
  });

  it('the rules note shows the hold length set by admins, never a hardcoded figure', async () => {
    rpcs.get_my_representative_performance = { data: perf({ settlement_hold_days: 14 }), error: null };
    await dash('rewards');
    expect(document.body.textContent).toContain('finished its 14-day settlement');
    expect(document.body.textContent).not.toContain('7-day settlement');
  });

  it('the rules note states the approved rules: one reward per organizer, event after acceptance, free events verified', async () => {
    await dash('rewards');
    const t = document.body.textContent!;
    expect(t).toContain('one reward per organizer you referred, ever');
    expect(t).toContain('created after they accepted your partnership');
    expect(t).toContain('a free event counts only if VENTS confirms it was genuine');
    expect(t).toContain('two VENTS admins review it');
  });

  it('overview: the reward lifecycle shows every approved stage with its count, amount and an accurate hint', async () => {
    await dash();
    expect([...byTestId('rep-lifecycle')!.querySelectorAll('[data-testid^="lifecycle-"]')].map((e) => e.getAttribute('data-testid')))
      .toEqual(['lifecycle-pending_organizer', 'lifecycle-pending_review', 'lifecycle-approved', 'lifecycle-funded', 'lifecycle-credited', 'lifecycle-reversed']);
    expect(byTestId('lifecycle-approved')?.textContent).toContain('Waiting to be funded from VENTS profit');
    expect(byTestId('lifecycle-funded')?.textContent).toMatch(/Available.*add it to your earnings wallet.*1 · ₦50,000/);
    expect(byTestId('lifecycle-credited')?.textContent).toMatch(/Paid.*1 · ₦50,000/);
  });

  it('monthly: six months, newest first, with qualifying count, rate and paid', async () => {
    await dash('monthly');
    const rows = [...byTestId('rep-monthly')!.querySelectorAll('[data-testid^="month-"]')];
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['month-2026-10', 'month-2026-09', 'month-2026-08', 'month-2026-07', 'month-2026-06', 'month-2026-05']);
    expect(rows[0].textContent).toContain('2 qualifying');
    expect(rows[0].textContent).toContain('Rate ₦75,000');
    expect(rows[1].textContent).toContain('paid ₦50,000');
    expect(document.body.textContent).toContain('can still rise after it ends');
    expect(document.body.textContent).toContain('Nothing rises automatically');
  });

  it('rewards: the stage filter is applied by the server, counts are server totals, and Paid opens the earnings wallet', async () => {
    const onNavigate = await dash('rewards');
    expect(byTestId('stage-funded')?.textContent).toBe('Available 1');
    expect(byTestId('stage-all')?.textContent).toBe('All 4');
    await click(byTestId('stage-funded')!);
    expect(lastHistory()).toMatchObject({ p_kind: 'claims', p_status: 'funded', p_before_at: null, p_before_id: null });
    expect(byTestId('claim-c')).not.toBeNull();
    expect(byTestId('claim-a')).toBeNull();
    await click(byTestId('stage-credited')!);
    expect(byTestId('claim-d')?.textContent).toContain('Paid');
    await click(byTestId('claim-wallet-d')!);
    expect(onNavigate).toHaveBeenCalledWith('wallet');
  });

  it('rewards: loads 20 at a time, "Show more" continues from the cursor without repeats, and disappears at the end', async () => {
    history.claims = Array.from({ length: 45 }, (_, i) => claim(`k${i}`, 'pending_review', i));
    await dash('rewards');
    const shown = () => [...byTestId('rewards-claims')!.querySelectorAll('[data-testid^="claim-k"]')].map((e) => e.getAttribute('data-testid'));
    expect(shown()).toHaveLength(20);
    await click(byTestId('claims-more')!);
    expect(lastHistory()).toMatchObject({ p_kind: 'claims', p_before_id: 'k19', p_before_at: history.claims[19].at, p_limit: 20 });
    expect(shown()).toHaveLength(40);
    await click(byTestId('claims-more')!);
    expect(shown()).toHaveLength(45);
    expect(new Set(shown()).size).toBe(45);
    expect(byTestId('claims-more')).toBeNull();
  });

  it('rewards: a response for an old filter that arrives late is dropped', async () => {
    let releaseAll: (v: any) => void = () => {};
    historyFail = (args) => (args.p_kind === 'claims' && args.p_status === null && !args.p_before_id
      ? new Promise((r) => { releaseAll = r; }) : null);
    await dash('rewards');
    await click(byTestId('stage-funded')!);
    expect(byTestId('claim-c')).not.toBeNull();
    await act(async () => { releaseAll({ data: { items: history.claims, next: null }, error: null }); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    expect(byTestId('claim-a')).toBeNull();
    expect(byTestId('claim-c')).not.toBeNull();
  });

  it('rewards: a failed "Show more" keeps what was loaded, says so, and Try again continues', async () => {
    history.claims = Array.from({ length: 25 }, (_, i) => claim(`k${i}`, 'pending_review', i));
    await dash('rewards');
    historyFail = (args) => (args.p_before_id ? { data: null, error: { message: 'network down' } } : null);
    await click(byTestId('claims-more')!);
    expect(byTestId('claims-error')?.textContent).toContain('network down');
    expect(byTestId('rewards-claims')!.querySelectorAll('[data-testid^="claim-k"]')).toHaveLength(20);
    historyFail = null;
    await click(byTestId('claims-error')!.querySelector('button')!);
    expect(byTestId('rewards-claims')!.querySelectorAll('[data-testid^="claim-k"]')).toHaveLength(25);
    expect(byTestId('claims-error')).toBeNull();
  });

  it('rewards: a failed first read shows the error, never "No rewards yet"', async () => {
    historyFail = (args) => (args.p_kind === 'claims' ? { data: null, error: { message: 'permission denied for function' } } : null);
    await dash('rewards');
    expect(byTestId('claims-error')?.textContent).toContain('permission denied');
    expect(byTestId('claims-empty')).toBeNull();
  });

  it('referred organizers page too, and a claimed organizer offers no second submission', async () => {
    history.attributions = Array.from({ length: 22 }, (_, i) => ({
      id: `att${i}`, at: at(i), organizer_id: `org${i}`, organizer_name: `Organizer ${i}`, attributed_at: at(i), claimed: i === 0,
      events: [{ event_id: `ev${i}`, title: `Show ${i}`, eligibility: { eligible: true, reasons: [] } }],
    }));
    rpcs.submit_representative_reward_claim = { data: { status: 'pending_organizer' }, error: null };
    await dash('rewards');
    expect(byTestId('attribution-org0')?.textContent).toContain('Reward submitted');
    expect(byTestId('submit-ev0')).toBeNull();
    expect(byTestId('rewards-attributions')!.querySelectorAll('[data-testid^="attribution-"]')).toHaveLength(20);
    await click(byTestId('attributions-more')!);
    expect(byTestId('rewards-attributions')!.querySelectorAll('[data-testid^="attribution-"]')).toHaveLength(22);
    await click(byTestId('submit-ev21')!);
    expect(rpcCalls.find((c) => c.name === 'submit_representative_reward_claim')?.args).toEqual({ p_organizer_id: 'org21', p_event_id: 'ev21' });
  });

  it('empty states: no rewards, nothing at a stage, no organizers, no expenses', async () => {
    history = { claims: [], expenses: [], attributions: [] };
    rpcs.get_my_representative_performance = { data: perf({ expenses: { submitted: { count: 0, amount_kobo: 0 }, approved: { count: 0, amount_kobo: 0 }, rejected: { count: 0, amount_kobo: 0 } } }), error: null };
    await dash('rewards');
    expect(byTestId('claims-empty')?.textContent).toContain('No rewards yet');
    expect(byTestId('attributions-empty')?.textContent).toContain('No organizers yet');
    await click(byTestId('stage-approved')!);
    expect(byTestId('claims-empty')?.textContent).toContain('Nothing at this stage');
    act(() => root.unmount()); container.remove();
    await dash('expenses');
    expect(byTestId('expenses-empty')?.textContent).toContain('No expenses yet');
    expect(byTestId('expense-totals')?.textContent).toMatch(/Pending₦0.*Approved₦0.*Rejected₦0/);
  });

  it('team: lists active partnerships and invitations; withdraw calls the real function', async () => {
    tables.recruiter_partnerships = [
      { id: 'p1', status: 'accepted', organizer_id: 'org-a', provider_id: null, invited_at: '2026-10-01T00:00:00Z', responded_at: '2026-10-02T00:00:00Z' },
      { id: 'p2', status: 'pending', organizer_id: 'org-b', provider_id: null, invited_at: '2026-10-20T00:00:00Z', responded_at: null },
      { id: 'p3', status: 'declined', organizer_id: 'org-c', provider_id: null, invited_at: '2026-09-01T00:00:00Z', responded_at: '2026-09-02T00:00:00Z' },
    ];
    tables.public_profiles = [{ id: 'org-a', full_name: 'Tobi Oyelaran', username: 'tobi' }];
    rpcs.withdraw_recruiter_invitation = { data: null, error: null };
    await dash('team');
    expect(byTestId('team-active')?.textContent).toContain('Tobi Oyelaran');
    expect(byTestId('team-pending')?.textContent).toContain('Invited');
    expect(byTestId('team-history')?.textContent).toContain('Declined');
    await click(byTestId('team-withdraw-p2')!);
    expect(rpcCalls.find((c) => c.name === 'withdraw_recruiter_invitation')?.args).toEqual({ p_partnership_id: 'p2' });
  });

  it('team: ending a partnership asks first and does nothing if declined; confirmed, it calls the real function', async () => {
    tables.recruiter_partnerships = [{ id: 'p1', status: 'accepted', organizer_id: 'org-a', provider_id: null, invited_at: '2026-10-01T00:00:00Z', responded_at: '2026-10-02T00:00:00Z' }];
    tables.public_profiles = [];
    rpcs.revoke_recruiter_partnership = { data: null, error: null };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await dash('team');
    await click(byTestId('team-end-p1')!);
    expect(confirm).toHaveBeenCalled();
    expect(rpcCalls.some((c) => c.name === 'revoke_recruiter_partnership')).toBe(false);
    confirm.mockReturnValue(true);
    await click(byTestId('team-end-p1')!);
    expect(rpcCalls.find((c) => c.name === 'revoke_recruiter_partnership')?.args).toEqual({ p_partnership_id: 'p1' });
    confirm.mockRestore();
  });

  it('team: empty team says so; a failed read shows the error and no empty team', async () => {
    tables.recruiter_partnerships = [];
    await dash('team');
    expect(byTestId('team-active')?.textContent).toContain('No active partnerships yet');
    act(() => root.unmount()); container.remove();
    fromMock.mockImplementation((t: string) => (t === 'recruiter_partnerships' ? chain(null, { message: 'permission denied for table recruiter_partnerships' }) : chain(tables[t])));
    await dash('team');
    expect(container.textContent).toContain('permission denied');
    expect(byTestId('team-active')).toBeNull();
    expect(container.textContent).not.toContain('No active partnerships yet');
    expect(byTestId('team-retry')).not.toBeNull();
  });

  it('expenses: server totals, server filter, decision reasons, a clear payout note, and submission with an idempotency key', async () => {
    rpcs.submit_representative_expense = { data: { status: 'submitted' }, error: null };
    await dash('expenses');
    expect(byTestId('expense-totals')?.textContent).toMatch(/Pending₦2,500.*Approved₦4,000.*Rejected₦900/);
    expect(byTestId('expense-note')?.textContent).toContain('it is not added to your earnings wallet');
    await click(byTestId('expense-filter-rejected')!);
    expect(lastHistory()).toMatchObject({ p_kind: 'expenses', p_status: 'rejected' });
    expect(byTestId('expense-x3')?.textContent).toContain('No receipt');
    expect(byTestId('expense-x1')).toBeNull();
    const set = (label: string, v: string) => {
      const el = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      act(() => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    set('Amount in naira', '1500'); set('What was it for?', 'Bus fare'); set('Date', '2026-10-25');
    await click(byTestId('expense-submit')!);
    const call = rpcCalls.find((c) => c.name === 'submit_representative_expense');
    expect(call?.args).toMatchObject({ p_category: 'transport', p_amount_kobo: 150000, p_description: 'Bus fare', p_incurred_on: '2026-10-25' });
    expect(typeof call?.args.p_idempotency_key).toBe('string');
  });

  it('expenses: a page of history beyond 20 loads on demand', async () => {
    history.expenses = Array.from({ length: 21 }, (_, i) => ({ id: `e${i}`, at: at(i), category: 'transport', amount_kobo: 1000, description: `Trip ${i}`, incurred_on: '2026-10-01', status: 'submitted', decision_reason: null }));
    await dash('expenses');
    expect(byTestId('rewards-expenses')!.querySelectorAll('[data-testid^="expense-e"]')).toHaveLength(20);
    await click(byTestId('expenses-more')!);
    expect(byTestId('rewards-expenses')!.querySelectorAll('[data-testid^="expense-e"]')).toHaveLength(21);
    expect(byTestId('expenses-more')).toBeNull();
  });

  it('missing 0201 (or the read-only Preview): every reward tab says so with no money figures; history is never called; invitations still live', async () => {
    rpcs.get_my_representative_performance = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    rpcs.get_my_representative_rewards = { data: null, error: { code: 'PREVIEW_READ_ONLY', message: 'read only' } };
    rpcs.get_my_representative_history = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    tables.recruiter_partnerships = [{ status: 'accepted' }, { status: 'pending' }, { status: 'withdrawn' }, { status: 'revoked' }];
    await dash();
    expect(byTestId('rewards-not-live')).not.toBeNull();
    expect(byTestId('funnel-sent')?.textContent).toMatch(/4$/);
    expect(byTestId('funnel-accepted')?.textContent).toMatch(/2$/);
    expect(byTestId('funnel-active')?.textContent).toMatch(/1$/);
    expect(byTestId('funnel-ended')?.textContent).toMatch(/1$/);
    expect(byTestId('funnel-attributed')).toBeNull();
    expect(byTestId('rep-referred-unavailable')).not.toBeNull();
    expect(byTestId('rep-wallet-available')).toBeNull();
    expect(container.textContent).not.toMatch(money);
    for (const t of ['monthly', 'rewards', 'expenses']) {
      await click(byTestId(`rep-tab-${t}`)!);
      expect(byTestId('rewards-not-live'), t).not.toBeNull();
      expect(container.textContent, t).not.toMatch(money);
    }
    expect(historyCalls()).toHaveLength(0);
  });

  it('performance function unavailable but rewards live: no invented totals, no wallet tiles, lists still work', async () => {
    rpcs.get_my_representative_performance = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    await dash();
    expect(byTestId('rep-wallet-available')).toBeNull();
    expect(byTestId('rep-lifecycle')).toBeNull();
    expect(byTestId('rep-referred-unavailable')).not.toBeNull();
    await click(byTestId('rep-tab-monthly')!);
    expect(byTestId('monthly-unavailable')).not.toBeNull();
    await click(byTestId('rep-tab-rewards')!);
    expect(byTestId('stage-all')?.textContent).toBe('All');
    expect(byTestId('stage-funded')?.textContent).toBe('Available');
    expect(byTestId('claim-a')).not.toBeNull();
    expect(document.body.textContent).toContain('finished its settlement hold');
    await click(byTestId('rep-tab-expenses')!);
    expect(byTestId('expense-totals')?.textContent).toBe('Pending—Approved—Rejected—');
    expect(byTestId('expense-x1')).not.toBeNull();
  });

  it('a real performance read failure is shown as an error, not as "not available"', async () => {
    rpcs.get_my_representative_performance = { data: null, error: { message: 'canceling statement due to statement timeout' } };
    await dash();
    expect(container.textContent).toContain('statement timeout');
    expect(byTestId('rep-wallet-available')).toBeNull();
  });

  it('a real rewards read failure is shown, not hidden behind "not deployed"', async () => {
    rpcs.get_my_representative_rewards = { data: null, error: { message: 'Not authenticated' } };
    await dash();
    expect(container.textContent).toContain('Not authenticated');
    expect(byTestId('rewards-not-live')).toBeNull();
  });

  it('a non-representative is offered the real join flow, and no history is read', async () => {
    rpcs.get_my_representative_performance = { data: { representative: null }, error: null };
    rpcs.get_my_representative_rewards = { data: { representative: null }, error: null };
    const onNavigate = await dash();
    await click(byTestId('rep-join')!);
    expect(onNavigate).toHaveBeenCalledWith('representatives');
    for (const t of ['rewards', 'expenses']) await click(byTestId(`rep-tab-${t}`)!);
    expect(historyCalls()).toHaveLength(0);
  });
});

describe('VENTS Work hub: entry points', () => {
  it('an active representative opens the dashboard; organizer and provider shortcuts open real screens', async () => {
    tables.recruiters = { status: 'active', created_at: '2026-10-01' };
    tables.service_providers = { status: 'approved' };
    const onNavigate = vi.fn(); const studio = vi.fn(); const bookings = vi.fn();
    await render(<VentsWorkScreen currentUser={{ id: 'u1', role: 'user', isOrganizer: true, is_service_provider: true, is_verified: true }}
      onBack={() => {}} onNavigate={onNavigate} onOpenCreatorStudio={studio} onOpenProviderBookings={bookings} />);
    await click(byTestId('work-role-representative')!);
    expect(onNavigate).toHaveBeenCalledWith('representative-dashboard');
    await click(byTestId('shortcut-studio')!); expect(studio).toHaveBeenCalled();
    await click(byTestId('shortcut-events')!); expect(onNavigate).toHaveBeenCalledWith('manage-events');
    await click(byTestId('shortcut-bookings')!); expect(bookings).toHaveBeenCalled();
    await click(byTestId('shortcut-services')!); expect(onNavigate).toHaveBeenCalledWith('service-provider-setup');
    await click(byTestId('shortcut-representative')!); expect(onNavigate).toHaveBeenCalledWith('representative-dashboard');
    await click(byTestId('shortcut-wallet')!); expect(onNavigate).toHaveBeenCalledWith('wallet');
  });

  it('a failed earnings-wallet read shows "—" on the hub, never ₦0', async () => {
    fromMock.mockImplementation((t: string) => {
      if (t === 'organizer_wallets') { const c = chain(null); c.maybeSingle = () => Promise.reject(new Error('Failed to fetch')); return c; }
      return chain(tables[t]);
    });
    await render(<VentsWorkScreen currentUser={user} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} />);
    expect(byTestId('work-tile-withdrawable')?.textContent).toContain('—');
    expect(byTestId('work-tile-withdrawable')?.textContent).not.toContain('₦0');
  });

  it('organizer-only and provider-only hubs show only their own shortcuts', async () => {
    await render(<VentsWorkScreen currentUser={{ ...user, isOrganizer: true }} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} />);
    expect(byTestId('shortcut-studio')).not.toBeNull();
    expect(byTestId('shortcut-bookings')).toBeNull();
    expect(byTestId('shortcut-representative')).toBeNull();
    act(() => root.unmount()); container.remove();
    tables.service_providers = { status: 'approved' };
    await render(<VentsWorkScreen currentUser={{ ...user, is_service_provider: true }} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} onOpenProviderBookings={() => {}} />);
    expect(byTestId('shortcut-bookings')).not.toBeNull();
    expect(byTestId('shortcut-studio')).toBeNull();
    expect(byTestId('shortcut-representative')).toBeNull();
    act(() => root.unmount()); container.remove();
    tables.service_providers = { status: 'suspended' };
    await render(<VentsWorkScreen currentUser={{ ...user, is_service_provider: true }} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} onOpenProviderBookings={() => {}} />);
    expect(byTestId('work-shortcuts')).toBeNull();
  });

  it('someone with no role sees no shortcuts (nothing to open)', async () => {
    await render(<VentsWorkScreen currentUser={user} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} />);
    expect(byTestId('work-shortcuts')).toBeNull();
  });
});

describe('Earnings: held earnings and refunds owed (0203)', () => {
  it('shows on-hold, the next release and any refund owed when the backend has them', async () => {
    tables.organizer_wallets = { balance_kobo: 100000, on_hold_kobo: 950000 };
    tables.earnings_recoveries = [{ amount_kobo: 300000, recovered_kobo: 100000 }];
    rpcs.get_earnings_holds = { data: [
      { amount_kobo: 950000, release_at: '2026-11-03T20:00:00Z', blockers: ['not_yet'] },
      { amount_kobo: 100, release_at: null, blockers: ['customer_dispute'] },
    ], error: null };
    await render(<VentsEarningsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('earn-tile-on-hold')?.textContent).toContain('₦9,500');
    expect(byTestId('earn-tile-on-hold')?.textContent).toMatch(/Next ₦9,500 on/);
    expect(byTestId('earn-tile-owed')?.textContent).toContain('₦2,000');
  });

  it('representative tile: totals come from the server lifecycle, not a page of claims', async () => {
    rpcs.get_my_representative_performance = { data: perf(), error: null };
    tables.organizer_wallets = { balance_kobo: 0 };
    const onNavigate = vi.fn();
    await render(<VentsEarningsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={onNavigate} />);
    expect(byTestId('earn-tile-rep')?.textContent).toContain('₦50,000');
    await click(byTestId('earn-tile-rep')!);
    expect(onNavigate).toHaveBeenCalledWith('representative-dashboard');
  });

  it('representative tile: rewards not live shows no figure; a read failure shows "—", never ₦0', async () => {
    tables.recruiters = { id: 'u1' };
    tables.organizer_wallets = { balance_kobo: 0 };
    await render(<VentsEarningsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('earn-tile-rep')?.textContent).toContain('Not live yet');
    expect(byTestId('earn-tile-rep')?.textContent).not.toMatch(money);
    act(() => root.unmount()); container.remove();
    rpcs.get_my_representative_performance = { data: null, error: { message: 'statement timeout' } };
    await render(<VentsEarningsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('earn-tile-rep')?.textContent).toContain('Could not load rewards');
    expect(byTestId('earn-tile-rep')?.textContent).not.toMatch(money);
  });

  it('without 0203 there is no on-hold or owed tile (no invented zero balances)', async () => {
    tables.organizer_wallets = { balance_kobo: 100000 };
    tables.earnings_recoveries = undefined;
    await render(<VentsEarningsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('earn-tile-on-hold')).toBeNull();
  });
});
