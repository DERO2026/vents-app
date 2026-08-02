import { REGION } from '../../lib/regionConfig';

export function formatPrice(amount: number | null | undefined): string {
  if (!amount) return 'Free';
  return `${REGION.currencySymbol}${amount.toLocaleString?.() || amount}`;
}

// Summarises a whole event's price at a glance from its ticket types —
// used on browse cards (Explore/Home/Saved), never on a single-ticket
// checkout/purchase context where the exact selected price is already known.
export function formatPriceRange(ticketTypes: Array<{ price: number }> | null | undefined): string {
  const prices = (ticketTypes || []).map((t) => Number(t.price) || 0);
  if (prices.length === 0) return 'Free';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (max === 0) return 'Free';
  if (min === 0) return `Free–${formatPrice(max)}`;
  if (min === max) return `From ${formatPrice(min)}`;
  return `${formatPrice(min)}–${formatPrice(max)}`;
}

// The action-oriented label shown on home/explore cards — a CTA, not a
// price readout (formatPriceRange above is still used wherever a plain
// price display is wanted, e.g. SavedScreen, related events). Always
// derived from the event's actual ticket types, never a stale single price.
export function formatCardCTA(ticketTypes: Array<{ price: number }> | null | undefined): string {
  const prices = (ticketTypes || []).map((t) => Number(t.price) || 0);
  if (prices.length === 0 || prices.every((p) => p === 0)) return 'Book Free';
  const paidPrices = prices.filter((p) => p > 0);
  const minPaid = Math.min(...paidPrices);
  const maxPaid = Math.max(...paidPrices);
  return minPaid === maxPaid ? 'Buy' : `Buy from ${formatPrice(minPaid)}`;
}

// A single date for a one-day event, or "Aug 9 – Aug 11, 2026" once
// endDate is set and actually lands on a different calendar day than the
// start (a same-day endDate — an event ending after midnight the way
// end_time already handles — isn't a multi-day event for display purposes).
export function formatEventDateRange(startISO: string | null | undefined, endISO?: string | null): string {
  if (!startISO) return '';
  const start = new Date(startISO);
  if (isNaN(start.getTime())) return '';
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!endISO) return startLabel;
  const end = new Date(endISO);
  if (isNaN(end.getTime())) return startLabel;
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return startLabel;
  const sameMonthYear = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const endLabel = sameMonthYear
    ? end.toLocaleDateString('en-US', { day: 'numeric', year: 'numeric' })
    : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const startShort = sameMonthYear
    ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : startLabel;
  return `${startShort} – ${endLabel}`;
}
