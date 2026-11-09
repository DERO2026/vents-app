import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// The refund screen shows what THIS ticket's attendee paid, per the fee model
// it was bought under -- never a hard-coded 5% for every ticket.
let ticketRow: any; let feeModelResult: any;
const rpc = vi.fn(async (_fn: string, a: any) => {
  const face = Math.round(a.p_unit_price * 100); const fee = Math.round(face * 15 / 1000); const disc = Math.round(face * (a.p_discount_pct || 0) / 100);
  return { data: { fee_model: 'v3_15_35', quantity: 1, unit_face_kobo: face, face_kobo: face, service_fee_kobo: fee, discount_kobo: disc,
    total_kobo: face + fee - disc, organizer_deduction_kobo: 0, organizer_net_kobo: 0, vents_revenue_kobo: 0, service_fee_bps: 150, organizer_deduction_bps: 350 }, error: null };
});
vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, a: any) => rpc(fn, a),
    from: () => ({
      select: (cols: string) => ({ eq: () => ({ maybeSingle: async () => (cols === 'fee_model' ? feeModelResult : { data: ticketRow, error: null }) }) }),
    }),
  },
}));
import { TicketRefundScreen } from './TicketRefundScreen';
import { __clearQuoteCache } from '../../lib/ticketQuote';

let container: HTMLDivElement; let root: Root;
async function render() {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<TicketRefundScreen ticketId="t1" onBack={() => {}} onViewWallet={() => {}} />); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
afterEach(() => { act(() => root.unmount()); container.remove(); __clearQuoteCache(); rpc.mockClear(); });
const base = { id: 't1', ticket_type: 'Guys', quantity: 1, payment_status: 'refunded', payment_method: 'wallet', refund_reason: null, checked_in: false, events: { title: 'Night', event_date: null, location: 'Lagos' } };

describe('ticket refund screen fee', () => {
  it('a 1.5% ticket (v3_15_35): N20,000 refunds N20,300 with a N300 attendee service fee', async () => {
    ticketRow = { ...base, amount: 20000, discount_percentage: 0 }; feeModelResult = { data: { fee_model: 'v3_15_35' }, error: null };
    await render();
    expect(q('refund-fee')).toBe('₦300');
    expect(q('refund-total')).toBe('₦20,300');
    expect(container.textContent).toMatch(/Attendee service fee \(1\.5%\)/);
  });
  it('a 1.5% ticket with a 10% promo: fee on the full face, attendee paid N18,300', async () => {
    ticketRow = { ...base, amount: 20000, discount_percentage: 10 }; feeModelResult = { data: { fee_model: 'v3_15_35' }, error: null };
    await render();
    expect(q('refund-total')).toBe('₦18,300');
  });
  it('a legacy ticket keeps its original 5% formula', async () => {
    ticketRow = { ...base, amount: 20000, discount_percentage: 0 }; feeModelResult = { data: { fee_model: 'legacy_5' }, error: null };
    await render();
    expect(q('refund-fee')).toBe('₦1,000');
    expect(q('refund-total')).toBe('₦21,000');
  });
  it('before 0203 (no fee_model column) every ticket is legacy', async () => {
    ticketRow = { ...base, amount: 10000, discount_percentage: 0 }; feeModelResult = { data: null, error: { message: 'column tickets.fee_model does not exist' } };
    await render();
    expect(q('refund-total')).toBe('₦10,500');
  });
  it('an unknown model shows no invented amount', async () => {
    ticketRow = { ...base, amount: 10000, discount_percentage: 0 }; feeModelResult = { data: null, error: { message: 'network' } };
    await render();
    expect(q('refund-total')).toBe('—');
  });
});
