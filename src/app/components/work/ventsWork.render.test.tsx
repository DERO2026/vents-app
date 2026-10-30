import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { VentsWorkScreen } from './VentsWorkScreen';
import { VentsEarningsScreen } from './VentsEarningsScreen';
import { RepresentativeRewardsScreen } from './RepresentativeRewardsScreen';

// Render tests for VENTS Work (hub), VENTS Earn (earnings) and
// Representative rewards: real values only (never the mockups' example
// numbers), role rows open the existing flows, and reward claims reuse one
// idempotency key per attempt.

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
    select: () => obj, eq: () => obj, order: () => obj, limit: () => obj, in: () => obj,
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
  };
  rpcs = {
    vc_tier_and_multiplier_for_user: { data: [{ tier: 'silver', lifetime_earned: 4900 }], error: null },
    get_my_referral_confirmations: { data: [], error: null },
    get_my_wallet: { data: [{ balance_kobo: 320000 }], error: null },
    get_my_representative_rewards: { data: { representative: null }, error: null },
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

describe('VENTS Work hub', () => {
  it('shows real balances, never the mockup example values', async () => {
    tables.organizer_wallets = { balance_kobo: 0 };
    await render(<VentsWorkScreen currentUser={user} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} />);
    expect(byTestId('work-tile-withdrawable')?.textContent).toContain('₦0');
    expect(byTestId('work-tile-vc')?.textContent).toContain('1,250 VC');
    expect(byTestId('work-tile-vc')?.textContent).toContain('silver · convert');
    expect(container.textContent).not.toContain('184,500');
    expect(container.textContent).toContain('Coming soon');
  });

  it('role rows reflect each role state and open the existing flows', async () => {
    tables.organizer_requests = { status: 'pending', admin_note: null, reason: 'Tech meetups' };
    tables.service_provider_requests = { status: 'approved' };
    const onNavigate = vi.fn();
    await render(<VentsWorkScreen currentUser={user} onBack={() => {}} onNavigate={onNavigate} onOpenCreatorStudio={() => {}} />);
    expect(byTestId('work-role-organizer')?.textContent).toContain('In review');
    expect(byTestId('work-role-provider')?.textContent).toContain('Set up your service profile');
    expect(byTestId('work-role-representative')?.textContent).toContain('Join');

    await click(byTestId('work-role-provider')!);
    expect(onNavigate).toHaveBeenCalledWith('service-provider-setup');
    await click(byTestId('work-role-representative')!);
    expect(onNavigate).toHaveBeenCalledWith('representatives');
    // Pending organizer application is never a dead end: the sheet opens on its status view.
    await click(byTestId('work-role-organizer')!);
    expect(byTestId('organizer-request-sheet')?.textContent).toContain('Your organizer request is under review');
  });

  it('an organizer can confirm a representative referral from the hub', async () => {
    rpcs.get_my_referral_confirmations = { data: [{ id: 'c1', status: 'pending_organizer', representative_name: 'Ada', event_title: 'Lagos Jam' }], error: null };
    rpcs.respond_to_representative_reward_claim = { data: { status: 'pending_review' }, error: null };
    await render(<VentsWorkScreen currentUser={{ ...user, isOrganizer: true }} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} />);
    expect(byTestId('work-confirmations')?.textContent).toContain('Ada says they referred you');
    await click(byTestId('confirm-c1')!);
    expect(rpcCalls.find((c) => c.name === 'respond_to_representative_reward_claim')?.args).toEqual({ p_claim_id: 'c1', p_confirm: true });
  });
});

