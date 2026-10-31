import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TICKET_BUYER_MULTIPLIER, ticketServiceFee, organizerCommissionKobo, organizerNetKobo,
} from './ticketFees';
import { computeTicketWalletChargeKobo } from './walletMath';

const migration = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0203_earnings_policies.sql'), 'utf8');

describe('ticket pricing (approved: 4% attendee fee + 5% organizer commission)', () => {
  it('buyer pays face + 4%, organizer receives face - 5%, VENTS keeps both and nothing else', () => {
    const faceKobo = 2_000_000; // 2 x NGN 10,000
    const buyerPays = computeTicketWalletChargeKobo(faceKobo / 100);
    expect(buyerPays).toBe(2_080_000);
    expect(organizerNetKobo(faceKobo)).toBe(1_900_000);
    expect(buyerPays - organizerNetKobo(faceKobo)).toBe(ticketServiceFee(faceKobo) + organizerCommissionKobo(faceKobo));
  });

  it('rounds the commission like ticket_fee_commission_kobo (half up, per order)', () => {
    expect(organizerCommissionKobo(10)).toBe(1);   // 0.5 -> 1
    expect(organizerCommissionKobo(9)).toBe(0);    // 0.45 -> 0
    expect(organizerCommissionKobo(0)).toBe(0);
  });

  it('matches the database constants in 0203', () => {
    expect(TICKET_BUYER_MULTIPLIER).toBe(1.04);
    expect(migration).toMatch(/WHEN 'v2_4_5' THEN 1\.04 WHEN 'legacy_5' THEN 1\.05/);
    expect(migration).toMatch(/RETURN round\(GREATEST\(COALESCE\(p_face_kobo, 0\), 0\) \* 5 \/ 100\.0\)::bigint;/);
  });

  it('keeps legacy tickets on the legacy arithmetic (no silent change to history)', () => {
    expect(migration).toMatch(/ALTER TABLE public\.tickets ADD COLUMN IF NOT EXISTS fee_model text NOT NULL DEFAULT 'legacy_5';/);
    expect(migration).toMatch(/ELSIF p_fee_model = 'legacy_5' THEN\s+RETURN 0;/);
  });
});
