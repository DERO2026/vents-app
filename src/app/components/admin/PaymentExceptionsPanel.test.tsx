import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// H1 / OEL-02: the admin view of captured payments that could not become a
// ticket. Read for every admin; "Record resolution" only for Admin/Root,
// note required; it calls the record-only RPC and nothing else.

const rpc = vi.fn();
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc: (n: string, a: any) => rpc(n, a) } }));

import { PaymentExceptionsPanel, reasonText } from './PaymentExceptionsPanel';

const ROW = {
  id: 'x1', reference: 'PSK-abc', reason: 'not_found', detail: 'Only 0 VIP ticket(s) remaining',
  amount_kobo: 4567500, expected_kobo: null, source: 'webhook', status: 'open', resolution_note: null,
  resolved_at: null, seen_count: 2, first_seen_at: '2026-11-26T10:00:00Z',
  buyer_username: 'buyer1', buyer_email: 'buyer@example.com', event_title: 'Afro Night',
};

let container: HTMLDivElement; let root: Root;
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render(isSuperAdmin: boolean) {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<PaymentExceptionsPanel isSuperAdmin={isSuperAdmin} />); });
  await flush();
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
afterEach(() => { act(() => root.unmount()); container.remove(); rpc.mockReset(); });

describe('PaymentExceptionsPanel', () => {
  it('lists open exceptions with amount, reason, buyer, event and reference', async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await render(true);
    expect(rpc).toHaveBeenCalledWith('admin_list_payment_exceptions', { p_status: 'open', p_limit: 100, p_offset: 0 });
    const row = q('payment-exception-row')!.textContent!;
    expect(row).toContain('₦45,675.00');
    expect(row).toContain('Ticket not issued: Only 0 VIP ticket(s) remaining');
    expect(row).toContain('buyer1 · buyer@example.com · Afro Night');
    expect(row).toContain('PSK-abc');
    expect(row).toContain('seen 2×');
  });

  it('shows an empty state', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await render(true);
    expect(q('payment-exceptions-empty')!.textContent).toBe('No open payment exceptions');
  });

  it('shows the server error instead of an empty list', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Admin access required' } });
    await render(true);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Admin access required');
    expect(q('payment-exceptions-empty')).toBeNull();
  });

  it('a Sub-Admin sees the list but cannot record a resolution', async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await render(false);
    expect(q('payment-exception-row')).toBeTruthy();
    expect(q('payment-exception-resolve')).toBeNull();
  });

  it('switching the filter reloads that status', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await render(true);
    await act(async () => { q('payment-exceptions-filter-resolved')!.click(); }); await flush();
    expect(rpc).toHaveBeenLastCalledWith('admin_list_payment_exceptions', { p_status: 'resolved', p_limit: 100, p_offset: 0 });
  });

  it('Record resolution needs a note, then calls only the record-only RPC and reloads', async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await render(true);
    await act(async () => { q('payment-exception-resolve')!.click(); });
    await act(async () => { q('payment-exception-save')!.click(); });
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/at least 5 characters/);
    expect(rpc).not.toHaveBeenCalledWith('admin_resolve_payment_exception', expect.anything());

    const ta = q('payment-exception-note') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(ta, 'Refunded in Paystack, RF-1'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('payment-exception-save')!.click(); }); await flush();
    expect(rpc).toHaveBeenCalledWith('admin_resolve_payment_exception', { p_id: 'x1', p_note: 'Refunded in Paystack, RF-1' });
    const names = rpc.mock.calls.map(([n]) => n);
    expect(names.every((n) => n === 'admin_list_payment_exceptions' || n === 'admin_resolve_payment_exception')).toBe(true);
    expect(names.filter((n) => n === 'admin_list_payment_exceptions').length).toBe(2);
  });

  it('reason text for an amount mismatch', () => {
    expect(reasonText({ ...ROW, reason: 'amount_mismatch', detail: null, amount_kobo: 100, expected_kobo: 4567500 } as any))
      .toBe('Amount paid (₦1.00) did not match the order (₦45,675.00)');
  });

  it('reason text for an overpaid transfer fee (0239): only the excess is refundable', () => {
    expect(reasonText({ ...ROW, kind: 'ticket_transfer_fee', reason: 'overpayment', detail: null, amount_kobo: 7000, expected_kobo: 50000 } as any))
      .toBe('Transfer fee overpaid: the transfer completed; only the extra ₦70.00 is refundable (fee ₦500.00)');
  });
});
