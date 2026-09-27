import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0106_fix_claim_profile_bonus_double_credit.sql.
//
// Master security audit (HIGH #1): claim_profile_bonus() had a TOCTOU
// double-credit race -- a plain `SELECT EXISTS` "already claimed" check
// was not atomic with the unconditional vc_transactions INSERT that
// followed it, so two near-simultaneous calls could both pass the check
// and both get credited 100 VC before either committed. Fix mirrors
// complete_referral's already-correct pattern: INSERT INTO vc_bonuses
// first with ON CONFLICT (user_id, bonus_type) DO NOTHING RETURNING id,
// and only credit vc_transactions IF the insert actually won (id is not
// NULL). The real UNIQUE(user_id, bonus_type) constraint is the atomic
// mutex, so exactly one of two racing callers can ever get past the gate.
//
// Behavioral proof was run live, in isolated rolled-back transactions with
// zero residue, against project slrtjxtzhowhwhebjprv:
//   - PRE-FIX repro (manually interleaved call bodies): both callers passed
//     the old EXISTS check before either inserted -> 2 credited rows.
//   - POST-FIX repro: two sequential INSERT ... ON CONFLICT DO NOTHING
//     RETURNING id calls -> first returns an id, second returns NULL.
//   - Live deployed function, called twice sequentially as a real fixture
//     user (91b0afb4-b5dc-4289-ae00-8e6e58c60f5f) inside BEGIN...ROLLBACK:
//     exactly one vc_bonuses row for bonus_type='profile_complete' exists
//     after both calls (bonus_rows=1), confirming the second call was
//     rejected by the atomic gate rather than crediting again.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0106_fix_claim_profile_bonus_double_credit.sql'), 'utf8');
});

function body(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.claim_profile_bonus\(\)[\s\S]*?\$function\$;/)?.[0] ?? '';
}

describe('Fixes the claim_profile_bonus() TOCTOU double-credit race', () => {
  it('redefines claim_profile_bonus (not a new function)', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_profile_bonus\(\)/);
  });

  it('uses the vc_bonuses UNIQUE(user_id, bonus_type) constraint as an atomic claim gate', () => {
    const fn = body();
    expect(fn).toMatch(/INSERT INTO public\.vc_bonuses \(user_id, bonus_type\)/);
    expect(fn).toMatch(/ON CONFLICT \(user_id, bonus_type\) DO NOTHING/);
    expect(fn).toMatch(/RETURNING id INTO v_bonus_id/);
  });

  it('gates the vc_transactions credit on the insert having actually won the race', () => {
    const fn = body();
    const gateIdx = fn.indexOf('IF v_bonus_id IS NULL THEN');
    const creditIdx = fn.indexOf('INSERT INTO public.vc_transactions');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(creditIdx).toBeGreaterThan(gateIdx);
    expect(fn).toMatch(/IF v_bonus_id IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('success', false, 'message', 'Profile bonus already claimed'\);/);
  });

  it('no longer uses a non-atomic SELECT EXISTS pre-check against vc_bonuses', () => {
    const fn = body();
    expect(fn).not.toMatch(/IF EXISTS \(SELECT 1 FROM public\.vc_bonuses/);
  });

  it('adds check_rate_limit, matching every sibling earn-path RPC', () => {
    expect(body()).toMatch(/PERFORM public\.check_rate_limit\('claim_profile_bonus:' \|\| v_user_id::text, 5, 60\);/);
  });

  it('leaves the eligibility check (avatar/bio/phone) and the 100 VC award amount unchanged', () => {
    const fn = body();
    expect(fn).toMatch(/avatar_url IS NOT NULL AND avatar_url <> ''/);
    expect(fn).toMatch(/length\(trim\(bio\)\) >= 10/);
    expect(fn).toMatch(/phone_number IS NOT NULL AND phone_number <> ''/);
    expect(fn).toMatch(/VALUES \(v_user_id, 100, 'earn', 'active', now\(\)\)/);
    expect(fn).toMatch(/'vc_awarded', 100/);
  });

  it('still requires authentication and is SECURITY DEFINER with a locked search_path', () => {
    const fn = body();
    expect(fn).toMatch(/IF v_user_id IS NULL THEN/);
    expect(migration).toMatch(/SECURITY DEFINER/);
    expect(migration).toMatch(/SET search_path TO ''/);
  });
});
