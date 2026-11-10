import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { PayoutRequestsPanel } from './PayoutRequestsPanel';

// 0213: the Payouts screen shows the database's state (admin_payout_overview,
// admin_list_withdrawals), offers exactly the actions the server allows THIS
// admin, separates Review / Approve for Payment / Authorize & Pay / Reject,
// never sends a payout without the 10-digit PIN, sends it once, and re-reads
// the list after every action.

const rpcCalls: { name: string; params: any }[] = [];
const fetchCalls: { url: string; body: any }[] = [];
let rows: any[] = [];
let overview: any = {};
let rpcErrors: Record<string, any> = {};
let fetchResponses: { status: number; json: any }[] = [];
let fetchGate: Promise<void> | null = null;

const base = {
  request_id: 'w-1', organizer_id: 'org-1', organizer_name: 'Ada Organizer', organizer_email: 'ada@example.test', organizer_phone: null,
  amount_kobo: 3000000, status: 'pending', stage: 'pending_review', next_action: 'review_or_vents_admin',
  bank_name: 'GTBank', account_number_masked: '****6789', account_number: null, account_name: 'ADA ORGANIZER',
  bank_account_active: true, account_verified: true, wallet_balance_kobo: 7000000, wallet_pending_kobo: 3000000,
  created_at: '2026-11-10T10:00:00Z', updated_at: null, withdrawal_reference: 'payout_w1', admin_note: null,
  reviews: [], has_current_review: false, approved_by: null, approved_by_name: null, approved_at: null, approval_current: false,
  authorized_by_name: null, authorized_at: null, paystack_reference: null, transfer_started: false, pin_required: false,
  can_review: false, can_approve: false, can_authorize_pay: false, can_reject: false, action_note: null,
};
const ov = (extra: any = {}) => ({
  stages: { pending_review: { count: 9, amount_kobo: 5050000 } }, outstanding_kobo: 5050000, outstanding_count: 9,
  processing_kobo: 0, paid_kobo: 140000, wallet_pending_kobo: 5050000, is_vents_admin: false, viewer_tier: 'sub',
  payouts_disabled: false, computed_at: '2026-11-10T10:00:00Z', ...extra,
});

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc: (name: string, params: any) => {
      rpcCalls.push({ name, params });
      if (rpcErrors[name]) return Promise.resolve({ data: null, error: rpcErrors[name] });
      if (name === 'admin_list_withdrawals') return Promise.resolve({ data: rows, error: null });
      if (name === 'admin_payout_overview') return Promise.resolve({ data: overview, error: null });
      if (name === 'admin_payout_pin_status') return Promise.resolve({ data: { has_pin: true, locked: false, locked_until: null, must_reset: false, attempts_left: 5, payouts_paused_until: null }, error: null });
      return Promise.resolve({ data: {}, error: null });
    },
    from: () => { throw new Error('the payout panel must not read tables directly'); },
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }) },
  },
}));
vi.mock('../../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('./adminAuditLog', () => ({ notifyByEmail: () => {} }));
vi.mock('./WithdrawalReassignForm', () => ({ WithdrawalReassignForm: () => null }));
vi.mock('../../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  rpcCalls.length = 0; fetchCalls.length = 0; rows = []; overview = ov(); rpcErrors = {}; fetchResponses = []; fetchGate = null;
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    if (fetchGate) await fetchGate;
    const r = fetchResponses.shift() ?? { status: 200, json: { status: 'processing', reference: 'payout_w1' } };
    return { ok: r.status < 400, status: r.status, json: async () => r.json } as any;
  });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<PayoutRequestsPanel payoutsDisabled={false} />); await flush(); });
  await act(async () => { await flush(); });
}
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttonsOf = (id: string) => Array.from(q(`payout-card-${id}`)!.querySelectorAll('[data-testid^="payout-actions"] button')).map((b) => b.textContent);
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); }); };
const type = async (el: HTMLElement | null, value: string) => {
  expect(el).toBeTruthy();
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
};

