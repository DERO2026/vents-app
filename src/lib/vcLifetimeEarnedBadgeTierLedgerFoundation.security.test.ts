import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents economy refactor, Batch A ("Ledger Foundation" only): lifetime
// qualifying VC earned tracking, badge tier/multiplier lookup, and
// multiplier support in award_vc_reward() -- with NO reward-amount changes,
// NO campaign activation, NO cash-out changes, and NO frontend changes.
// Approved thresholds (lifetime qualifying VC -> multiplier):
//   bronze 500 (1.00x), silver 1,500 (1.10x), gold 4,000 (1.25x),
//   platinum 8,000 (1.50x), elite 15,000 (2.00x), legend 30,000 (3.00x).
//
// Live-verified against project slrtjxtzhowhwhebjprv (every statement
// below run inside a rolled-back transaction; production confirmed clean
// afterward -- all 42 users still at vc_lifetime_earned = 0, both new
// campaigns still enabled = false):
//   - profile_complete (qualifying) incremented lifetime-earned; ticket_purchase
//     (non-qualifying) did not.
//   - a real 'spend' transaction and a 'refund' transaction left
//     lifetime-earned unchanged.
//   - UPDATE users SET vc_lifetime_earned = -1 was rejected by the
//     vc_lifetime_earned_non_negative check constraint.
//   - as the `authenticated` role (via SET LOCAL ROLE + request.jwt.claims,
//     using a literal UUID fetched as the privileged connection BEFORE the
//     role switch -- not a role-scoped subquery, which silently no-ops
//     under RLS), a direct UPDATE to vc_lifetime_earned failed with
//     "vc_lifetime_earned can only be changed via award_vc_reward()".
//   - vc_tier_for_lifetime()/vc_multiplier_for_tier() returned the exact
//     expected tier and multiplier at every specified boundary: 0 and 499
//     -> no tier (1.0x default); 500 and 1,499 -> bronze (1.00x); 1,500 and
//     3,999 -> silver (1.10x); 4,000 and 7,999 -> gold (1.25x); 8,000 and
//     14,999 -> platinum (1.50x); 15,000 and 29,999 -> elite (2.00x);
//     30,000 and 50,000 -> legend (3.00x).
//   - with the user seeded (as the privileged connection) to exactly
//     1,500 lifetime VC (silver) and then 15,000 (elite), the inert,
//     transaction-locally-enabled event_checkin campaign (250 VC base,
//     multiplier_eligible) awarded exactly 275 (250*1.10) and 500
//     (250*2.00) respectively -- multiplier math confirmed, not assumed.
//   - repeating the same reference_id for the same campaign returned
//     {awarded:false, reason:'already_awarded'} and did not double-credit
//     VC or lifetime-earned (relies on the existing
//     vc_transactions_earn_dedup_idx unique partial index).
//   - as `authenticated`, a direct call to award_vc_reward() failed with
//     permission denied; as `anon`, a direct call to vc_tier_for_lifetime()
//     failed with permission denied; as `authenticated`, an UPDATE to
//     vc_badge_tiers failed with permission denied; `authenticated` could
//     still SELECT vc_badge_tiers (6 rows visible), confirming read access
//     is intentionally public while writes are not.
//
// Concurrency note: the lifetime-earned increment is a single atomic
// `UPDATE users SET vc_lifetime_earned = vc_lifetime_earned + v_amount
// WHERE id = ...` inside the same SECURITY DEFINER function that already
// takes `SELECT ... FOR UPDATE` on the campaign row -- Postgres row-level
// locking on the campaign row serializes concurrent award_vc_reward() calls
// for the same campaign, and the users row UPDATE itself is a single
// statement (no read-modify-write race window in application code), so a
// lost update is not structurally possible. This was verified by code
// inspection of the live function body (reproduced in migration 0138), not
// by a live concurrent-session stress test -- this tool-mediated test
// harness only runs statements sequentially, so true concurrent sessions
// could not be fired against the live database in this pass.

let m0138: string;
let m0139: string;

beforeAll(() => {
  m0138 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0138_vc_lifetime_earned_badge_tier_ledger_foundation.sql'), 'utf8');
  m0139 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0139_vc_badge_tiers_approved_lifetime_thresholds.sql'), 'utf8');
});

describe('vc_lifetime_earned is tamper-resistant', () => {
  it('adds a non-negative, server-maintained counter column', () => {
    expect(m0138).toMatch(/ADD COLUMN IF NOT EXISTS vc_lifetime_earned integer NOT NULL DEFAULT 0;/);
    expect(m0138).toMatch(/CHECK \(vc_lifetime_earned >= 0\)/);
  });

  it('protect_trust_signal_columns() blocks direct client writes to vc_lifetime_earned', () => {
    expect(m0138).toMatch(/IF OLD\.vc_lifetime_earned IS DISTINCT FROM NEW\.vc_lifetime_earned THEN/);
    expect(m0138).toMatch(/RAISE EXCEPTION 'vc_lifetime_earned can only be changed via award_vc_reward\(\)';/);
  });

  it('reuses the existing trigger function rather than defining a new trigger', () => {
    expect(m0138).not.toMatch(/CREATE TRIGGER/);
  });
});

