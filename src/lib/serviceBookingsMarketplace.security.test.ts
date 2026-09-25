import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for the Services booking/payment marketplace migration
// (0054_service_bookings_marketplace.sql).

let m0054: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0054 = readFileSync(join(dir, '0054_service_bookings_marketplace.sql'), 'utf8');
});

describe('Multi-category providers: additive, primary column untouched', () => {
  it('backfills every existing provider into the new join table from their current single category', () => {
    expect(m0054).toMatch(/INSERT INTO public\.service_provider_categories \(provider_id, category\)\s*\nSELECT id, category FROM public\.service_providers/);
  });

  it('set_service_provider_categories keeps service_providers.category in sync as categories[1] and enforces ownership + a 1-5 count', () => {
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.set_service_provider_categories[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/u\.is_service_provider = true/);
    expect(fn).toMatch(/UPDATE public\.service_providers SET category = v_clean\[1\]/);
    expect(fn).toMatch(/array_length\(v_clean, 1\) > 5/);
  });

  it('has no direct insert/update/delete RLS policy for a plain authenticated caller -- writes only via the RPC', () => {
    expect(m0054).not.toMatch(/CREATE POLICY service_provider_categories_insert_own/);
    expect(m0054).not.toMatch(/CREATE POLICY service_provider_categories_update_own/);
  });
});

describe('Configurable VENTS Services fee', () => {
  it('defaults to 5% and is admin-changeable only via a Super-Admin-gated, audit-logged RPC', () => {
    expect(m0054).toMatch(/'service_booking_fee_percent', '5'/);
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.admin_set_service_booking_fee_percent[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
  });
});

describe('create_service_booking: server-computed order, nothing trusted from the client', () => {
  it('re-derives price/currency from provider_services for every line item, never accepting a client-supplied price', () => {
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.create_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/SELECT ps\.name, ps\.price, ps\.currency INTO v_name, v_price, v_svc_currency/);
    expect(fn).not.toMatch(/p_items->>'price'/);
  });

  it('refuses to create a payable booking for any currency other than NGN (this pass\'s explicit scope)', () => {
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.create_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/v_currency IS DISTINCT FROM 'NGN'/);
  });

  it('a provider cannot book their own services', () => {
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.create_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/You cannot book your own services/);
  });

  it('fee is computed server-side from the configurable percent, subtotal + fee = total, matching the buyer-pays-on-top ticket model', () => {
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.create_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/v_fee_percent := public\.get_service_booking_fee_percent\(\);/);
    expect(fn).toMatch(/v_total_kobo := v_subtotal_kobo \+ v_fee_kobo;/);
  });
});

describe('confirm_service_booking_payment: authoritative pending->paid transition', () => {
  it('is project_admin-only, never reachable from the public Supabase client', () => {
    expect(m0054).toMatch(/REVOKE ALL ON FUNCTION public\.confirm_service_booking_payment\(text, bigint\) FROM PUBLIC, anon, authenticated, project_admin;\nGRANT EXECUTE ON FUNCTION public\.confirm_service_booking_payment\(text, bigint\) TO project_admin;/);
  });

  it('validates the paid amount against the booking\'s own server-computed total, never a client-supplied one', () => {
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.confirm_service_booking_payment[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF p_amount_kobo < v_booking\.total_kobo THEN/);
  });

  it('is idempotent -- short-circuits on an already-paid booking', () => {
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.confirm_service_booking_payment[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_booking\.payment_status = 'paid' THEN\s*\n\s*RETURN 'already_paid';/);
  });

  it('credits the provider 100% of the subtotal (not the fee-inclusive total) -- fee is VENTS revenue, never double-charged or deducted from the provider', () => {
    const fn = m0054.match(/CREATE OR REPLACE FUNCTION public\.confirm_service_booking_payment[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/credit_provider_wallet_for_booking\(v_provider_user_id, v_booking\.subtotal_kobo,/);
  });
});

describe('service_bookings / service_booking_items RLS: no direct client write path', () => {
  it('customers and providers can only SELECT their own bookings -- every write goes through a SECURITY DEFINER RPC', () => {
    expect(m0054).not.toMatch(/CREATE POLICY service_bookings_insert/);
    expect(m0054).toMatch(/CREATE POLICY service_bookings_select_own_customer/);
    expect(m0054).toMatch(/CREATE POLICY service_bookings_select_own_provider/);
  });
});

describe('provider_reviews: gated on a real, paid VENTS booking', () => {
  it('insert requires the reviewer to own a PAID booking with that exact provider', () => {
    const policy = m0054.match(/CREATE POLICY provider_reviews_insert_own ON public\.provider_reviews[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toMatch(/b\.customer_id = \(SELECT auth\.uid\(\)\)/);
    expect(policy).toMatch(/b\.provider_id = provider_reviews\.provider_id/);
    expect(policy).toMatch(/b\.payment_status = 'paid'/);
  });

  it('one review per booking (not per provider), so a customer with multiple bookings can review each', () => {
    expect(m0054).toMatch(/CONSTRAINT provider_reviews_booking_unique UNIQUE \(booking_id\)/);
  });
});
