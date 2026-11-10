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
let listImpl: ((params: any) => any[]) | null = null;

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
      if (name === 'admin_list_withdrawals') return Promise.resolve({ data: listImpl ? listImpl(params) : rows, error: null });
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
  rpcCalls.length = 0; fetchCalls.length = 0; rows = []; overview = ov(); rpcErrors = {}; fetchResponses = []; fetchGate = null; listImpl = null;
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
    // First page: no cursor (works on any backend), 50 rows, newest first from the server (0214).
    expect(rpcCalls.find((c) => c.name === 'admin_list_withdrawals')!.params).toEqual({ p_scope: 'open', p_limit: 50 });
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
      { ...base, request_id: 'a', can_approve: true, can_reject: true, can_request_bank_change: false },
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
    expect(q('payout-next-w-1')!.textContent).toMatch(/Next step\s*The VENTS Admin/);
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

// ── 0214: newest first, pagination, every authorized action, bank problems ──
const v14 = { can_forward: false, can_reconcile: false, can_cancel: false, can_request_bank_change: false, bank_problem: null };
const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();
const cardIds = () => Array.from(container!.querySelectorAll('[data-testid^="payout-card-"]')).map((e) => e.getAttribute('data-testid')!.replace('payout-card-', ''));
const listCalls = () => rpcCalls.filter((c) => c.name === 'admin_list_withdrawals');

describe('PayoutRequestsPanel: order and pagination (0214)', () => {
  it('shows the newest request first, even if a page arrives out of order', async () => {
    rows = [
      { ...base, ...v14, request_id: 'old', created_at: at(1) },
      { ...base, ...v14, request_id: 'new', created_at: at(9) },
      { ...base, ...v14, request_id: 'mid', created_at: at(5) },
    ];
    await render();
    expect(cardIds()).toEqual(['new', 'mid', 'old']);
    expect(q('payout-order-note')!.textContent).toBe('Newest first');
  });

  it('ties on created_at are ordered by id, like the server', async () => {
    rows = [{ ...base, ...v14, request_id: 'a', created_at: at(3) }, { ...base, ...v14, request_id: 'c', created_at: at(3) }, { ...base, ...v14, request_id: 'b', created_at: at(3) }];
    await render();
    expect(cardIds()).toEqual(['c', 'b', 'a']);
  });

  it('Load more sends the last row as the cursor, appends older rows without duplicates, and stops at the end', async () => {
    const all = Array.from({ length: 60 }, (_, i) => ({ ...base, ...v14, request_id: `r${String(59 - i).padStart(2, '0')}`, created_at: new Date(Date.UTC(2026, 10, 10, 0, 59 - i)).toISOString() }));
    listImpl = (p) => {
      const start = p.p_before_created_at ? all.findIndex((r) => r.request_id === p.p_before_id) + 1 : 0;
      return all.slice(start, start + p.p_limit);
    };
    await render();
    expect(cardIds()).toHaveLength(50);
    expect(cardIds()[0]).toBe('r59');
    await click(q('payout-load-more'));
    const last = listCalls()[listCalls().length - 1].params;
    expect(last).toEqual({ p_scope: 'open', p_limit: 50, p_before_created_at: all[49].created_at, p_before_id: 'r10' });
    expect(cardIds()).toEqual(all.map((r) => r.request_id));
    expect(q('payout-load-more')).toBeNull();
    expect(q('payout-list-end')!.textContent).toMatch(/All 60 open requests shown/);
  });

  it('a refresh keeps every loaded row (asks for as many as are shown) and a new withdrawal lands on top', async () => {
    const all = Array.from({ length: 55 }, (_, i) => ({ ...base, ...v14, request_id: `r${String(54 - i).padStart(2, '0')}`, created_at: new Date(Date.UTC(2026, 10, 10, 0, 54 - i)).toISOString() }));
    listImpl = (p) => {
      const start = p.p_before_created_at ? all.findIndex((r) => r.request_id === p.p_before_id) + 1 : 0;
      return all.slice(start, start + p.p_limit);
    };
    await render();
    await click(q('payout-load-more'));
    expect(cardIds()).toHaveLength(55);
    all.unshift({ ...base, ...v14, request_id: 'brand-new', created_at: new Date(Date.UTC(2026, 10, 10, 2)).toISOString() });
    await act(async () => { window.dispatchEvent(new Event('focus')); await flush(); });
    expect(listCalls()[listCalls().length - 1].params).toEqual({ p_scope: 'open', p_limit: 55 });
    expect(cardIds()[0]).toBe('brand-new');
  });

  it('refreshes every 30 seconds, but not while a dialog is open', async () => {
    vi.useFakeTimers();
    try {
      rows = [{ ...base, ...v14, can_review: true, can_forward: true }];
      await render();
      const n = listCalls().length;
      await act(async () => { vi.advanceTimersByTime(30000); await flush(); });
      expect(listCalls().length).toBe(n + 1);
      await click(q('payout-review-w-1'));
      await act(async () => { vi.advanceTimersByTime(60000); await flush(); });
      expect(listCalls().length).toBe(n + 1);
    } finally { vi.useRealTimers(); }
  });

  it('Open, Closed and All each ask the server for that scope, newest first, from page one', async () => {
    rows = [{ ...base, ...v14 }];
    await render();
    for (const s of ['closed', 'all', 'open'] as const) {
      await click(q(`payout-scope-${s}`));
      expect(listCalls()[listCalls().length - 1].params).toEqual({ p_scope: s, p_limit: 50 });
    }
  });

  it('on a backend without 0214 (oldest-first, no paging) it reads up to 500 rows, sorts them, and offers no broken Load more', async () => {
    // 0213 returns open requests oldest first: the newest is the last row.
    const old = Array.from({ length: 80 }, (_, i) => ({ ...base, request_id: `x${String(i).padStart(2, '0')}`, created_at: new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString() }));
    listImpl = (p) => old.slice(0, p.p_limit);
    await render();
    expect(listCalls().map((c) => c.params)).toEqual([{ p_scope: 'open', p_limit: 50 }, { p_scope: 'open', p_limit: 500 }]);
    expect(cardIds()).toHaveLength(80);
    expect(cardIds()[0]).toBe('x79');
    expect(q('payout-load-more')).toBeNull();
    expect(q('payout-list-end')!.textContent).toMatch(/0214/);
  });
});