describe('badge tier/multiplier lookup uses the approved thresholds, not the old purchase-price ladder', () => {
  it('0139 updates all six tiers to the approved lifetime-VC thresholds', () => {
    expect(m0139).toMatch(/UPDATE public\.vc_badge_tiers SET min_lifetime_vc = 500,\s*multiplier = 1\.00 WHERE tier = 'bronze';/);
    expect(m0139).toMatch(/UPDATE public\.vc_badge_tiers SET min_lifetime_vc = 1500,\s*multiplier = 1\.10 WHERE tier = 'silver';/);
    expect(m0139).toMatch(/UPDATE public\.vc_badge_tiers SET min_lifetime_vc = 4000,\s*multiplier = 1\.25 WHERE tier = 'gold';/);
    expect(m0139).toMatch(/UPDATE public\.vc_badge_tiers SET min_lifetime_vc = 8000,\s*multiplier = 1\.50 WHERE tier = 'platinum';/);
    expect(m0139).toMatch(/UPDATE public\.vc_badge_tiers SET min_lifetime_vc = 15000,\s*multiplier = 2\.00 WHERE tier = 'elite';/);
    expect(m0139).toMatch(/UPDATE public\.vc_badge_tiers SET min_lifetime_vc = 30000,\s*multiplier = 3\.00 WHERE tier = 'legend';/);
  });

  it('0138 seeds the table with placeholder values explicitly flagged as unapproved', () => {
    expect(m0138).toMatch(/PLACEHOLDER thresholds/);
    expect(m0138).toMatch(/\('bronze',\s*1, 300,\s*1\.00\)/);
  });

  it('vc_badge_tiers is admin-writable only, publicly readable', () => {
    expect(m0138).toMatch(/REVOKE ALL ON public\.vc_badge_tiers FROM PUBLIC, anon, authenticated;/);
    expect(m0138).toMatch(/GRANT SELECT ON public\.vc_badge_tiers TO anon, authenticated;/);
  });

  it('vc_tier_for_lifetime and vc_multiplier_for_tier are STABLE and schema-qualified', () => {
    expect(m0138).toMatch(/CREATE OR REPLACE FUNCTION public\.vc_tier_for_lifetime\(p_lifetime integer\)[\s\S]*?STABLE/);
    expect(m0138).toMatch(/CREATE OR REPLACE FUNCTION public\.vc_multiplier_for_tier\(p_tier text\)[\s\S]*?STABLE/);
    expect(m0138).toMatch(/SET search_path TO ''/);
  });
});

describe('award_vc_reward() gains multiplier support without changing unrelated campaign behavior', () => {
  it('only applies a multiplier when the campaign is multiplier_eligible', () => {
    const fn = m0138.match(/CREATE OR REPLACE FUNCTION public\.award_vc_reward[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_campaign\.multiplier_eligible THEN/);
    expect(fn).toMatch(/v_multiplier := COALESCE\(v_multiplier, 1\.0\);/);
    expect(fn).toMatch(/v_amount := GREATEST\(1, round\(v_campaign\.amount_vc \* v_multiplier\)::integer\);/);
  });

  it('increments vc_lifetime_earned only when the campaign counts_toward_lifetime', () => {
    const fn = m0138.match(/CREATE OR REPLACE FUNCTION public\.award_vc_reward[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_campaign\.counts_toward_lifetime THEN\s*\n\s*UPDATE public\.users SET vc_lifetime_earned = vc_lifetime_earned \+ v_amount WHERE id = p_user_id;/);
  });

  it('remains postgres/project_admin-only -- unreachable directly from any client', () => {
    expect(m0138).toMatch(/REVOKE ALL ON FUNCTION public\.award_vc_reward\(uuid, text, uuid, text\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(m0138).toMatch(/GRANT EXECUTE ON FUNCTION public\.award_vc_reward\(uuid, text, uuid, text\) TO postgres, project_admin;/);
  });

  it('existing idempotency (unique-violation -> already_awarded) is unchanged', () => {
    const fn = m0138.match(/CREATE OR REPLACE FUNCTION public\.award_vc_reward[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/EXCEPTION WHEN unique_violation THEN\s*\n\s*RETURN jsonb_build_object\('awarded', false, 'reason', 'already_awarded'\);/);
  });
});

describe('Batch A activates no new reward behavior', () => {
  it('the two new qualifying campaigns are inserted disabled', () => {
    expect(m0138).toMatch(/\('event_checkin', 'Event check-in', 250, false, true, true\)/);
    expect(m0138).toMatch(/\('referral_referrer_checkin',[\s\S]*?1000, false, true, true\)/);
  });

  it('only profile_complete and referral_referred are retroactively marked counts_toward_lifetime, with no amount change', () => {
    expect(m0138).toMatch(/UPDATE public\.vc_reward_campaigns\s*\n\s*SET counts_toward_lifetime = true\s*\n\s*WHERE key IN \('profile_complete', 'referral_referred'\);/);
    expect(m0138).not.toMatch(/SET amount_vc/);
  });
});
