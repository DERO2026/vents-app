import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminPayoutsScreen } from './AdminPayoutsScreen';

// 0211: the Payouts screen shows the database's authoritative withdrawal
// state (admin_list_withdrawals) to admins and sub-admins alike, offers
// exactly the actions the server says THIS admin may take, explains why
// not otherwise, and re-reads the list after every action (no optimistic
// "success" that did nothing).

const rpcCalls: { name: string; params: any }[] = [];
let rows: any[] = [];
let rpcErrors: Record<string, string> = {};

const base = {
  request_id: 'w-1', organizer_id: 'org-1', organizer_name: 'Ada Organizer', organizer_email: 'ada@example.test', organizer_phone: null,
  amount_kobo: 3000000, status: 'pending', stage: 'pending_first_approval',
  bank_name: 'GTBank', account_number: '0123456789', account_name: 'ADA ORGANIZER', bank_account_active: true,
  created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z', admin_note: null,
  first_approval_id: null, first_approved_by: null, first_approved_by_name: null, first_approved_by_tier: null, first_approved_at: null,
  second_approved_by: null, second_approved_by_name: null, second_approved_at: null,
  paystack_reference: null, transfer_started: false,
  can_first_approve: false, can_second_approve: false, can_cancel_first_approval: false, can_pay: false, can_reject: false,
  action_note: null,
};

vi.mock('../../../lib/supabase', () => {
  function makeQuery(resolveData: any[]) {
    const q: any = {
      select: () => q, order: () => q, eq: () => q, limit: () => q, in: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any) => resolve({ data: resolveData, error: null }),
    };
    return q;
  }
  return {
    supabase: {
      from: () => makeQuery([]),
      rpc: (name: string, params: any) => {
        rpcCalls.push({ name, params });
        if (rpcErrors[name]) return Promise.resolve({ data: null, error: { message: rpcErrors[name] } });
        if (name === 'admin_list_withdrawals') return Promise.resolve({ data: rows, error: null });
        return Promise.resolve({ data: {}, error: null });
      },
      auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }), getUser: () => Promise.resolve({ data: { user: { id: 'me' } } }) },
    },
  };
});
vi.mock('../../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('./adminAuditLog', () => ({ notifyByEmail: () => {} }));
vi.mock('../../../lib/withTimeoutFallback', () => ({ withTimeoutFallback: (p: Promise<any>) => p }));
vi.mock('../../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => { rpcCalls.length = 0; rows = []; rpcErrors = {}; });
afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

async function render(isSuperAdmin = false) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<AdminPayoutsScreen isSuperAdmin={isSuperAdmin} />); await flush(); });
  await act(async () => { await flush(); });
}
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttonsOf = (id: string) => Array.from(q(`withdrawal-approvals-${id}`)!.querySelectorAll('button')).map((b) => b.textContent);
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); }); };
const confirmModal = async (typed?: string) => {
  if (typed) {
    const input = Array.from(container!.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder?.includes(typed)) as HTMLInputElement
      || (container!.querySelector('input[type="text"]') as HTMLInputElement);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, typed); input.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
  }
  const buttons = Array.from(container!.querySelectorAll('button'));
  const confirm = buttons.filter((b) => /^(Approve \((1st|2nd)\)|Pay now|Withdraw approval)$/.test(b.textContent || '')).pop();
  await click(confirm!);
};

