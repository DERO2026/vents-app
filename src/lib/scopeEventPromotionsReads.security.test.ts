import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Phase 8 -- audit-and-propose only. This migration is DRAFTED but
// NOT applied to production (per the phase's explicit constraint). These
// are static-text assertions against the drafted file itself (same
// convention as rejectBoostedEventPromotionActivation.security.test.ts),
// so they exercise no live database state and stay green whether or not
// the migration is ever applied -- they just prove the drafted file still
// says what the audit report says it says.

let m0181: string;
let m0008: string;
let m0012: string;

beforeAll(() => {
  m0181 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0181_scope_event_promotions_reads_to_organizer.sql'),
    'utf8'
  );
  m0008 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0008_rls_and_policies.sql'), 'utf8');
  m0012 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0012_fix_default_table_grants.sql'), 'utf8');
});

describe('0008/0012 (live, applied): the exposure this phase audits', () => {
  it('select_event_promotions is currently public (USING (true), anon+authenticated) -- the gap 0181 drafts a fix for', () => {
    expect(m0008).toMatch(/CREATE POLICY select_event_promotions ON event_promotions FOR SELECT TO anon, authenticated USING \(true\);/);
  });

  it('anon currently holds a table-level SELECT grant on event_promotions -- the other half of the gap', () => {
    expect(m0012).toMatch(/GRANT DELETE, INSERT, SELECT, UPDATE ON public\.event_promotions TO anon;/);
  });
});

describe('0181 (drafted, NOT applied): scoped reads + public badge RPC', () => {
  it('drops the public select policy and replaces it with an organizer-owned-rows-only policy for authenticated', () => {
    expect(m0181).toMatch(/DROP POLICY IF EXISTS select_event_promotions ON public\.event_promotions;/);
    expect(m0181).toMatch(
      /CREATE POLICY select_event_promotions ON public\.event_promotions\s+FOR SELECT TO authenticated\s+USING \(organizer_id = \(SELECT auth\.uid\(\)\)\);/
    );
    // anon must not appear as a role on the new policy statement.
    const newPolicy = m0181.match(/CREATE POLICY select_event_promotions[\s\S]*?USING \([^)]*\)\);/)?.[0] ?? '';
    expect(newPolicy).not.toMatch(/anon/);
  });

  it('revokes all table privileges from anon on the base table', () => {
    expect(m0181).toMatch(/REVOKE ALL ON public\.event_promotions FROM anon;/);
  });

  it('adds a SECURITY DEFINER, STABLE badge function returning only event_id and plan_type', () => {
    const fn = m0181.match(/CREATE OR REPLACE FUNCTION public\.get_public_event_promotion_badges[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(fn).toMatch(/RETURNS TABLE \(event_id uuid, plan_type text\)/);
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/STABLE/);
    // Must filter to active, in-window rows -- not return the whole table.
    expect(fn).toMatch(/status = 'active'/);
    expect(fn).toMatch(/now\(\) >= ep\.start_date/);
    expect(fn).toMatch(/now\(\) <= ep\.end_date/);
    // Must never select organizer_id or payment_ref.
    expect(fn).not.toMatch(/organizer_id/);
    expect(fn).not.toMatch(/payment_ref/);
  });

  it('grants EXECUTE on the badge function to anon and authenticated, after revoking PUBLIC default', () => {
    expect(m0181).toMatch(/REVOKE ALL ON FUNCTION public\.get_public_event_promotion_badges\(uuid\[\]\) FROM PUBLIC;/);
    expect(m0181).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_public_event_promotion_badges\(uuid\[\]\) TO anon, authenticated;/);
  });

  it('does not touch activation/payment/pricing/expiry logic or any Creator Studio UI file', () => {
    expect(m0181).not.toMatch(/activate_event_promotion/);
    expect(m0181).not.toMatch(/duration_days/);
    expect(m0181).not.toMatch(/PromotionsScreen/);
  });
});
