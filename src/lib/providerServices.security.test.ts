import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo -- no live Postgres/RLS harness available) for the provider
// service catalog (0048_provider_services.sql, Services Stage 2).

let m0048: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0048 = readFileSync(join(migrationsDir, '0048_provider_services.sql'), 'utf8');
});

describe('provider_services (0048): public read is active-only, approved-listing-only', () => {
  it('the public select policy requires is_active AND an approved listing', () => {
    const policy = m0048.match(/CREATE POLICY provider_services_public_select ON public\.provider_services[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toMatch(/TO anon, authenticated/);
    expect(policy).toMatch(/is_active = true/);
    expect(policy).toMatch(/sp\.status = 'approved'/);
  });
});

describe('provider_services (0048): ownership -- a provider can only manage their own services', () => {
  it('insert requires the caller to own the target listing AND hold the capability', () => {
    const policy = m0048.match(/CREATE POLICY provider_services_insert_own ON public\.provider_services[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toMatch(/sp\.user_id = \(SELECT auth\.uid\(\)\)/);
    expect(policy).toMatch(/u\.is_service_provider = true/);
  });

  it('update requires the same ownership + capability check on both USING and WITH CHECK', () => {
    const policy = m0048.match(/CREATE POLICY provider_services_update_own ON public\.provider_services[\s\S]*?;/)?.[0] ?? '';
    const usingClause = policy.split('WITH CHECK')[0];
    const checkClause = policy.split('WITH CHECK')[1] ?? '';
    expect(usingClause).toMatch(/sp\.user_id = \(SELECT auth\.uid\(\)\)/);
    expect(checkClause).toMatch(/sp\.user_id = \(SELECT auth\.uid\(\)\)/);
  });

  it('delete requires the caller to own the target listing', () => {
    const policy = m0048.match(/CREATE POLICY provider_services_delete_own ON public\.provider_services[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toMatch(/sp\.user_id = \(SELECT auth\.uid\(\)\)/);
  });

  it('a provider whose capability is revoked loses write access to services too (not just the listing)', () => {
    // Same is_service_provider gate as service_providers_insert_own/
    // update_own (0034) -- provider_services must not be a looser path
    // around that revocation.
    const insertPolicy = m0048.match(/CREATE POLICY provider_services_insert_own[\s\S]*?;/)?.[0] ?? '';
    const updatePolicy = m0048.match(/CREATE POLICY provider_services_update_own[\s\S]*?;/)?.[0] ?? '';
    expect(insertPolicy).toMatch(/is_service_provider = true/);
    expect(updatePolicy).toMatch(/is_service_provider = true/);
  });
});

describe('provider_services (0048): Admin/Sub-Admin bypass, scoped correctly', () => {
  it('admin insert/update/delete policies gate on is_admin(), not a specific provider', () => {
    expect(m0048).toMatch(/CREATE POLICY provider_services_admin_insert ON public\.provider_services\s*\n\s*FOR INSERT\s*\n\s*TO authenticated\s*\n\s*WITH CHECK \(is_admin\(\)\);/);
    expect(m0048).toMatch(/CREATE POLICY provider_services_admin_update ON public\.provider_services\s*\n\s*FOR UPDATE\s*\n\s*TO authenticated\s*\n\s*USING \(is_admin\(\)\);/);
    expect(m0048).toMatch(/CREATE POLICY provider_services_admin_delete ON public\.provider_services\s*\n\s*FOR DELETE\s*\n\s*TO authenticated\s*\n\s*USING \(is_admin\(\)\);/);
  });
});

describe('provider_services (0048): data integrity guards', () => {
  it('price cannot be negative', () => {
    expect(m0048).toMatch(/CONSTRAINT provider_services_price_check CHECK \(price >= 0\)/);
  });

  it('currency must be a 3-letter ISO 4217 code', () => {
    expect(m0048).toMatch(/CONSTRAINT provider_services_currency_format_check CHECK \(currency ~ '\^\[A-Z\]\{3\}\$'\)/);
  });

  it('duration, if set, must be positive', () => {
    expect(m0048).toMatch(/CONSTRAINT provider_services_duration_check CHECK \(duration_minutes IS NULL OR duration_minutes > 0\)/);
  });

  it('provider_id cascades on listing deletion -- no orphaned services', () => {
    expect(m0048).toMatch(/REFERENCES public\.service_providers\(id\) ON DELETE CASCADE/);
  });
});

describe('provider_services (0048): future booking-stage compatibility', () => {
  it('is keyed by the listing id (provider_id), matching the FK a future booking_requests table would use', () => {
    expect(m0048).toMatch(/provider_id uuid NOT NULL/);
    expect(m0048).not.toMatch(/user_id uuid/); // ownership resolved via the FK, not duplicated here
  });

  it('is_active is a plain publish toggle -- no booking/payment table or function is created here', () => {
    expect(m0048).toMatch(/is_active boolean NOT NULL DEFAULT true/);
    expect(m0048).not.toMatch(/CREATE TABLE[^;]*booking/i);
    expect(m0048).not.toMatch(/CREATE (OR REPLACE )?FUNCTION[^(]*(booking|payment|paystack)/i);
  });
});
