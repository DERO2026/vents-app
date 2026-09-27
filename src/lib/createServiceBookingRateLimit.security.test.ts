import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0112_add_create_service_booking_rate_limit.sql.
//
// Master security audit (booking-abuse cap, noted alongside M1/M4):
// create_service_booking() had no check_rate_limit() call. It never moves
// money itself (server-computed pricing, no payment until a separate
// confirm step), so this was correctly assessed as a DB-clutter/mild-
// abuse risk (spamming pending_payment rows against a provider) rather
// than a user-harm one. Fix adds the same PERFORM public.check_rate_
// limit(...) pattern used throughout this audit, keyed per-caller,
// 20/hour, right after the auth check and before any provider/items
// validation.
//
// Behavioral proof was run live, in an isolated rolled-back transaction
// with a real provider/service fixture, against project
// slrtjxtzhowhwhebjprv: a real customer creating 25 bookings in sequence
// succeeds through the 20th and is rejected with SQLSTATE P0429
// ('rate_limited') starting exactly at the 21st. A single legitimate
// booking call was also confirmed to still return a real booking_id/
// payment_ref/pricing row unchanged.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0112_add_create_service_booking_rate_limit.sql'), 'utf8');
});

function body(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.create_service_booking\([\s\S]*?\$function\$;/)?.[0] ?? '';
}

describe('Adds a rate limit to create_service_booking()', () => {
  it('redefines create_service_booking (not a new function)', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.create_service_booking\(/);
  });

  it('calls check_rate_limit keyed per-caller, after auth and before items/provider validation', () => {
    const fn = body();
    const authIdx = fn.indexOf("RAISE EXCEPTION 'Not authenticated';");
    const rlIdx = fn.indexOf("PERFORM public.check_rate_limit('create_service_booking:' || v_customer::text, 20, 3600);");
    const itemsIdx = fn.indexOf("RAISE EXCEPTION 'No services selected';");
    expect(authIdx).toBeGreaterThan(-1);
    expect(rlIdx).toBeGreaterThan(authIdx);
    expect(itemsIdx).toBeGreaterThan(rlIdx);
  });

  it('leaves pricing, currency validation, and the own-services guard unchanged', () => {
    const fn = body();
    expect(fn).toMatch(/You cannot book your own services/);
    expect(fn).toMatch(/All selected services in one booking must use the same currency/);
    expect(fn).toMatch(/Online booking is currently only available for services priced in NGN/);
    expect(fn).toMatch(/v_fee_percent := public\.get_service_booking_fee_percent\(\);/);
  });
});