describe('AdminPayoutsScreen: authoritative two-admin approval (0211)', () => {
  it('reads the authoritative list, never the tables directly', async () => {
    rows = [{ ...base, can_first_approve: true }];
    await render();
    expect(rpcCalls.find((c) => c.name === 'admin_list_withdrawals')!.params).toEqual({ p_scope: 'open', p_limit: 100 });
    expect(q('withdrawal-stage-w-1')!.textContent).toBe('NEEDS 1ST APPROVAL');
  });

  it('shows exactly the actions the server allows for this admin', async () => {
    rows = [
      { ...base, request_id: 'a', can_first_approve: true, can_reject: true },
      { ...base, request_id: 'b', stage: 'pending_second_approval', first_approved_by: 'sub-1', first_approved_by_name: 'Sub One', first_approved_by_tier: 'sub', first_approved_at: '2026-11-09T10:05:00Z', can_second_approve: true, can_reject: true },
      { ...base, request_id: 'c', stage: 'approved', first_approved_by: 'sub-1', first_approved_by_name: 'Sub One', second_approved_by: 'adm-2', second_approved_by_name: 'Admin B', can_pay: true, can_reject: true },
    ];
    await render(true);
    expect(buttonsOf('a')).toEqual(expect.arrayContaining(['Approve (1st)', 'Reject']));
    expect(buttonsOf('a')).not.toContain('Approve (2nd)');
    expect(buttonsOf('b')).toEqual(expect.arrayContaining(['Approve (2nd)', 'Reject']));
    expect(buttonsOf('b')).not.toContain('Pay now');
    expect(buttonsOf('c')).toEqual(expect.arrayContaining(['Pay now', 'Reject']));
    expect(q('withdrawal-first-approval-b')!.textContent).toMatch(/Sub One \(sub-admin\)/);
    expect(q('withdrawal-second-approval-c')!.textContent).toMatch(/Admin B/);
  });

  it('the first approver sees no second-approval button and the reason', async () => {
    rows = [{ ...base, stage: 'pending_second_approval', first_approved_by: 'me', first_approved_by_name: 'Me', first_approved_by_tier: 'sub',
      can_cancel_first_approval: true, action_note: 'You gave the first approval. A different admin must give the second.' }];
    await render();
    expect(buttonsOf('w-1')).not.toContain('Approve (2nd)');
    expect(buttonsOf('w-1')).toContain('Withdraw 1st approval');
    expect(q('withdrawal-action-note-w-1')!.textContent).toMatch(/different admin must give the second/);
  });

  it('a sub-admin after a sub-admin: no button, and why', async () => {
    rows = [{ ...base, stage: 'pending_second_approval', first_approved_by: 'sub-1', first_approved_by_tier: 'sub',
      action_note: 'The first approval came from a sub-admin, so the second must come from a full admin.' }];
    await render();
    expect(buttonsOf('w-1').filter((t) => /Approve|Pay/.test(t || ''))).toEqual([]);
    expect(q('withdrawal-action-note-w-1')!.textContent).toMatch(/must come from a full admin/);
    expect(container!.textContent).not.toMatch(/Only a full admin can reject/); // the note above explains instead
  });

  it('a sub-admin is told only a full admin can reject (no broken Reject button)', async () => {
    rows = [{ ...base, can_first_approve: true, can_reject: false }];
    await render(false);
    expect(buttonsOf('w-1')).not.toContain('Reject');
    expect(container!.textContent).toMatch(/Only a full admin can reject a withdrawal/);
  });

  it('first approval: confirms, calls the server with the reviewed amount, then re-reads the list', async () => {
    rows = [{ ...base, can_first_approve: true }];
    await render();
    const listsBefore = rpcCalls.filter((c) => c.name === 'admin_list_withdrawals').length;
    await click(q('withdrawal-first-approve-w-1'));
    expect(rpcCalls.some((c) => c.name === 'admin_first_approve_withdrawal')).toBe(false); // modal first
    await confirmModal();
    expect(rpcCalls.find((c) => c.name === 'admin_first_approve_withdrawal')!.params).toEqual({ p_request_id: 'w-1', p_amount_kobo: 3000000 });
    expect(rpcCalls.filter((c) => c.name === 'admin_list_withdrawals').length).toBeGreaterThan(listsBefore);
  });

  it('second approval needs the typed word and calls admin_approve_withdrawal; it never pays by itself', async () => {
    rows = [{ ...base, stage: 'pending_second_approval', first_approved_by: 'sub-1', can_second_approve: true }];
    await render(true);
    await click(q('withdrawal-second-approve-w-1'));
    await confirmModal('APPROVE');
    expect(rpcCalls.find((c) => c.name === 'admin_approve_withdrawal')!.params).toEqual({ p_request_id: 'w-1' });
    expect(rpcCalls.some((c) => c.name === 'admin_claim_payout_for_processing')).toBe(false);
  });

  it('a refusal from the server is shown and the list is re-read (no false success)', async () => {
    rows = [{ ...base, stage: 'pending_second_approval', first_approved_by: 'sub-1', can_second_approve: true }];
    rpcErrors = { admin_approve_withdrawal: 'This withdrawal already has both approvals' };
    await render(true);
    const listsBefore = rpcCalls.filter((c) => c.name === 'admin_list_withdrawals').length;
    await click(q('withdrawal-second-approve-w-1'));
    await confirmModal('APPROVE');
    expect(container!.textContent).toMatch(/already has both approvals/);
    expect(container!.textContent).not.toMatch(/Second approval recorded/);
    expect(rpcCalls.filter((c) => c.name === 'admin_list_withdrawals').length).toBeGreaterThan(listsBefore);
  });

  it('admin and sub-admin render the same authoritative stage for the same row', async () => {
    rows = [{ ...base, stage: 'approved', second_approved_by: 'adm-2', second_approved_by_name: 'Admin B' }];
    await render(true);
    const asAdmin = q('withdrawal-stage-w-1')!.textContent;
    act(() => root!.unmount()); container!.remove();
    await render(false);
    expect(q('withdrawal-stage-w-1')!.textContent).toBe(asAdmin);
    expect(asAdmin).toBe('APPROVED · READY TO PAY');
  });
});
