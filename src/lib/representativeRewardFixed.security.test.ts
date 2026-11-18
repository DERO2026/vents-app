import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for migration 0217: the VENTS Representative reward is FIXED
// at N50,000 per qualifying organizer; the 0201 higher monthly rate (9+
// organizers) is discontinued. Real execution (0201 -> 0210 -> 0216 -> 0217,
// including a claim approved and funded at N75,000 before 0217) lives in
// scripts/local-pg-test/run-representative-reward-integrity-verification.sh.

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const m17 = read('supabase/migrations/0217_representative_reward_fixed_50000.sql');
const undo = read('supabase/rollback/undo_0217.sql');

describe('0217: the reward is fixed at N50,000', () => {
  it('requires 0216 and the N50,000 base', () => {
    expect(m17).toContain(`RAISE EXCEPTION '0217 requires 0216`);
    expect(m17).toContain(`IF (SELECT base_reward_kobo FROM public.earn_settings) IS DISTINCT FROM 5000000 THEN`);
  });

  it('every amount comes from the base only (no monthly rate is read)', () => {
    const r1 = m17.slice(m17.indexOf('r1_new constant text'), m17.indexOf('x1_old constant text'));
    expect(r1).toContain('SELECT base_reward_kobo FROM public.earn_settings;');
    expect(r1).not.toContain('representative_monthly_rates');
  });

  it('no admin action can set a monthly rate: refused at request and at approval', () => {
    expect(m17).toContain(`RAISE EXCEPTION 'Representative rewards are fixed at N50,000; monthly rates are discontinued';`);
    expect(m17).toContain(`q1_new constant text := $a$'earn_recognize_event_profit', 'earn_decide_expense'$a$;`);
  });

  it('a claim at any other amount is held, never rewritten; the table allows only N50,000 for approved/funded/credited', () => {
    expect(m17).toContain(`IF c.amount_kobo IS DISTINCT FROM s.base_reward_kobo THEN`);
    expect(m17).toMatch(/ADD CONSTRAINT representative_reward_claims_fixed_amount\s+CHECK \(status NOT IN \('approved', 'funded', 'credited'\) OR amount_kobo = 5000000\) NOT VALID;/);
    expect(m17).not.toMatch(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+public\./im);   // no row is changed
  });

  it('existing monthly rates are kept as history and frozen', () => {
    expect(m17).toContain('BEFORE INSERT OR UPDATE OR DELETE ON public.representative_monthly_rates');
    expect(m17).toContain('BEFORE TRUNCATE ON public.representative_monthly_rates');
    expect(m17).not.toMatch(/DROP TABLE|TRUNCATE public\.representative_monthly_rates/);
  });

  it('has a confirmed rollback that restores the pre-0217 text and removes only 0217 objects', () => {
    expect(undo).toContain(`IS DISTINCT FROM 'undo-0217' THEN`);
    expect(undo).toContain(`(SELECT reward_kobo FROM public.representative_monthly_rates`);
    expect(undo).toContain(`DROP TRIGGER IF EXISTS representative_monthly_rates_frozen ON public.representative_monthly_rates;`);
    expect(undo).toContain(`DROP CONSTRAINT IF EXISTS representative_reward_claims_fixed_amount;`);
    expect(undo).not.toMatch(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+public\./im);
  });
});

describe('the app offers no monthly uplift', () => {
  it('admin and representative screens', () => {
    expect(read('src/app/components/admin/AdminEarnScreen.tsx')).not.toMatch(/earn_set_monthly_rate|higher rate/i);
    for (const f of ['RepresentativeDashboardScreen.tsx', 'RepresentativeRewardsScreen.tsx']) {
      const src = read(`src/app/components/work/${f}`);
      expect(src, f).not.toMatch(/higher rate|rate_review_threshold/);
    }
  });
});
