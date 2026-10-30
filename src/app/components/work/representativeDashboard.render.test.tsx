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
    return Promise.resolve(rpcs[name] ?? { data: null, error: { message: `missing ${name}` } });
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
  funnel: { invitations_sent: 8, invitations_pending: 2, invitations_accepted: 5, invitations_declined: 1, partnerships_active: 4,
    organizers_attributed: 4, organizers_hosting: 3, organizers_qualified: 2, organizers_paid: 1 },
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
const claim = (id: string, status: string) => ({ id, organizer_id: `o-${id}`, organizer_name: `Org ${id}`, event_title: `Event ${id}`, status, amount_kobo: 5000000, reward_month: '2026-10-01', decision_reason: null });
const rewards = (over: any = {}) => ({
  representative: { status: 'active' }, payouts_enabled: true, programme_open: true, funding_available: true,
  current_rate_kobo: 7500000, rate_review_threshold: 9, qualifying_this_month: 2, qualifying_last_month: 9,
  attributions: [],
  claims: [claim('a', 'pending_organizer'), claim('b', 'pending_review'), claim('c', 'funded'), claim('d', 'credited')],
  expenses: [
    { id: 'x1', category: 'transport', amount_kobo: 250000, description: 'Bus to Ikeja', incurred_on: '2026-10-21', status: 'submitted', decision_reason: null },
    { id: 'x2', category: 'support', amount_kobo: 400000, description: 'Flyers', incurred_on: '2026-10-10', status: 'approved', decision_reason: null },
    { id: 'x3', category: 'transport', amount_kobo: 90000, description: 'Taxi', incurred_on: '2026-10-02', status: 'rejected', decision_reason: 'No receipt' },
  ],
  ...over,
});
const dash = async (tab?: any, onNavigate = vi.fn()) => {
  await render(<RepresentativeDashboardScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={onNavigate} initialTab={tab} />);
  return onNavigate;
};

