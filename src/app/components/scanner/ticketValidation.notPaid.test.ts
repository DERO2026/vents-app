import { describe, it, expect, vi, beforeEach } from 'vitest';

// Migration 0220 (unpaid tickets usable for entry, P0): verify_entry_pass and
// manual_check_in refuse a ticket whose payment is not confirmed with reason
// 'not_paid'. The door must see an unmistakable NOT PAID, never a green
// check-in, and never the generic "ENTRY DENIED" that reads like a scanner
// fault. The database enforcement itself is proven by
// scripts/local-pg-test/run-ticket-integrity-verification.sh (+ mutation test).

const rpcMock = vi.fn();
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc: (...args: any[]) => rpcMock(...args) } }));
vi.mock('../../../lib/ticketCode', () => ({ parseTicketDisplayCode: (code: string) => (code === 'VALID-CODE' ? 'ticket-uuid-1' : null) }));

import { validateTicket, validateManualCode } from './ticketValidation';

const NOT_PAID = { ok: false, reason: 'not_paid', message: 'This ticket has no confirmed payment (pending); it cannot be used for entry.' };

beforeEach(() => rpcMock.mockReset());

describe('scanner: unpaid tickets (0220)', () => {
  it('QR scan of an unpaid ticket: denied, headline NOT PAID, "Do not admit"', async () => {
    rpcMock.mockResolvedValue({ data: NOT_PAID, error: null });
    const out = await validateTicket('signed-qr-token', 'staff-1', 'Afrobeats Live');
    expect(out.status).toBe('denied');
    expect(out.headline).toBe('NOT PAID');
    expect(out.errorMsg).toMatch(/no confirmed payment.*Do not admit/);
    expect(rpcMock).toHaveBeenCalledTimes(1);   // a denial is never retried
  });

  it('manual code of an unpaid ticket: the same NOT PAID denial', async () => {
    rpcMock.mockResolvedValue({ data: NOT_PAID, error: null });
    const out = await validateManualCode('VALID-CODE', 'staff-1');
    expect(out.status).toBe('denied');
    expect(out.headline).toBe('NOT PAID');
  });

  it('a paid ticket still checks in', async () => {
    rpcMock.mockResolvedValue({ data: { ok: true, holder_name: 'Ada', ticket_type: 'Regular', checked_in_at: new Date().toISOString() }, error: null });
    const out = await validateTicket('signed-qr-token', 'staff-1');
    expect(out.status).toBe('valid');
  });
});
