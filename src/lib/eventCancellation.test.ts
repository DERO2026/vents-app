import { describe, it, expect, vi, beforeEach } from 'vitest';

// The admin "Process refunds" run (0218). Each claimed ticket goes through
// the EXISTING refund API with only its id and the server's reason: no
// amount ever leaves the client, and nothing is marked refunded here. A
// failure is reported to the server; the ticket's own state decides the rest.
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { rpc }, getAuthToken: async () => 'admin-jwt' }));
vi.mock('./apiBase', () => ({ apiUrl: (p: string) => `https://api.test${p}` }));

import { processCancellationRefunds, attendeeRefundLabel, CANCELLATION_STATUS_LABEL, requestEventCancellation, adminRequeueCancellationRefund, CANCELLATION_UNAVAILABLE_MESSAGE } from './eventCancellation';

const fetchMock = vi.fn();
beforeEach(() => {
  rpc.mockReset(); fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
const res = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('processCancellationRefunds: rate limits (review)', () => {
  it('after a rate-limit refusal the rest of the run makes no more refund calls; each is recorded for the next run', async () => {
    rpc.mockImplementation(async (name: string) => name === 'admin_claim_event_cancellation_refunds'
      ? { data: { reason: 'Event cancelled: x', tickets: [{ ticket_id: 't1' }, { ticket_id: 't2' }, { ticket_id: 't3' }] }, error: null }
      : { data: 'failed', error: null });
    fetchMock.mockResolvedValueOnce(res(400, { error: 'rate_limited' }));
    const out = await processCancellationRefunds('req-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ claimed: 3, failed: 3 });
    const recorded = rpc.mock.calls.filter(([n]) => n === 'admin_record_event_cancellation_refund_error').map(([, a]) => a.p_ticket_id);
    expect(recorded).toEqual(['t1', 't2', 't3']);
  });
  it("the API's own 429 (global Paystack ceiling) stops the run the same way", async () => {
    rpc.mockImplementation(async (name: string) => name === 'admin_claim_event_cancellation_refunds'
      ? { data: { reason: 'r', tickets: [{ ticket_id: 't1' }, { ticket_id: 't2' }] }, error: null } : { data: 'failed', error: null });
    fetchMock.mockResolvedValueOnce(res(429, { error: 'Too many requests. Please try again in a bit.' }));
    await processCancellationRefunds('req-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('an unconfirmed Paystack outcome does not stop the run (it is per ticket)', async () => {
    rpc.mockImplementation(async (name: string) => name === 'admin_claim_event_cancellation_refunds'
      ? { data: { reason: 'r', tickets: [{ ticket_id: 't1' }, { ticket_id: 't2' }] }, error: null } : { data: 'unchanged', error: null });
    fetchMock.mockResolvedValueOnce(res(502, { error: 'Paystack did not confirm this refund (no answer from Paystack in time).', unconfirmed: true }))
             .mockResolvedValueOnce(res(200, { status: 'refunded' }));
    const out = await processCancellationRefunds('req-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ refunded: 1, failed: 1 });
  });
});

describe('before 0218/0219 are applied (function missing)', () => {
  it('the organizer sees a plain message, never the raw PostgREST error', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.request_event_cancellation(p_event_id, p_reason) in the schema cache' } });
    await expect(requestEventCancellation('e1', 'The venue flooded badly')).rejects.toThrow(CANCELLATION_UNAVAILABLE_MESSAGE);
  });
  it('re-queue sends only the request, the ticket and the note', async () => {
    rpc.mockResolvedValue({ data: { status: 'queued' }, error: null });
    await adminRequeueCancellationRefund('rq1', 't1', '  Paystack balance topped up ');
    expect(rpc).toHaveBeenCalledWith('admin_requeue_event_cancellation_refund', { p_request_id: 'rq1', p_ticket_id: 't1', p_note: 'Paystack balance topped up' });
  });
});

describe('processCancellationRefunds', () => {
  it('sends each claimed ticket through /api/wallet/refund-ticket with only its id and the server reason', async () => {
    rpc.mockImplementation(async (name: string) => name === 'admin_claim_event_cancellation_refunds'
      ? { data: { reason: 'Event cancelled: venue flooded', tickets: [{ ticket_id: 't-wallet', amount_kobo: 999999999 }, { ticket_id: 't-card' }, { ticket_id: 't-bad' }] }, error: null }
      : { data: 'failed', error: null });
    fetchMock
      .mockResolvedValueOnce(res(200, { status: 'refunded' }))                   // wallet / free: done at once
      .mockResolvedValueOnce(res(200, { status: 'refund_pending', refund_id: '9' })) // Paystack: awaiting the webhook
      .mockResolvedValueOnce(res(502, { error: 'Paystack refund initiation failed' }));

    const out = await processCancellationRefunds('req-1', 10);

    expect(out).toEqual({ claimed: 3, refunded: 1, pending: 1, failed: 1, errors: ['Paystack refund initiation failed'] });
    expect(rpc).toHaveBeenCalledWith('admin_claim_event_cancellation_refunds', { p_request_id: 'req-1', p_limit: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.test/api/wallet/refund-ticket');
      expect(init.headers.Authorization).toBe('Bearer admin-jwt');
      const body = JSON.parse(init.body);
      expect(Object.keys(body).sort()).toEqual(['reason', 'ticket_id']);   // never an amount
      expect(body.reason).toBe('Event cancelled: venue flooded');
    }
    // Only the failure is reported; success is never asserted by the client.
    expect(rpc.mock.calls.filter(([n]) => n === 'admin_record_event_cancellation_refund_error')).toEqual([
      ['admin_record_event_cancellation_refund_error', { p_request_id: 'req-1', p_ticket_id: 't-bad', p_error: 'Paystack refund initiation failed' }],
    ]);
    expect(rpc.mock.calls.map(([n]) => n)).not.toContain('finalize_ticket_refund');
  });

  it('a network failure is reported (the server ignores it if the ticket already moved on)', async () => {
    rpc.mockImplementation(async (name: string) => name === 'admin_claim_event_cancellation_refunds'
      ? { data: { reason: 'Event cancelled: x', tickets: [{ ticket_id: 't1' }] }, error: null } : { data: 'unchanged', error: null });
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    const out = await processCancellationRefunds('req-1');
    expect(out.failed).toBe(1);
    expect(rpc).toHaveBeenCalledWith('admin_record_event_cancellation_refund_error', { p_request_id: 'req-1', p_ticket_id: 't1', p_error: 'Failed to fetch' });
  });

  it('nothing to claim: no refund call at all', async () => {
    rpc.mockResolvedValue({ data: { reason: 'x', tickets: [] }, error: null });
    expect(await processCancellationRefunds('req-1')).toEqual({ claimed: 0, refunded: 0, pending: 0, failed: 0, errors: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refused claim (not approved, not an admin) surfaces the server message', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Admin access required' } });
    await expect(processCancellationRefunds('req-1')).rejects.toThrow('Admin access required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('labels', () => {
  it('attendee refund labels follow the ticket first, then the refund row', () => {
    expect(attendeeRefundLabel('queued', 'paid')).toBe('Refund pending');
    expect(attendeeRefundLabel('processing', 'refund_pending')).toBe('Refund processing');
    expect(attendeeRefundLabel('failed', 'paid')).toBe('Refund needs attention · VENTS is on it');
    expect(attendeeRefundLabel('processing', 'refunded')).toBe('Refunded');
    expect(attendeeRefundLabel(undefined, 'paid')).toBe('Refund pending');
  });
  it('every request status has an organizer-facing label', () => {
    expect(Object.keys(CANCELLATION_STATUS_LABEL).sort()).toEqual(['attention', 'completed', 'processing', 'rejected', 'requested']);
  });
});
