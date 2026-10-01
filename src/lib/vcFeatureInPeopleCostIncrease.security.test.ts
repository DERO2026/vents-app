import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents: the "People" reward the user asked to raise from 150 -> 1,500
// VC is the "Featured in People" spend-cost feature (feature_in_people_vc()),
// NOT a vc_reward_campaigns row -- that table only models earn campaigns,
// and this is a plain VC spend to appear at the top of the People section in
// Explore for 3 days. Confirmed authoritative by a prior migration's own
// filename (fix-feature-in-people-cost-150.sql) naming this exact function
// and cost. Traced every "150 VC" / "150" reference in the codebase before
// concluding this was the only authoritative source to change.
//
// Live-verified against project slrtjxtzhowhwhebjprv: feature_in_people_vc()
// now calls _vc_deduct(v_uid, 1500, ...) in the deployed function body
// (confirmed via pg_get_functiondef after applying migration 0149).

let m0149: string;

beforeAll(() => {
  m0149 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0149_vc_feature_in_people_cost_increase.sql'),
    'utf8'
  );
});

describe('feature_in_people_vc() cost is 1,500 VC, not 150', () => {
  it('deducts exactly 1500 VC via the existing _vc_deduct helper', () => {
    expect(m0149).toMatch(/PERFORM public\._vc_deduct\(v_uid, 1500, 'Featured in People \(3 days\)'\);/);
  });

  it('no longer deducts the old 150 VC amount', () => {
    expect(m0149).not.toMatch(/_vc_deduct\(v_uid, 150,/);
  });

  it('does not touch vc_lifetime_earned or the system pool -- an ordinary spend, unchanged in every other respect', () => {
    const fn = m0149.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toMatch(/vc_lifetime_earned/);
    expect(fn).not.toMatch(/vc_system_pool|_vc_pool_move/);
  });

  it('preserves the 3-day featured-duration logic unchanged', () => {
    expect(m0149).toMatch(/INTERVAL '3 days'/);
  });
});