describe('VENTS Earn (earnings)', () => {
  it('shows each balance separately labelled, including for a service provider', async () => {
    tables.organizer_wallets = { balance_kobo: 1845000 };
    tables.organizer_withdrawal_requests = [{ amount_kobo: 400000, created_at: '2026-10-26T10:00:00Z' }];
    const onNavigate = vi.fn();
    await render(<VentsEarningsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={onNavigate} />);
    expect(byTestId('earn-tile-withdrawable')?.textContent).toContain('₦18,450');
    expect(byTestId('earn-tile-pending')?.textContent).toContain('₦4,000');
    expect(byTestId('earn-tile-vents-wallet')?.textContent).toContain('₦3,200');
    expect(byTestId('earn-tile-vents-wallet')?.textContent).toContain('Spendable, not withdrawable');
    expect(byTestId('earn-tile-vc')?.textContent).toContain('Lifetime 4,900 VC');
    expect(byTestId('earn-tile-rep')?.textContent).toContain('Not joined');
    await click(byTestId('earn-withdraw')!);
    expect(onNavigate).toHaveBeenCalledWith('wallet');
  });

  it('a representative still shows as one (nothing paid) before the rewards backend is deployed', async () => {
    rpcs.get_my_representative_rewards = { data: null, error: { message: 'function does not exist' } };
    tables.recruiters = { id: 'u1' };
    await render(<VentsEarningsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('earn-tile-rep')?.textContent).toContain('Not paid yet');
    expect(byTestId('earn-tile-rep')?.textContent).toContain('Payouts not open yet');
  });
});

describe('Representative rewards', () => {
  const rewards = (over: any = {}) => ({
    representative: { status: 'active' }, payouts_enabled: false, programme_open: true, funding_available: true,
    current_rate_kobo: 5000000, rate_review_threshold: 9, qualifying_this_month: 1, qualifying_last_month: 0,
    attributions: [{ organizer_id: 'o1', organizer_name: 'Tobi', attributed_at: '2026-10-01', events: [
      { event_id: 'e1', title: 'Afrobeats Night', eligibility: { eligible: true, reasons: [] } },
    ] }],
    claims: [], expenses: [], ...over,
  });

  it('lets a representative submit an eligible organizer event for review', async () => {
    rpcs.get_my_representative_rewards = { data: rewards(), error: null };
    rpcs.submit_representative_reward_claim = { data: { status: 'pending_organizer' }, error: null };
    await render(<RepresentativeRewardsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('rewards-tile-rate')?.textContent).toContain('₦50,000');
    await click(byTestId('submit-e1')!);
    expect(rpcCalls.find((c) => c.name === 'submit_representative_reward_claim')?.args).toEqual({ p_organizer_id: 'o1', p_event_id: 'e1' });
  });

  it('claiming retries with the SAME idempotency key until it succeeds', async () => {
    const claim = { id: 'c1', organizer_id: 'o1', organizer_name: 'Tobi', event_title: 'Afrobeats Night', status: 'approved', amount_kobo: 5000000, reward_month: '2026-10-01', decision_reason: null };
    rpcs.get_my_representative_rewards = { data: rewards({ claims: [claim] }), error: null };
    rpcs.claim_representative_reward = { data: null, error: { message: 'network' } };
    await render(<RepresentativeRewardsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('claim-c1')?.textContent).toContain('Ready to claim');
    await click(byTestId('claim-button-c1')!);
    await click(byTestId('claim-button-c1')!);
    const keys = rpcCalls.filter((c) => c.name === 'claim_representative_reward').map((c) => c.args.p_idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('shows the honest state when profit does not cover an approved reward yet', async () => {
    const claim = { id: 'c1', organizer_id: 'o1', organizer_name: 'Tobi', event_title: 'X', status: 'approved', amount_kobo: 5000000, reward_month: '2026-10-01', decision_reason: null };
    rpcs.get_my_representative_rewards = { data: rewards({ claims: [claim], funding_available: false }), error: null };
    await render(<RepresentativeRewardsScreen currentUser={{ id: 'u1' }} onBack={() => {}} onNavigate={() => {}} />);
    expect(byTestId('claim-c1')?.textContent).toContain('Waiting for VENTS profit to fund it');
    expect(byTestId('claim-button-c1')).toBeNull();
  });
});