describe('PayoutRequestsPanel (0213)', () => {
  it('reads the server totals and list (never tables) and shows the authoritative outstanding total', async () => {
    rows = [{ ...base }];
    await render();
    expect(rpcCalls.map((c) => c.name)).toEqual(expect.arrayContaining(['admin_payout_overview', 'admin_list_withdrawals']));
    expect(rpcCalls.find((c) => c.name === 'admin_list_withdrawals')!.params).toEqual({ p_scope: 'open', p_limit: 200 });
    expect(q('payout-outstanding')!.textContent).toBe('₦50,500.00');
    expect(q('payout-tile-review')!.textContent).toMatch(/9/);
    expect(q('payout-stage-w-1')!.textContent).toBe('PENDING REVIEW');
  });

  it('buttons come only from the server: a sub-admin can review, nothing else; no Pay button anywhere', async () => {
    rows = [{ ...base, can_review: true }];
    await render();
    expect(buttonsOf('w-1')).toEqual(['Review']);
    expect(container!.textContent).not.toMatch(/Authorize & Pay|Approve & Pay|Pay now/);
    expect(q('admin-payout-pin-panel')).toBeNull();
  });

  it('the VENTS Admin sees Approve / Reject on a new request and Authorize & Pay only once it is approved', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [
      { ...base, request_id: 'a', can_approve: true, can_reject: true },
      { ...base, request_id: 'b', stage: 'vents_admin_approved', approved_by: 'root', approved_by_name: 'VENTS Admin', approved_at: '2026-11-10T11:00:00Z', approval_current: true, pin_required: true, can_authorize_pay: true, can_reject: true },
    ];
    await render();
    expect(buttonsOf('a')).toEqual(['Approve for Payment', 'Reject']);
    expect(buttonsOf('b')).toEqual(['Authorize & Pay', 'Reject']);
    expect(q('payout-approval-b')!.textContent).toMatch(/Approved for payment by VENTS Admin/);
    expect(q('admin-payout-pin-state')!.textContent).toMatch(/required for every payout/);
  });

  it('shows the review history with names, tiers, notes and outdated reviews', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, stage: 'forwarded_to_vents_admin', next_action: 'vents_admin', can_approve: true, can_reject: true, reviews: [
      { reviewer_name: 'Sub One', reviewer_tier: 'sub', decision: 'forwarded', note: 'Bank matches profile', created_at: '2026-11-10T10:30:00Z', current: true },
      { reviewer_name: 'Admin A', reviewer_tier: 'admin', decision: 'rejection_recommended', note: 'Old bank', created_at: '2026-11-10T09:00:00Z', current: false },
    ] }];
    await render();
    const h = q('payout-history-w-1')!.textContent!;
    expect(h).toMatch(/Sub One \(sub-admin\) forwarded to VENTS Admin/);
    expect(h).toMatch(/Bank matches profile/);
    expect(h).toMatch(/Admin A \(admin\) recommends rejection.*outdated/);
    expect(q('payout-next-w-1')!.textContent).toMatch(/the VENTS Admin/);
  });

  it('Review: needs a note, sends the reviewed amount and decision, then re-reads the list', async () => {
    rows = [{ ...base, can_review: true }];
    await render();
    const lists = rpcCalls.filter((c) => c.name === 'admin_list_withdrawals').length;
    await click(q('payout-review-w-1'));
    await click(q('payout-review-submit'));
    expect(rpcCalls.some((c) => c.name === 'admin_review_withdrawal')).toBe(false);
    await click(q('payout-review-decision-recommend_reject'));
    await type(q('payout-review-note'), 'Account name differs from profile');
    await click(q('payout-review-submit'));
    expect(rpcCalls.find((c) => c.name === 'admin_review_withdrawal')!.params).toEqual({ p_request_id: 'w-1', p_amount_kobo: 3000000, p_decision: 'recommend_reject', p_note: 'Account name differs from profile' });
    expect(rpcCalls.filter((c) => c.name === 'admin_list_withdrawals').length).toBeGreaterThan(lists);
  });

  it('Approve for Payment needs the typed word, approves only, and never pays', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, can_approve: true }];
    await render();
    await click(q('payout-approve-w-1'));
    await click(q('payout-approve-submit'));
    expect(rpcCalls.some((c) => c.name === 'admin_approve_withdrawal_for_payment')).toBe(false);
    await type(q('payout-approve-typed'), 'approve');
    await click(q('payout-approve-submit'));
    expect(rpcCalls.find((c) => c.name === 'admin_approve_withdrawal_for_payment')!.params).toEqual({ p_request_id: 'w-1', p_amount_kobo: 3000000, p_note: null });
    expect(fetchCalls).toEqual([]);
  });

  it('Authorize & Pay: needs all 10 digits; sends the PIN, amount and an idempotency key once, even on a double click', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, stage: 'vents_admin_approved', approved_by: 'root', pin_required: true, can_authorize_pay: true }];
    await render();
    await click(q('payout-pay-w-1'));
    await type(q('payout-pay-pin'), '482619');
    expect((q('payout-pay-submit') as HTMLButtonElement).disabled).toBe(true);
    await type(q('payout-pay-pin'), '4826193057');
    let release!: () => void;
    fetchGate = new Promise<void>((r) => { release = r; });
    const btn = q('payout-pay-submit')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    release();
    await act(async () => { await flush(); });
    const pays = fetchCalls.filter((c) => c.body.action === 'authorize_pay');
    expect(pays).toHaveLength(1);
    expect(pays[0].url).toBe('/api/v1/wallet/admin-payout-action');
    expect(pays[0].body).toMatchObject({ action: 'authorize_pay', request_id: 'w-1', amount_kobo: 3000000, pin: '4826193057' });
    expect(pays[0].body.idempotency_key).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
    expect(q('payout-message')!.textContent).toMatch(/marked paid only when Paystack confirms/);
  });

  it('a wrong PIN shows the attempts left, clears the PIN, and a retry reuses the same key', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, stage: 'vents_admin_approved', approved_by: 'root', pin_required: true, can_authorize_pay: true }];
    fetchResponses = [{ status: 401, json: { error: 'Wrong PIN. 4 attempts left', code: 'wrong_pin', attempts_left: 4 } }];
    await render();
    await click(q('payout-pay-w-1'));
    await type(q('payout-pay-pin'), '1111111112');
    await click(q('payout-pay-submit'));
    expect(q('payout-pay-error')!.textContent).toMatch(/4 attempts left/);
    expect((q('payout-pay-pin') as HTMLInputElement).value).toBe('');
    await type(q('payout-pay-pin'), '4826193057');
    await click(q('payout-pay-submit'));
    const keys = fetchCalls.filter((c) => c.body.action === 'authorize_pay').map((c) => c.body.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('Reject: needs a reason and sends one request', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, can_approve: true, can_reject: true }];
    await render();
    await click(q('payout-reject-w-1'));
    await type(q('payout-reject-reason'), 'Account under review');
    const btn = q('payout-reject-submit')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    const rejects = fetchCalls.filter((c) => c.body.action === 'reject');
    expect(rejects).toHaveLength(1);
    expect(rejects[0].body).toEqual({ action: 'reject', request_id: 'w-1', reason: 'Account under review' });
  });

  it('PIN creation (VENTS Admin): weak PINs are refused before sending; a good one is sent with the password', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    await render();
    await click(q('admin-payout-pin-open'));
    await type(container!.querySelector('#apin-password') as HTMLElement, 'secret-pass');
    await type(container!.querySelector('#apin-new') as HTMLElement, '1234567890');
    await type(container!.querySelector('#apin-confirm') as HTMLElement, '1234567890');
    await click(q('admin-payout-pin-save'));
    expect(q('admin-payout-pin-error')!.textContent).toMatch(/too easy to guess/);
    expect(fetchCalls).toEqual([]);
    fetchResponses = [{ status: 200, json: { ok: true, pin_status: { has_pin: true } } }];
    await type(container!.querySelector('#apin-password') as HTMLElement, 'secret-pass');
    await type(container!.querySelector('#apin-new') as HTMLElement, '4826193057');
    await type(container!.querySelector('#apin-confirm') as HTMLElement, '4826193057');
    await click(q('admin-payout-pin-save'));
    expect(fetchCalls[0]).toEqual({ url: '/api/v1/wallet/save-bank', body: { action: 'set_admin_payout_pin', password: 'secret-pass', pin: '4826193057', pin_confirm: '4826193057' } });
  });

  it('a backend without 0213 shows an upgrade message instead of broken buttons', async () => {
    rpcErrors = { admin_payout_overview: { code: 'PGRST202', message: 'Could not find the function' } };
    await render();
    expect(q('payouts-unavailable')).toBeTruthy();
    expect(container!.querySelectorAll('button')).toHaveLength(0);
  });
});