// Every server flag (0214) renders its button, and only those. Buttons sit
// together in the card footer, in one fixed order.
const MATRIX: { name: string; tier: 'root' | 'admin' | 'sub'; row: any; buttons: string[] }[] = [
  { name: 'pending review / VENTS Admin', tier: 'root', row: { can_approve: true, can_reject: true, can_request_bank_change: true }, buttons: ['Approve for Payment', 'Move to another bank account', 'Reject'] },
  { name: 'pending review / admin', tier: 'admin', row: { can_review: true, can_forward: true, can_reject: true, can_request_bank_change: true }, buttons: ['Review', 'Move to another bank account', 'Reject'] },
  { name: 'pending review / sub-admin', tier: 'sub', row: { can_review: true, can_forward: true, can_request_bank_change: true }, buttons: ['Review', 'Move to another bank account'] },
  { name: 'forwarded / VENTS Admin', tier: 'root', row: { stage: 'forwarded_to_vents_admin', next_action: 'vents_admin', can_approve: true, can_reject: true, can_request_bank_change: true }, buttons: ['Approve for Payment', 'Move to another bank account', 'Reject'] },
  { name: 'rejection recommended / VENTS Admin', tier: 'root', row: { stage: 'rejection_recommended', next_action: 'vents_admin', can_approve: true, can_reject: true }, buttons: ['Approve for Payment', 'Reject'] },
  { name: 'approved / VENTS Admin', tier: 'root', row: { stage: 'vents_admin_approved', approved_by: 'root', pin_required: true, can_authorize_pay: true, can_reject: true }, buttons: ['Authorize & Pay', 'Reject'] },
  { name: 'approved / admin', tier: 'admin', row: { stage: 'vents_admin_approved', approved_by: 'root', pin_required: true, can_reject: true }, buttons: ['Reject'] },
  { name: 'approved / sub-admin', tier: 'sub', row: { stage: 'vents_admin_approved', approved_by: 'root', pin_required: true }, buttons: [] },
  { name: 'processing / VENTS Admin', tier: 'root', row: { status: 'processing', stage: 'processing', next_action: 'paystack', paystack_reference: 'payout_w1', can_reconcile: true }, buttons: ['Check with Paystack'] },
  { name: 'processing, never sent / admin', tier: 'admin', row: { status: 'processing', stage: 'processing', next_action: 'paystack', can_reconcile: true, can_cancel: true }, buttons: ['Check with Paystack', 'Cancel (never sent)'] },
  { name: 'processing / sub-admin', tier: 'sub', row: { status: 'processing', stage: 'processing', next_action: 'paystack' }, buttons: [] },
  { name: 'paid', tier: 'root', row: { status: 'completed', stage: 'paid', next_action: null }, buttons: [] },
  { name: 'failed', tier: 'admin', row: { status: 'failed', stage: 'failed', next_action: null, admin_note: 'Paystack transfer.failed' }, buttons: [] },
  { name: 'rejected', tier: 'root', row: { status: 'rejected', stage: 'rejected', next_action: null, admin_note: 'Wrong account' }, buttons: [] },
  { name: 'cancelled', tier: 'sub', row: { status: 'cancelled', stage: 'cancelled', next_action: null }, buttons: [] },
];

