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
