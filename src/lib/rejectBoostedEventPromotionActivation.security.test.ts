import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Phase 6 -- Spotlight Boost removed from the purchasable product
// lineup. Static-text assertions against the new migration (same
// convention as activateEventPromotionPaymentBypass.security.test.ts,
// which asserts against the already-applied 0137 migration this one
// builds on) and against the already-applied 0137 file itself, proving
// the new migration rejects 'boosted' going forward while touching
// nothing about historical rows, the table schema, or 0137 itself.

let m0180: string;
let m0137: string;
let m0005: string;

beforeAll(() => {
  m0180 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0180_reject_boosted_event_promotion_activation.sql'), 'utf8');
  m0137 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0137_fix_activate_event_promotion_payment_bypass.sql'), 'utf8');
  m0005 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0005_primary_unique_check_constraints.sql'), 'utf8');
});

describe('0180: activate_event_promotion rejects a new Spotlight/boosted activation', () => {
  it('replaces the function to reject p_plan_type NOT IN (‘featured’, ‘trending’) -- "boosted" is no longer accepted', () => {
    expect(m0180).toMatch(/IF p_plan_type NOT IN \('featured', 'trending'\) THEN/);
    // Checked against just the function body, not this migration's own
    // leading comment block, which legitimately discusses 'boosted' in
    // prose (explaining why it's being removed).
    const fn = m0180.match(/CREATE OR REPLACE FUNCTION public\.activate_event_promotion[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toMatch(/'boosted'/);
  });

  it('keeps the exact same function signature as 0137 -- no DROP FUNCTION statement needed, existing project_admin-only grant still applies', () => {
    expect(m0180).toMatch(/CREATE OR REPLACE FUNCTION public\.activate_event_promotion\(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text, p_organizer_id uuid\)/);
    // Checks for an actual statement, not just the words appearing in this
    // migration's own explanatory comment (which legitimately discusses
    // why no DROP/REVOKE/GRANT statement is needed).
    expect(m0180).not.toMatch(/^DROP FUNCTION/m);
    expect(m0180).not.toMatch(/^(REVOKE|GRANT)/m);
  });

  it('preserves every other validation unchanged: duration, payment_ref, ownership, idempotency', () => {
    expect(m0180).toMatch(/IF p_duration_days NOT IN \(3, 7, 14, 30\) THEN/);
    expect(m0180).toMatch(/IF p_payment_ref IS NULL OR trim\(p_payment_ref\) = '' THEN/);
    expect(m0180).toMatch(/v_owner_id <> p_organizer_id/);
    expect(m0180).toMatch(/ON CONFLICT \(payment_ref\) DO NOTHING;/);
  });

  it('preserves the Featured-only is_featured grant, unaffected by this change', () => {
    expect(m0180).toMatch(/IF p_plan_type = 'featured' THEN\s*\n\s*UPDATE public\.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;/);
  });

  it('never touches the event_promotions table itself -- no ALTER TABLE, no UPDATE/DELETE on existing rows, no data migration', () => {
    expect(m0180).not.toMatch(/ALTER TABLE/i);
    expect(m0180.match(/UPDATE public\.events/g) ?? []).toHaveLength(1); // only the pre-existing is_featured write, nothing new
    expect(m0180).not.toMatch(/DELETE FROM/i);
    expect(m0180).not.toMatch(/UPDATE public\.event_promotions/i);
  });
});

describe('historical Spotlight/boosted records are explicitly preserved, not silently rewritten', () => {
  it('the table-level CHECK constraint (0005) still allows historical ‘boosted’ rows -- deliberately not tightened in 0180', () => {
    expect(m0005).toMatch(/event_promotions_plan_type_check CHECK \(\(plan_type = ANY \(ARRAY\['featured'::text, 'trending'::text, 'boosted'::text\]\)\)\)/);
  });

  it('0137 (already applied) is left completely unedited by this change', () => {
    expect(m0137).toMatch(/IF p_plan_type NOT IN \('boosted', 'featured', 'trending'\) THEN/);
  });
});
