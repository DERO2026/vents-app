import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The event page's "Pay ₦X" and total are the database's quote (fee included),
// never the bare ticket price and never a client-side rate.
const src = readFileSync(join(__dirname, '..', 'app', 'components', 'EventDetailsScreen.tsx'), 'utf8');
const sel = readFileSync(join(__dirname, '..', 'app', 'components', 'TicketSelectScreen.tsx'), 'utf8');

describe('event page and ticket selection show the server quote', () => {
  it('event page', () => {
    expect(src).toMatch(/useTicketQuote\(selectedTicket && Number\(selectedTicket\.price\) > 0 \? selectedTicket\.price : null, selectedQty\)/);
    // One label function feeds both the bottom bar and the desktop panel.
    expect(src.match(/`Pay \$\{eventPayText\}`/g)?.length).toBe(1);
    expect(src.match(/\{payButtonText\(purchasesDisabled\)\}/g)?.length).toBe(2);
    // The bottom bar shows the selected category, never the cheapest "Buy from ₦X".
    expect(src).not.toMatch(/formatCardCTA/);
    expect(src).toMatch(/data-testid="event-bottom-selection"[^>]*>\s*\{orderLabel\}/);
  });
  it('ticket selection', () => {
    expect(sel).toMatch(/useTicketQuote\(selected && Number\(selected\.price\) > 0 \? selected\.price : null, qty\)/);
  });
});
