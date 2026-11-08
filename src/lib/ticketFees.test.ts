import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatKobo } from './ticketFees';

// One authoritative fee calculation: the database (ticket_fee_quote and the
// helpers it shares with create_pending_purchase, confirm_ticket_payment*,
// refunds and analytics, migration 0208). The app must not define or restate
// a ticket fee rate anywhere -- it displays the server's quote.
const SRC = join(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('no ticket fee rate lives in the app', () => {
  it('no source file hard-codes the attendee fee or organizer commission', () => {
    const offenders = files(SRC).filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /TICKET_SERVICE_FEE_RATE|TICKET_ORGANIZER_COMMISSION_FRACTION|TICKET_BUYER_MULTIPLIER|ticketCheckoutKobo|computeTicketWalletChargeKobo/.test(s)
        || /\b(0\.015|0\.035|1\.015)\b/.test(s)
        || /Service fee \(\d|VENTS commission \(\d|charges a \d+(\.\d+)?% commission/.test(s);
    });
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});

describe('formatKobo', () => {
  it('formats exact amounts, kobo only when present', () => {
    expect(formatKobo(1_015_000)).toBe('₦10,150');
    expect(formatKobo(101_602)).toBe('₦1,016.02');
    expect(formatKobo(0)).toBe('₦0');
  });
});