describe('PayoutRequestsPanel: every authorized action, by role and status (0214)', () => {
  for (const m of MATRIX) {
    it(m.name, async () => {
      overview = ov({ is_vents_admin: m.tier === 'root', viewer_tier: m.tier });
      rows = [{ ...base, ...v14, ...m.row }];
      await render();
      const card = q('payout-card-w-1')!;
      const actions = q('payout-actions-w-1');
      if (m.buttons.length === 0) {
        expect(actions).toBeNull();
        expect(q('payout-no-actions-w-1')).toBeTruthy();
      } else {
        expect(Array.from(actions!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(m.buttons);
        // grouped at the bottom: the footer is the card's last block and holds the actions
        expect(card.lastElementChild!.getAttribute('data-testid')).toBe('payout-footer-w-1');
        expect(q('payout-footer-w-1')!.contains(actions)).toBe(true);
      }
      if (['completed', 'failed', 'rejected', 'cancelled'].includes(m.row.status)) {
        expect(q('payout-note-w-1')!.textContent).toMatch(/Final/);
      }
      expect(container!.textContent).not.toMatch(/Approve & Pay|Pay now/);
      // every card shows the essentials
      for (const id of ['payout-stage', 'payout-amount', 'payout-bank', 'payout-verification', 'payout-date', 'payout-ref', 'payout-wallet', 'payout-history']) {
        expect(q(`${id}-w-1`), id).toBeTruthy();
      }
    });
  }
});

describe('PayoutRequestsPanel: bank accounts that cannot be paid (0214)', () => {
  it('names the problem, explains it, and offers only what the role may do', async () => {
    overview = ov({ viewer_tier: 'sub' });
    rows = [{ ...base, ...v14, bank_account_active: false, account_verified: true, bank_problem: 'inactive', can_review: true, can_forward: false, can_request_bank_change: true }];
    await render();
    expect(q('payout-verification-w-1')!.textContent).toMatch(/Inactive account/);
    expect(q('payout-bank-problem-w-1')!.textContent).toMatch(/Transfer blocked.*inactive.*recommend rejection/i);
    expect(buttonsOf('w-1')).toEqual(['Review', 'Move to another bank account']);
  });

  it('Review cannot forward to an inactive or unverified account: recommend rejection is preselected and sent', async () => {
    overview = ov({ viewer_tier: 'sub' });
    rows = [{ ...base, ...v14, account_verified: false, bank_problem: 'unverified', can_review: true, can_forward: false }];
    await render();
    await click(q('payout-review-w-1'));
    expect((q('payout-review-decision-forward') as HTMLButtonElement).disabled).toBe(true);
    expect(q('payout-review-forward-blocked')!.textContent).toMatch(/no verified Paystack recipient/);
    await click(q('payout-review-decision-forward'));
    await type(q('payout-review-note'), 'Account not verified');
    await click(q('payout-review-submit'));
    expect(rpcCalls.find((c) => c.name === 'admin_review_withdrawal')!.params.p_decision).toBe('recommend_reject');
  });

  it('a bank change after approval is explained; there is no Authorize & Pay', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, ...v14, stage: 'vents_admin_approved', approved_by: 'root', approval_current: false, bank_problem: 'changed_since_approval', can_reject: true }];
    await render();
    expect(q('payout-bank-problem-w-1')!.textContent).toMatch(/changed after the VENTS Admin approved/);
    expect(buttonsOf('w-1')).toEqual(['Reject']);
    // no empty separators when the approval time is unknown; the banner is not repeated by the note
    expect(q('payout-approval-w-1')!.textContent).toBe('Approved for payment by VENTS Admin · bank changed since');
    expect(q('payout-note-w-1')).toBeNull();
  });

  it('a missing account is named', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, ...v14, bank_name: null, account_number_masked: null, bank_account_active: false, account_verified: false, bank_problem: 'missing', can_reject: true }];
    await render();
    expect(q('payout-verification-w-1')!.textContent).toMatch(/No bank account/);
    expect(q('payout-bank-problem-w-1')!.textContent).toMatch(/No bank account is attached/);
  });
});

