import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpc = vi.fn();
vi.mock('./supabase', () => ({ supabase: { rpc: (...a: any[]) => rpc(...a) } }));
import { fetchTicketQuote, amountMatchesQuote, serviceFeeLabel, organizerDeductionLabel, __clearQuoteCache, type TicketQuote } from './ticketQuote';

// Shape returned by public.ticket_fee_quote (run-fee-model-0208-verification.sh
// checks these exact numbers against the real function).
const Q: TicketQuote = {
  fee_model: 'v3_15_35', quantity: 1, unit_face_kobo: 1_000_000, face_kobo: 1_000_000, service_fee_kobo: 15_000,
  discount_kobo: 0, total_kobo: 1_015_000, organizer_deduction_kobo: 35_000, organizer_net_kobo: 965_000,
  vents_revenue_kobo: 50_000, service_fee_bps: 150, organizer_deduction_bps: 350,
};

beforeEach(() => { rpc.mockReset(); __clearQuoteCache(); });

describe('ticket fee quote (the server is the only calculator)', () => {
  it('asks the database and returns its numbers unchanged', async () => {
    rpc.mockResolvedValue({ data: Q, error: null });
    expect(await fetchTicketQuote(10000, 1)).toEqual(Q);
    expect(rpc).toHaveBeenCalledWith('ticket_fee_quote', { p_unit_price: 10000, p_quantity: 1, p_discount_pct: 0 });
  });
  it('labels come from the server rates', () => {
    expect(serviceFeeLabel(Q)).toBe('Attendee service fee (1.5%)');
    expect(organizerDeductionLabel(Q)).toBe('Organizer platform deduction (3.5%)');
  });
  it('a server without the quote (before 0208) yields no price at all', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    expect(await fetchTicketQuote(10000, 1)).toBeNull();
  });
  it('payment is allowed only when the server amount equals the quote shown', () => {
    expect(amountMatchesQuote(1_015_000, Q)).toBe(true);
    expect(amountMatchesQuote(1_050_000, Q)).toBe(false); // the 22:34 incident: shown 1.5%, charged 5%
    expect(amountMatchesQuote(1_015_000, null)).toBe(false);
  });
  it('checkout checks both server amounts before any charge, and cannot pay without a quote', () => {
    const src = readFileSync(join(__dirname, '..', 'app', 'components', 'CheckoutScreen.tsx'), 'utf8');
    expect(src.match(/amountMatchesQuote\((amountKobo|chargeAmountKobo), quote\)/g)?.length).toBe(2);
    expect(src).toMatch(/const disabled = paymentLoading \|\| !quoteReady;/);
    expect(src).toMatch(/useTicketQuote\(isFreeOrder \? null : ticketType\.price, quantity, promoApplied \? promoDiscountPct : 0\)/);
  });
});
