import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Admin → Payouts → "Request earnings adjustment" (0206): files a request
// through admin_request_earnings_adjustment only; never writes a wallet,
// the ledger or the adjustment table.

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc, from } }));

import { EarningsAdjustmentForm } from './EarningsAdjustmentForm';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  rpc.mockReset(); from.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<EarningsAdjustmentForm />); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function setValue(label: string, value: string) {
  const el = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
}
function click(testId: string) {
  act(() => { (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click(); });
}
async function submit() {
  await act(async () => { (container.querySelector('[data-testid="earnings-adjustment-submit"]') as HTMLButtonElement).click(); });
}
const resultText = () => container.querySelector('[data-testid="earnings-adjustment-result"]')?.textContent || '';

describe('EarningsAdjustmentForm', () => {
  it('files a valid request through the server helper only, and says nothing has moved', async () => {
    rpc.mockResolvedValue({ data: { id: 'abcdef12-0000' }, error: null });
    setValue('Organizer user id', 'org-1');
    click('earnings-adjustment-kind-wallet_debit');
    setValue('Amount (₦)', '323.50');
    setValue('Reason', 'Unsourced balance removed per owner decision D2');
    setValue('Evidence reference', 'Batch D 10.9');
    await submit();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_request_earnings_adjustment', expect.objectContaining({
      p_organizer_id: 'org-1', p_kind: 'wallet_debit', p_direction: 'debit', p_amount_kobo: 32350,
      p_withdrawal_request_id: null, p_paid_at: null,
    }));
    expect(from).not.toHaveBeenCalled();
    expect(resultText()).toMatch(/different super admin must approve/);
    expect(resultText()).toMatch(/Nothing has moved yet/);
  });

  it('a late payout sends the withdrawal request and the Paystack date', async () => {
    rpc.mockResolvedValue({ data: { id: 'r2' }, error: null });
    setValue('Organizer user id', 'org-1');
    click('earnings-adjustment-kind-late_recorded_payout');
    setValue('Amount (₦)', '100');
    setValue('Withdrawal request id', 'w-1');
    setValue('Paid at (from Paystack)', '2026-07-10T11:05');
    setValue('Reason', 'Paystack LIVE shows this transfer paid on 2026-07-10');
    setValue('Evidence reference', 'Paystack export TRF_x');
    await submit();
    expect(rpc).toHaveBeenCalledWith('admin_request_earnings_adjustment', expect.objectContaining({
      p_kind: 'late_recorded_payout', p_direction: 'debit', p_amount_kobo: 10000, p_withdrawal_request_id: 'w-1', p_paid_at: new Date('2026-07-10T11:05').toISOString(),
    }));
  });

  it('an invalid request is stopped before the server', async () => {
    setValue('Organizer user id', 'org-1');
    setValue('Amount (₦)', '100');
    setValue('Reason', 'short');
    setValue('Evidence reference', 'x');
    await submit();
    expect(rpc).not.toHaveBeenCalled();
    expect(resultText()).toMatch(/20 characters/);
  });

  it('a server refusal is shown', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'An admin cannot request an adjustment to their own wallet' } });
    setValue('Organizer user id', 'me');
    setValue('Amount (₦)', '1');
    setValue('Reason', 'A correction with a long enough reason');
    setValue('Evidence reference', 'x');
    await submit();
    expect(resultText()).toBe('An admin cannot request an adjustment to their own wallet');
  });
});
