// Ticket fees: the app DISPLAYS what the database calculates. There is no fee
// percentage in the app code. Every amount on checkout, ticket selection, the
// event page and Create Event's "you earn" comes from public.ticket_fee_quote
// (migration 0208), which uses the same functions that charge (create_pending_
// purchase), settle (confirm_ticket_payment*), refund and report. Checkout
// additionally refuses to start a payment whose server amount differs from
// the quote it showed (amountMatchesQuote).
import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

export interface TicketQuote {
  fee_model: string;
  quantity: number;
  unit_face_kobo: number;
  face_kobo: number;
  service_fee_kobo: number;
  discount_kobo: number;
  total_kobo: number;
  organizer_commission_kobo: number;
  organizer_net_kobo: number;
  vents_revenue_kobo: number;
  service_fee_bps: number;
  organizer_commission_bps: number;
}

export type QuoteState =
  | { status: 'loading'; quote: null }
  | { status: 'ready'; quote: TicketQuote }
  // The server has no quote function (before 0208) or could not answer:
  // nothing is shown as a price and nothing can be paid.
  | { status: 'unavailable'; quote: null };

const cache = new Map<string, TicketQuote>();
const keyOf = (price: number, qty: number, discount: number) => `${price}|${qty}|${discount}`;

export async function fetchTicketQuote(unitPrice: number, quantity: number, discountPct = 0): Promise<TicketQuote | null> {
  const price = Math.max(0, Number(unitPrice) || 0);
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const discount = Math.min(100, Math.max(0, Number(discountPct) || 0));
  const key = keyOf(price, qty, discount);
  const hit = cache.get(key);
  if (hit) return hit;
  const { data, error } = await Promise.resolve(
    supabase.rpc('ticket_fee_quote' as any, { p_unit_price: price, p_quantity: qty, p_discount_pct: discount }),
  ).then((v: any) => v, (err) => ({ data: null, error: err }));
  if (error || !data || typeof (data as any).total_kobo !== 'number') return null;
  cache.set(key, data as TicketQuote);
  return data as TicketQuote;
}

/** Quote for `quantity` tickets at `unitPrice`; quantity 0 means nothing selected. */
export function useTicketQuote(unitPrice: number | null | undefined, quantity: number, discountPct = 0): QuoteState {
  const [state, setState] = useState<QuoteState>({ status: 'loading', quote: null });
  const seq = useRef(0);
  useEffect(() => {
    if (unitPrice == null || !(quantity > 0)) { setState({ status: 'loading', quote: null }); return; }
    const mine = ++seq.current;
    const cached = cache.get(keyOf(Math.max(0, Number(unitPrice) || 0), Math.floor(quantity), Math.min(100, Math.max(0, discountPct || 0))));
    setState(cached ? { status: 'ready', quote: cached } : { status: 'loading', quote: null });
    if (cached) return;
    fetchTicketQuote(unitPrice, quantity, discountPct).then((q) => {
      if (mine !== seq.current) return;
      setState(q ? { status: 'ready', quote: q } : { status: 'unavailable', quote: null });
    });
  }, [unitPrice, quantity, discountPct]);
  return state;
}

/** The service-fee label, from the server's own rate (basis points). */
export function serviceFeeLabel(q: TicketQuote): string {
  return `Service fee (${formatBps(q.service_fee_bps)})`;
}
export function commissionLabel(q: TicketQuote): string {
  return `VENTS commission (${formatBps(q.organizer_commission_bps)})`;
}
export function formatBps(bps: number): string {
  return `${(bps / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}%`;
}

/** Checkout's guard: the amount the server will charge must equal the quote the buyer saw. */
export function amountMatchesQuote(serverAmountKobo: number, q: TicketQuote | null): boolean {
  return !!q && Number.isFinite(serverAmountKobo) && serverAmountKobo === q.total_kobo;
}

export const QUOTE_UNAVAILABLE_MESSAGE = 'Ticket prices could not be loaded right now. Please try again shortly.';
export const PRICE_CHANGED_MESSAGE = 'The price of this order changed before payment, so nothing was charged. Please review the new total and try again.';

/** For tests only. */
export function __clearQuoteCache(): void { cache.clear(); }
