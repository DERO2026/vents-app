import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TICKET_SERVICE_FEE_RATE, TICKET_ORGANIZER_COMMISSION_FRACTION, TICKET_SERVICE_FEE_LABEL,
  ticketServiceFeeKobo, organizerCommissionKobo, organizerNetKobo, ticketCheckoutKobo, formatKobo,
} from './ticketFees';

const migration = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0208_ticket_fee_1_5_3_5.sql'), 'utf8');

describe('ticket pricing (owner 2026-11-08: 1.5% attendee fee + 3.5% organizer commission)', () => {
  it('attendee pays face + 1.5%, organizer receives face - 3.5%, VENTS keeps 5% and nothing else', () => {
    const b = ticketCheckoutKobo(10_000, 2);
    expect(b).toEqual({ faceKobo: 2_000_000, serviceFeeKobo: 30_000, discountKobo: 0, totalKobo: 2_030_000 });
    const net = 2 * organizerNetKobo(1_000_000);
    expect(net).toBe(1_930_000);
    expect(b.totalKobo - net).toBe(b.serviceFeeKobo + 2 * organizerCommissionKobo(1_000_000));
    expect(b.totalKobo - net).toBe(100_000); // 5% of 2,000,000
  });

  it('the example given to organizers: a NGN 10,000 ticket earns NGN 9,650', () => {
    expect(organizerNetKobo(1_000_000)).toBe(965_000);
  });

  it('rounds per ticket half-up like the SQL, then multiplies by the quantity', () => {
    expect(ticketServiceFeeKobo(100_100)).toBe(1502);      // 1501.5 -> 1502
    expect(organizerCommissionKobo(100_100)).toBe(3504);   // 3503.5 -> 3504
    expect(ticketCheckoutKobo(1001, 3).totalKobo).toBe(304_806);
    for (let q = 1; q <= 10; q++) expect(ticketCheckoutKobo(1001, q).totalKobo).toBe(q * 101_602);
  });

  it('matches the database constants in 0208', () => {
    expect(TICKET_SERVICE_FEE_RATE).toBe(0.015);
    expect(TICKET_ORGANIZER_COMMISSION_FRACTION).toBe(0.035);
    expect(TICKET_SERVICE_FEE_LABEL).toBe('Service fee (1.5%)');
    expect(migration).toMatch(/round\(v_face_kobo \* 15 \/ 1000\.0\)::bigint/);
    expect(migration).toMatch(/RETURN round\(GREATEST\(COALESCE\(p_face_kobo, 0\), 0\) \* 35 \/ 1000\.0\)::bigint;/);
  });

  it('formats exact amounts, kobo only when present', () => {
    expect(formatKobo(1_015_000)).toBe('₦10,150');
    expect(formatKobo(101_602)).toBe('₦1,016.02');
    expect(formatKobo(0)).toBe('₦0');
  });
});