describe('PayoutRequestsPanel: processing, cancel, Paystack failures, kill switch (0214)', () => {
  const proc = { status: 'processing', stage: 'processing', next_action: 'paystack', paystack_reference: 'payout_w1', can_reconcile: true };

  it('Check with Paystack reconciles only this request, says what happened, and re-reads the list', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, ...v14, ...proc }];
    fetchResponses = [{ status: 200, json: { checked: 1, results: [{ request_id: 'w-1', outcome: 'still_pending_on_paystack', paystack_status: 'pending' }] } }];
    await render();
    const n = listCalls().length;
    await click(q('payout-reconcile-w-1'));
    expect(fetchCalls).toEqual([{ url: '/api/v1/wallet/reconcile-payouts', body: { request_id: 'w-1' } }]);
    expect(q('payout-message')!.textContent).toMatch(/Paystack has not decided yet \(pending\)\. Nothing changed/);
    expect(listCalls().length).toBeGreaterThan(n);
  });

  it('a Paystack lookup failure is reported, not hidden', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, ...v14, ...proc }];
    fetchResponses = [{ status: 200, json: { checked: 1, results: [{ request_id: 'w-1', outcome: 'paystack_lookup_failed', detail: 'timeout' }] } }];
    await render();
    await click(q('payout-reconcile-w-1'));
    expect(q('payout-message')!.textContent).toMatch(/Could not reach Paystack \(timeout\)/);
  });

  it('Cancel (never sent) needs a reason and sends exactly one request, even on a double click', async () => {
    rows = [{ ...base, ...v14, status: 'processing', stage: 'processing', can_reconcile: true, can_cancel: true }];
    overview = ov({ viewer_tier: 'admin' });
    await render();
    await click(q('payout-cancel-w-1'));
    expect((q('payout-cancel-submit') as HTMLButtonElement).disabled).toBe(true);
    await type(q('payout-cancel-reason'), 'Never reached Paystack');
    const btn = q('payout-cancel-submit')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(fetchCalls.filter((c) => c.body.action === 'cancel')).toEqual([{ url: '/api/v1/wallet/admin-payout-action', body: { action: 'cancel', request_id: 'w-1', reason: 'Never reached Paystack' } }]);
  });

  it('Authorize & Pay: Paystack unconfirmed (502) keeps the key, so a retry can never send a second transfer', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, ...v14, stage: 'vents_admin_approved', approved_by: 'root', pin_required: true, can_authorize_pay: true }];
    fetchResponses = [{ status: 502, json: { status: 'processing', reference: 'payout_w1', error: 'Paystack has not confirmed this transfer (timeout). Nothing has been marked paid.' } }, { status: 409, json: { error: 'Already authorized: this withdrawal is processing. No second transfer was sent.', code: 'replayed' } }];
    await render();
    await click(q('payout-pay-w-1'));
    await type(q('payout-pay-pin'), '4826193057');
    await click(q('payout-pay-submit'));
    expect(q('payout-pay-error')!.textContent).toMatch(/Nothing has been marked paid/);
    await type(q('payout-pay-pin'), '4826193057');
    await click(q('payout-pay-submit'));
    const keys = fetchCalls.filter((c) => c.body.action === 'authorize_pay').map((c) => c.body.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(q('payout-pay-modal')).toBeNull();
    expect(q('payout-message')!.textContent).toMatch(/No second transfer was sent/);
  });

  it('a locked PIN or a refused claim gets a new key next time (a different attempt)', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, ...v14, stage: 'vents_admin_approved', approved_by: 'root', pin_required: true, can_authorize_pay: true }];
    fetchResponses = [{ status: 423, json: { error: 'Locked', code: 'pin_locked' } }];
    await render();
    await click(q('payout-pay-w-1'));
    await type(q('payout-pay-pin'), '4826193057');
    await click(q('payout-pay-submit'));
    await type(q('payout-pay-pin'), '4826193057');
    await click(q('payout-pay-submit'));
    const keys = fetchCalls.filter((c) => c.body.action === 'authorize_pay').map((c) => c.body.idempotency_key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('kill switch: money buttons stay visible but disabled, with the reason; Check with Paystack still works', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, ...v14, request_id: 'a', can_approve: true, can_reject: true }, { ...base, ...v14, ...proc, request_id: 'b', created_at: at(1) }];
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root!.render(<PayoutRequestsPanel payoutsDisabled />); await flush(); });
    await act(async () => { await flush(); });
    expect((q('payout-approve-a') as HTMLButtonElement).disabled).toBe(true);
    expect((q('payout-reject-a') as HTMLButtonElement).disabled).toBe(true);
    expect(q('payout-footer-a')!.textContent).toMatch(/Payouts are paused/);
    expect((q('payout-reconcile-b') as HTMLButtonElement).disabled).toBe(false);
  });

  it('buttons are touch-sized and wrap instead of overflowing', async () => {
    overview = ov({ is_vents_admin: true, viewer_tier: 'root' });
    rows = [{ ...base, ...v14, can_approve: true, can_reject: true, can_request_bank_change: true }];
    await render();
    const group = q('payout-actions-w-1')!;
    expect(group.style.flexWrap).toBe('wrap');
    for (const b of Array.from(group.querySelectorAll('button'))) {
      expect((b as HTMLElement).style.minHeight).toBe('44px');
      expect((b as HTMLElement).style.minWidth).toMatch(/^0(px)?$/);
      expect((b as HTMLElement).style.whiteSpace).toBe('normal');
    }
  });
});
