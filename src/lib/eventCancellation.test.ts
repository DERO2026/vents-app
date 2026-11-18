import { describe, it, expect, vi, beforeEach } from 'vitest';

// The admin "Process refunds" run (0218). Each claimed ticket goes through
// the EXISTING refund API with only its id and the server's reason: no
// amount ever leaves the client, and nothing is marked refunded here. A
// failure is reported to the server; the ticket's own state decides the rest.
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { rpc }, getAuthToken: async () => 'admin-jwt' }));
vi.mock('./apiBase', () => ({ apiUrl: (p: string) => `https://api.test${p}` }));

import { processCancellationRefunds, attendeeRefundLabel, CANCELLATION_STATUS_LABEL } from './eventCancellation';

const fetchMock = vi.fn();
beforeEach(() => {
  rpc.mockReset(); fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
const res = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

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
