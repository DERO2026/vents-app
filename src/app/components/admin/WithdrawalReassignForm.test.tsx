import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// "Move to another bank account" (0207): lists only the organizer's active,
// verified accounts with masked numbers, and files a request through
// admin_request_withdrawal_bank_reassignment only.

const { rpc, from, accounts } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), accounts: { rows: [] as any[] } }));
vi.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc,
    from: (table: string) => {
      from(table);
      const q: any = { select: () => q, eq: () => Promise.resolve({ data: accounts.rows, error: null }) };
      return q;
    },
  },
}));

import { WithdrawalReassignForm } from './WithdrawalReassignForm';

let container: HTMLDivElement;
let root: Root;
async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<WithdrawalReassignForm requestId="w1" organizerId="org-1" />); });
}
beforeEach(() => { rpc.mockReset(); from.mockReset(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
function setReason(v: string) {
  const el = q('[aria-label="Reason"]') as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, v);
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('WithdrawalReassignForm', () => {
  it('offers only active, verified accounts, masked, and files through the helper', async () => {
    accounts.rows = [
      { id: 'old', bank_name: 'Old Bank', account_number: '1111111111', is_active: false, recipient_code: 'RCP_old' },
      { id: 'unv', bank_name: 'Unverified', account_number: '4444444444', is_active: true, recipient_code: null },
      { id: 'new', bank_name: 'New Bank', account_number: '2222222234', is_active: true, recipient_code: 'RCP_new' },
    ];
    await mount();
    expect(from).toHaveBeenCalledWith('organizer_bank_accounts');
    expect(q('[data-testid="withdrawal-reassign-option-old"]')).toBeNull();
    expect(q('[data-testid="withdrawal-reassign-option-unv"]')).toBeNull();
    const opt = q('[data-testid="withdrawal-reassign-option-new"]')!;
    expect(opt.textContent).toBe('New Bank ****2234');
    expect(container.textContent).not.toContain('2222222234');
    rpc.mockResolvedValue({ data: { id: 'abcdef12-x' }, error: null });
    act(() => { opt.click(); });
    setReason('Organizer deactivated the old account; moving to their verified one');
    await act(async () => { (q('[data-testid="withdrawal-reassign-submit"]') as HTMLButtonElement).click(); });
    expect(rpc).toHaveBeenCalledWith('admin_request_withdrawal_bank_reassignment', {
      p_withdrawal_request_id: 'w1', p_new_bank_account_id: 'new', p_reason: 'Organizer deactivated the old account; moving to their verified one',
    });
    expect(q('[data-testid="withdrawal-reassign-result"]')!.textContent).toMatch(/has not moved yet/);
  });

  it('says so when the organizer has no eligible account, and cannot submit', async () => {
    accounts.rows = [{ id: 'old', bank_name: 'Old', account_number: '1', is_active: false, recipient_code: 'RCP' }];
    await mount();
    expect(q('[data-testid="withdrawal-reassign-none"]')).not.toBeNull();
    expect((q('[data-testid="withdrawal-reassign-submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an invalid request is stopped before the server', async () => {
    accounts.rows = [{ id: 'new', bank_name: 'New', account_number: '2222', is_active: true, recipient_code: 'RCP' }];
    await mount();
    act(() => { q('[data-testid="withdrawal-reassign-option-new"]')!.click(); });
    setReason('short');
    await act(async () => { (q('[data-testid="withdrawal-reassign-submit"]') as HTMLButtonElement).click(); });
    expect(rpc).not.toHaveBeenCalled();
    expect(q('[data-testid="withdrawal-reassign-result"]')!.textContent).toMatch(/20 characters/);
  });
});