describe('Representative dashboard', () => {
  beforeEach(() => {
    rpcs.get_my_representative_performance = { data: perf(), error: null };
    rpcs.get_my_representative_rewards = { data: rewards(), error: null };
  });

  it('overview: wallet, this month and the funnel are the backend values', async () => {
    const onNavigate = await dash();
    expect(byTestId('rep-wallet-available')?.textContent).toContain('₦50,000');
    expect(byTestId('rep-wallet-pending')?.textContent).toContain('₦10,000');
    expect(byTestId('rep-wallet-pending')?.textContent).toContain('₦3,000 on hold');
    expect(byTestId('rep-month-progress')?.textContent).toContain('2 qualifying organizers');
    expect(byTestId('rep-month-progress')?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2');
    expect(byTestId('funnel-sent')?.textContent).toContain('8');
    expect(byTestId('funnel-accepted')?.textContent).toMatch(/63% of the step before.*5/);
    expect(byTestId('funnel-paid')?.textContent).toContain('1');
    await click(byTestId('rep-withdraw')!);
    expect(onNavigate).toHaveBeenCalledWith('wallet');
    await click(byTestId('rep-invite')!);
    expect(onNavigate).toHaveBeenCalledWith('representatives');
  });

  it('the rules note shows the hold length set by admins, never a hardcoded figure', async () => {
    rpcs.get_my_representative_performance = { data: perf({ settlement_hold_days: 14 }), error: null };
    await dash('rewards');
    expect(document.body.textContent).toContain('finished its 14-day settlement');
    expect(document.body.textContent).not.toContain('7-day settlement');
  });

  it('without the performance figures the rules note does not guess a hold length', async () => {
    rpcs.get_my_representative_performance = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    await dash('rewards');
    expect(document.body.textContent).toContain('finished its settlement hold');
    expect(document.body.textContent).not.toMatch(/\d+-day settlement/);
  });

  it('overview: the reward lifecycle shows every approved stage with its count and amount', async () => {
    await dash();
    expect([...byTestId('rep-lifecycle')!.querySelectorAll('[data-testid^="lifecycle-"]')].map((e) => e.getAttribute('data-testid')))
      .toEqual(['lifecycle-pending_organizer', 'lifecycle-pending_review', 'lifecycle-approved', 'lifecycle-funded', 'lifecycle-credited', 'lifecycle-reversed']);
    expect(byTestId('lifecycle-funded')?.textContent).toMatch(/Available.*1 · ₦50,000/);
    expect(byTestId('lifecycle-credited')?.textContent).toMatch(/Paid.*1 · ₦50,000/);
  });

  it('monthly: six months, newest first, with qualifying count, rate and paid', async () => {
    await dash('monthly');
    const rows = [...byTestId('rep-monthly')!.querySelectorAll('[data-testid^="month-"]')];
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['month-2026-10', 'month-2026-09', 'month-2026-08', 'month-2026-07', 'month-2026-06', 'month-2026-05']);
    expect(rows[0].textContent).toContain('2 qualifying');
    expect(rows[0].textContent).toContain('Rate ₦75,000');
    expect(rows[1].textContent).toContain('paid ₦50,000');
  });

  it('rewards: the lifecycle filter shows only the chosen stage, and Paid opens the earnings wallet', async () => {
    const onNavigate = await dash('rewards');
    expect(byTestId('stage-funded')?.textContent).toBe('Available 1');
    await click(byTestId('stage-funded')!);
    expect(byTestId('claim-c')).not.toBeNull();
    expect(byTestId('claim-a')).toBeNull();
    expect(byTestId('claim-c')?.textContent).toContain('Available');
    await click(byTestId('stage-credited')!);
    expect(byTestId('claim-d')?.textContent).toContain('Paid');
    await click(byTestId('claim-wallet-d')!);
    expect(onNavigate).toHaveBeenCalledWith('wallet');
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

  it('team: ending a partnership asks first and does nothing if declined', async () => {
    tables.recruiter_partnerships = [{ id: 'p1', status: 'accepted', organizer_id: 'org-a', provider_id: null, invited_at: '2026-10-01T00:00:00Z', responded_at: '2026-10-02T00:00:00Z' }];
    tables.public_profiles = [];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await dash('team');
    await click(byTestId('team-end-p1')!);
    expect(confirm).toHaveBeenCalled();
    expect(rpcCalls.some((c) => c.name === 'revoke_recruiter_partnership')).toBe(false);
    confirm.mockRestore();
  });

  it('expenses: totals by status, filter, decision reasons, and submission with an idempotency key', async () => {
    rpcs.submit_representative_expense = { data: { status: 'submitted' }, error: null };
    await dash('expenses');
    expect(byTestId('expense-totals')?.textContent).toMatch(/Pending₦2,500.*Approved₦4,000.*Rejected₦900/);
    await click(byTestId('expense-filter-rejected')!);
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

  it('rewards not deployed (or the read-only Preview): says so, and the invitation funnel still comes from live data', async () => {
    rpcs.get_my_representative_performance = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    rpcs.get_my_representative_rewards = { data: null, error: { code: 'PREVIEW_READ_ONLY', message: 'read only' } };
    tables.recruiter_partnerships = [{ status: 'accepted' }, { status: 'pending' }, { status: 'withdrawn' }];
    await dash();
    expect(byTestId('rewards-not-live')).not.toBeNull();
    expect(byTestId('funnel-sent')?.textContent).toContain('3');
    expect(byTestId('funnel-accepted')?.textContent).toContain('1');
    expect(byTestId('funnel-attributed')).toBeNull();
    expect(byTestId('rep-wallet-available')).toBeNull();
    expect(container.textContent).not.toMatch(/₦50,000/);
  });

  it('a real backend error is shown, not hidden behind "not deployed"', async () => {
    rpcs.get_my_representative_rewards = { data: null, error: { message: 'Not authenticated' } };
    await dash();
    expect(container.textContent).toContain('Not authenticated');
    expect(byTestId('rewards-not-live')).toBeNull();
  });

  it('a non-representative is offered the real join flow', async () => {
    rpcs.get_my_representative_performance = { data: { representative: null }, error: null };
    rpcs.get_my_representative_rewards = { data: { representative: null }, error: null };
    const onNavigate = await dash();
    await click(byTestId('rep-join')!);
    expect(onNavigate).toHaveBeenCalledWith('representatives');
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

  it('without 0203 there is no on-hold or owed tile (no invented zero balances)', async () => {
    tables.organizer_wallets = { balance_kobo: 100000 };
    tables.earnings_recoveries = undefined;
    await render(<VentsEarningsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('earn-tile-on-hold')).toBeNull();
  });
});
