// Ticket selection on the event page: which category is selected, how many,
// and whether that selection can be bought. One ticket category per order
// (create_pending_purchase takes a single ticket type); mixed-category carts
// are not supported at launch. Prices and fees are NOT computed here -- the
// amount payable always comes from the server quote (ticketQuote.ts).

export interface SelectableTicket {
  id: string;
  name: string;
  price: number;
  /** Tickets left; null/undefined means no limit is published. */
  available?: number | null;
}

/** Cap used only when a category publishes no remaining count (unchanged behaviour). */
export const DEFAULT_MAX_WHEN_UNLIMITED = 10;

export function isTicketAvailable(t: SelectableTicket | null | undefined): boolean {
  if (!t) return false;
  return t.available == null || t.available > 0;
}

/** Most tickets of this category one order can take: what is left, or 10 when no count is published. */
export function maxQuantity(t: SelectableTicket | null | undefined): number {
  if (!isTicketAvailable(t)) return 0;
  return t!.available == null ? DEFAULT_MAX_WHEN_UNLIMITED : t!.available;
}

/** The first category that can actually be bought, or '' when none can. */
export function firstAvailableTicketId(tickets: SelectableTicket[]): string {
  return tickets.find(isTicketAvailable)?.id ?? '';
}

/** Quantity 1 for the pre-selected available category, 0 for every other (sold-out ones included). */
export function initialTicketQuantities(tickets: SelectableTicket[]): Record<string, number> {
  const first = firstAvailableTicketId(tickets);
  return Object.fromEntries(tickets.map((t) => [t.id, t.id === first ? 1 : 0]));
}

/** Clamp a quantity change to 0..maxQuantity for that category. */
export function nextQuantity(t: SelectableTicket | null | undefined, current: number, delta: number): number {
  return Math.max(0, Math.min(maxQuantity(t), (current || 0) + delta));
}

export type SelectionProblem = 'none_selected' | 'sold_out' | 'zero_quantity' | 'too_many' | null;

/** Why this selection cannot be bought (null = it can). */
export function selectionProblem(t: SelectableTicket | null | undefined, qty: number): SelectionProblem {
  if (!t) return 'none_selected';
  if (!isTicketAvailable(t)) return 'sold_out';
  if (!(qty > 0)) return 'zero_quantity';
  if (qty > maxQuantity(t)) return 'too_many';
  return null;
}

/** "Guys × 1" -- the selected category and quantity, never the cheapest price. */
export function selectionLabel(t: SelectableTicket | null | undefined, qty: number): string {
  if (!t) return 'Select a ticket';
  return `${t.name} × ${Math.max(0, qty || 0)}`;
}

export function isFreeSelection(t: SelectableTicket | null | undefined, qty: number): boolean {
  return !!t && Number(t.price) === 0 && qty > 0;
}

export const ONE_CATEGORY_PER_ORDER_NOTE = 'One ticket category per order. To buy another category, place a separate order.';
