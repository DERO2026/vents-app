import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Admin → Cancellations (0218): review shows the server's amounts; only a
// Super Admin can decide; approval and rejection each need a confirmation;
// rejection needs a note; "Process refunds" appears only once approved.
const api = vi.hoisted(() => ({
  adminListEventCancellations: vi.fn(), adminGetEventCancellation: vi.fn(),
  adminDecideEventCancellation: vi.fn(), processCancellationRefunds: vi.fn(), adminRequeueCancellationRefund: vi.fn(),
}));
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc: vi.fn() }, getAuthToken: async () => '' }));
vi.mock('../../../lib/eventCancellation', async (orig) => ({ ...(await orig() as any), ...api }));

import { AdminCancellationsScreen } from './AdminCancellationsScreen';

const detail = (status: string) => ({
  request: { id: 'rq1', status, reason: 'The venue flooded', requested_at: '2026-11-18T10:00:00Z', decided_at: null, decision_note: null },
  event: { id: 'e1', title: 'Lagos Jazz Night', event_date: '2026-12-08T19:00:00Z' },
  organizer: { name: 'Org One' },
  obligations: { paid_tickets: 6, refund_pending: 0, ticket_holders: 4, pending_purchases: 1 },
  payments: { paystack: { tickets: 4, kobo: 4060000 }, wallet: { tickets: 1, kobo: 1015000 }, free: { tickets: 1, kobo: 0 } },
  checked_in: 1,
  attendees: [{ ticket_id: 't1', holder_name: 'Ada', ticket_type: 'Regular', amount_kobo: 1015000, payment_method: 'paystack', payment_status: 'paid', refund_status: 'failed', last_error: 'insufficient balance', attempts: 2 },
              { ticket_id: 't2', holder_name: 'Bo', ticket_type: 'Regular', amount_kobo: 1015000, payment_method: 'paystack', payment_status: 'refund_pending', refund_status: 'processing', unconfirmed: true, attempts: 1 }],
});

let container: HTMLDivElement; let root: Root;
const flush = () => new Promise((r) => setTimeout(r, 0));
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); await flush(); }); };
async function open(isSuperAdmin: boolean, status: string) {
  api.adminListEventCancellations.mockResolvedValue([{ id: 'rq1', event_title: 'Lagos Jazz Night', status, organizer_name: 'Org One', requested_at: '2026-11-18T10:00:00Z', obligations: { paid_tickets: 6 }, refunds: { total: 0 } }]);
  api.adminGetEventCancellation.mockResolvedValue(detail(status));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<AdminCancellationsScreen isSuperAdmin={isSuperAdmin} />); await flush(); });
  await click(q('cancellation-row-rq1'));
}
beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('AdminCancellationsScreen', () => {
  it('review shows the server amounts by payment method, checked-in and pending purchases, and each ticket', async () => {
    await open(true, 'requested');
    expect(q('cancellation-pay-paystack')?.textContent).toContain('4 ticket(s) · ₦40,600 to refund');
    expect(q('cancellation-pay-wallet')?.textContent).toContain('₦10,150 to refund');
    expect(q('cancellation-pay-free')?.textContent).toContain('no money');
    expect(container.textContent).toContain('1 ticket(s) were checked in');
    expect(q('cancellation-pending-purchases')).not.toBeNull();
    expect(q('cancellation-ticket-t1')?.textContent).toMatch(/Failed · will retry.*insufficient balance.*attempt 2/);
    expect(q('cancellation-ticket-t2')?.textContent).toContain('check it in Paystack before reverting');
  });

  it('approval needs an explicit confirmation and records the decision through the server', async () => {
    await open(true, 'requested');
    api.adminDecideEventCancellation.mockResolvedValue({ status: 'attention', refunds_queued: 6 });
    await click(q('cancellation-approve'));
    expect(api.adminDecideEventCancellation).not.toHaveBeenCalled();
    expect(q('cancellation-confirm')?.textContent).toMatch(/taken off sale now and 6 paid ticket\(s\) are queued for refunds\. This cannot be undone\./);
    await click(q('cancellation-confirm-yes'));
    expect(api.adminDecideEventCancellation).toHaveBeenCalledWith('rq1', true, '');
    expect(q('cancellation-msg')?.textContent).toBe('Approved. 6 refund(s) queued.');
  });

  it('rejection needs a note', async () => {
    await open(true, 'requested');
    expect((q('cancellation-reject') as HTMLButtonElement).disabled).toBe(true);
    const ta = container.querySelector('textarea[aria-label="Decision note"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'Move the date instead');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    api.adminDecideEventCancellation.mockResolvedValue({ status: 'rejected' });
    await click(q('cancellation-reject'));
    await click(q('cancellation-confirm-yes'));
    expect(api.adminDecideEventCancellation).toHaveBeenCalledWith('rq1', false, 'Move the date instead');
  });

  it('only a Super Admin sees decision controls', async () => {
    await open(false, 'requested');
    expect(q('cancellation-approve')).toBeNull();
    expect(container.textContent).toContain('Only a Super Admin can approve or reject a cancellation.');
  });

  it('refund processing appears once approved and reports the run (Super Admin, 0219)', async () => {
    await open(true, 'attention');
    expect(q('cancellation-approve')).toBeNull();
    api.processCancellationRefunds.mockResolvedValue({ claimed: 3, refunded: 1, pending: 1, failed: 1, errors: ['x'] });
    await click(q('cancellation-process'));
    expect(api.processCancellationRefunds).toHaveBeenCalledWith('rq1', 10);
    expect(q('cancellation-msg')?.textContent).toBe('Processed 3: 1 refunded, 1 awaiting Paystack, 1 failed.');
  });

  it('a sub-admin cannot process refunds (0219: the release path needs a Super Admin)', async () => {
    await open(false, 'attention');
    expect(q('cancellation-process')).toBeNull();
    expect(q('cancellation-process-super-only')?.textContent).toBe('Only a Super Admin can process refunds.');
    expect(q('cancellation-requeue-t1')).toBeNull();
  });

  it('a failed refund of a still-paid ticket can be re-queued with a note; one in flight cannot', async () => {
    await open(true, 'attention');
    expect(q('cancellation-requeue-t2')).toBeNull();            // refund_pending: may be in flight at Paystack
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce(null).mockReturnValueOnce('Paystack balance topped up');
    await click(q('cancellation-requeue-t1'));
    expect(api.adminRequeueCancellationRefund).not.toHaveBeenCalled();   // cancelled: nothing sent
    api.adminRequeueCancellationRefund.mockResolvedValue(undefined);
    await click(q('cancellation-requeue-t1'));
    expect(api.adminRequeueCancellationRefund).toHaveBeenCalledWith('rq1', 't1', 'Paystack balance topped up');
    expect(q('cancellation-msg')?.textContent).toContain('Refund re-queued');
    prompt.mockRestore();
  });
});
