import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpc = vi.fn();
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: (...a: any[]) => rpc(...a) } }));
import { OrganizerDeductionNotice, TicketNetEarnings } from './OrganizerDeductionNotice';
import { __clearQuoteCache } from '../../lib/ticketQuote';

// Server quote per ticket price, as public.ticket_fee_quote returns it.
const quote = (price: number) => {
  const face = Math.round(price * 100);
  const ded = Math.round(face * 35 / 1000);
  return { fee_model: 'v3_15_35', quantity: 1, unit_face_kobo: face, face_kobo: face, service_fee_kobo: Math.round(face * 15 / 1000),
    discount_kobo: 0, total_kobo: face + Math.round(face * 15 / 1000), organizer_deduction_kobo: ded, organizer_net_kobo: face - ded,
    vents_revenue_kobo: 0, service_fee_bps: 150, organizer_deduction_bps: 350 };
};

let container: HTMLDivElement; let root: Root;
async function render(el: React.ReactElement) {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(el); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
afterEach(() => { act(() => root.unmount()); container.remove(); rpc.mockReset(); __clearQuoteCache(); });

describe('organizer platform deduction notice (event creation, before publishing)', () => {
  it('states the server deduction rate with the owner-approved example', async () => {
    rpc.mockImplementation(async (_fn: string, a: any) => ({ data: quote(a.p_unit_price), error: null }));
    await render(<OrganizerDeductionNotice />);
    expect(container.textContent).toBe('VENTS deducts a 3.5% platform fee from each ticket you sell. Your earnings automatically reflect this deduction. For example, a ₦10,000 ticket earns you ₦9,650 before any other applicable adjustments. Attendees separately pay a service fee at checkout; it is never taken from your earnings.');
  });
  it('shows the live net per ticket from the server', async () => {
    rpc.mockImplementation(async (_fn: string, a: any) => ({ data: quote(a.p_unit_price), error: null }));
    await render(<TicketNetEarnings price="1001" />);
    expect(container.textContent).toBe('You earn ₦965.96 per ticket (₦1,001 − ₦35.04 organizer platform deduction).');
  });
  it('never invents a rate when the server cannot answer', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    await render(<OrganizerDeductionNotice />);
    expect(container.textContent).not.toMatch(/%/);
  });
  it('free tickets carry no deduction', async () => {
    await render(<TicketNetEarnings price="" />);
    expect(container.textContent).toBe('Free ticket: no platform fee is deducted.');
  });
  it('is placed in the ticket step for every ticket type, and on the review step', () => {
    const src = readFileSync(join(__dirname, 'CreateEventScreen.tsx'), 'utf8');
    expect(src).toMatch(/Ticket Types<\/p>\n\s+<OrganizerDeductionNotice \/>/);
    expect(src).toMatch(/<TicketNetEarnings price=\{ticket\.price\} \/>/);
    expect(src).toMatch(/label: 'Organizer platform deduction', value: deductionRateText/);
    expect(src).not.toMatch(/commission/i);
  });
});
