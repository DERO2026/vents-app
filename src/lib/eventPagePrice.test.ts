import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketCheckoutKobo, formatKobo } from './ticketFees';

// The event page's "Pay ₦X" button and total must equal what checkout charges
// (fee included), never the bare ticket price (it used to say ₦15,000 for a
// ₦15,000 ticket while checkout charged more).
const src = readFileSync(join(__dirname, '..', 'app', 'components', 'EventDetailsScreen.tsx'), 'utf8');

describe('event page price = checkout charge', () => {
  it('uses the shared per-ticket checkout arithmetic for the button and the total', () => {
    expect(src).toMatch(/const eventCheckout = ticketCheckoutKobo\(selectedTicket\?\.price \?\? 0, selectedQty\);/);
    expect(src.match(/`Pay \$\{formatKobo\(eventCheckout\.totalKobo\)\}`/g)?.length).toBe(2);
    expect(src).not.toMatch(/`Pay \$\{formatPrice\(selectedTicket!\.price \* selectedQty\)\}`/);
  });
  it('a ₦15,000 ticket shows Pay ₦15,225; three show ₦45,675', () => {
    expect(formatKobo(ticketCheckoutKobo(15000, 1).totalKobo)).toBe('₦15,225');
    expect(formatKobo(ticketCheckoutKobo(15000, 3).totalKobo)).toBe('₦45,675');
  });
});
