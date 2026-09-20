import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real, static SQL-text-assertion tests for VENTS Cents Batch F1's
// authoritative VC config (supabase/migrations/0085_authoritative_vc_config.sql),
// mirroring this repo's own convention (see vcCashoutLimits.security.test.ts /
// vcTicketReward*.security.test.ts) of verifying a live migration's actual,
// deployed function body rather than a re-implementation that could
// silently drift from what ships.

let migration: string;
let priorReferral: string; // 20260807120000 -- the version being re-pointed
let priorTicketReward: string; // 20260808120000 -- the version being re-pointed
let priorCashout0084: string; // 0084 -- proves cash-out config/behavior is untouched

function fn(src: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$(?:function\\$|\\$)\\s*;`);
  return src.match(re)?.[0] ?? '';
}

beforeAll(() => {
  const migDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(migDir, '0085_authoritative_vc_config.sql'), 'utf8');
  priorReferral = readFileSync(join(__dirname, '..', '..', 'migrations', '20260807120000_referral-economy-integrity.sql'), 'utf8');
  priorTicketReward = readFileSync(join(__dirname, '..', '..', 'migrations', '20260808120000_ticket-reward-integrity.sql'), 'utf8');
  priorCashout0084 = readFileSync(join(migDir, '0084_vc_cashout_limits_and_maturation.sql'), 'utf8');
});

describe('new app_config columns are additive with defaults matching current literals', () => {
  const expected: [string, number][] = [
    ['vc_profile_completion_reward', 100],
    ['vc_ticket_purchase_reward', 50],
    ['vc_referral_referred_reward', 150],
    ['vc_referral_referrer_reward', 300],
    ['vc_referral_referrer_hold_days', 14],
    ['vc_badge_bronze_price', 300],
    ['vc_badge_silver_price', 800],
    ['vc_badge_gold_price', 2000],
    ['vc_feature_me_cost', 150],
    ['vc_feature_me_duration_days', 3],
    ['vc_event_boost_cost', 1000],
    ['vc_event_boost_duration_days', 3],
  ];

  it.each(expected)('%s defaults to %d via ADD COLUMN IF NOT EXISTS', (col, val) => {
    const re = new RegExp(`ADD COLUMN IF NOT EXISTS ${col} integer NOT NULL DEFAULT ${val};`);
    expect(migration).toMatch(re);
  });
});

describe('the 8 earn/spend RPCs now read from app_config instead of a hardcoded literal', () => {
  it('claim_profile_bonus reads vc_profile_completion_reward, no bare "100" reward insert remains', () => {
    const f = fn(migration, 'claim_profile_bonus');
    expect(f).toMatch(/SELECT vc_profile_completion_reward INTO v_reward FROM public\.app_config LIMIT 1;/);
    expect(f).not.toMatch(/VALUES \(v_user_id, 100, 'earn'/);
    // Guards preserved
    expect(f).toMatch(/Profile bonus already claimed/);
    expect(f).toMatch(/v_has_avatar AND v_has_bio AND v_has_phone/);
  });

  it('complete_referral reads referred/referrer rewards from app_config, caps stay hardcoded', () => {
    const f = fn(migration, 'complete_referral');
    expect(f).toMatch(/SELECT vc_referral_referred_reward, vc_referral_referrer_reward\s*\n\s*INTO v_referred_reward, v_referrer_reward\s*\n\s*FROM public\.app_config LIMIT 1;/);
    expect(f).not.toMatch(/VALUES \(v_referred_id, 150,/);
    expect(f).not.toMatch(/VALUES \(v_referrer_id, 300,/);
    // Category B structural rules untouched: still hardcoded, not read from config
    expect(f).toMatch(/IF v_joined_count >= 5 THEN/);
    expect(f).toMatch(/IF v_recent_count >= 3 THEN/);
    expect(f).toMatch(/pg_advisory_xact_lock\(hashtextextended\('complete_referral:' \|\| v_referrer_id::text, 0\)\)/);
    expect(f).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'referral' DO NOTHING/);
  });

  it('confirm_ticket_payment (card path) reads vc_ticket_purchase_reward, still calls qualify_referral, still uses the Batch C dedup arbiter', () => {
    const f = fn(migration, 'confirm_ticket_payment');
    expect(f).toMatch(/SELECT vc_ticket_purchase_reward INTO v_reward FROM public\.app_config LIMIT 1;/);
    expect(f).not.toMatch(/VALUES \(v_user_id, 50, 'earn'/);
    expect(f).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'earn' DO NOTHING;/);
    expect(f).toMatch(/PERFORM public\.qualify_referral\(v_user_id, v_first_ticket_id\);/);
    expect(f).toMatch(/IF v_paid_count = v_ticket_count THEN\s*\n\s*RETURN 'already_paid';/);
  });

  it('confirm_ticket_payment_via_wallet reads vc_ticket_purchase_reward and keeps its own guards (see the dedicated wallet-qualification test file for the Objective 3 fix itself)', () => {
    const f = fn(migration, 'confirm_ticket_payment_via_wallet');
    expect(f).toMatch(/SELECT vc_ticket_purchase_reward INTO v_reward FROM public\.app_config LIMIT 1;/);
    expect(f).not.toMatch(/VALUES \(v_user_id, 50, 'earn'/);
    expect(f).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'earn' DO NOTHING;/);
    expect(f).toMatch(/RETURN 'insufficient_balance:'/);
  });

  it('_sweep_referral_vc reads vc_referral_referrer_hold_days, no bare "14 days" interval remains', () => {
    const f = fn(migration, '_sweep_referral_vc');
    expect(f).toMatch(/SELECT vc_referral_referrer_hold_days INTO v_hold_days FROM public\.app_config LIMIT 1;/);
    expect(f).toMatch(/t\.earned_at < now\(\) - make_interval\(days => v_hold_days\)/);
    expect(f).not.toMatch(/INTERVAL '14 days'/);
    // Refund/cancel + qualified_at gating preserved
    expect(f).toMatch(/tk\.payment_status = 'refunded'/);
    expect(f).toMatch(/r\.qualified_at IS NOT NULL/);
    expect(f).toMatch(/FOR UPDATE OF t SKIP LOCKED/);
  });

  it('purchase_badge reads bronze/silver/gold from app_config; platinum/elite/legend remain hardcoded (out of the brief\'s explicit column list -- see migration header)', () => {
    const f = fn(migration, 'purchase_badge');
    expect(f).toMatch(/SELECT vc_badge_bronze_price, vc_badge_silver_price, vc_badge_gold_price\s*\n\s*INTO v_bronze, v_silver, v_gold\s*\n\s*FROM public\.app_config LIMIT 1;/);
    expect(f).toMatch(/WHEN 'bronze'   THEN v_bronze/);
    expect(f).toMatch(/WHEN 'silver'   THEN v_silver/);
    expect(f).toMatch(/WHEN 'gold'     THEN v_gold/);
    expect(f).toMatch(/WHEN 'platinum' THEN 5000/);
    expect(f).toMatch(/WHEN 'elite'    THEN 12000/);
    expect(f).toMatch(/WHEN 'legend'   THEN 25000/);
    expect(f).toMatch(/Cannot downgrade badge/);
  });

  it('feature_in_people_vc reads cost/duration from app_config', () => {
    const f = fn(migration, 'feature_in_people_vc');
    expect(f).toMatch(/SELECT vc_feature_me_cost, vc_feature_me_duration_days INTO v_cost, v_days\s*\n\s*FROM public\.app_config LIMIT 1;/);
    expect(f).not.toMatch(/_vc_deduct\(v_uid, 150,/);
    expect(f).not.toMatch(/INTERVAL '3 days'/);
  });

  it('boost_event_vc reads cost/duration from app_config', () => {
    const f = fn(migration, 'boost_event_vc');
    expect(f).toMatch(/SELECT vc_event_boost_cost, vc_event_boost_duration_days INTO v_cost, v_days\s*\n\s*FROM app_config LIMIT 1;/);
    expect(f).not.toMatch(/_vc_deduct\(v_uid, 1000,/);
    expect(f).toMatch(/Event not found or not yours/);
  });
});

describe('Category B structural rules were NOT moved to config (diffed against the prior, still-hardcoded versions)', () => {
  it('prior complete_referral already hardcoded the 5-referral cap and 3/24h velocity cap', () => {
    const f = fn(priorReferral, 'complete_referral');
    expect(f).toMatch(/IF v_joined_count >= 5 THEN/);
    expect(f).toMatch(/IF v_recent_count >= 3 THEN/);
  });

  it('this migration keeps those same literal caps, not a config read', () => {
    const f = fn(migration, 'complete_referral');
    expect(f).not.toMatch(/v_joined_count >= \(SELECT/);
    expect(f).not.toMatch(/v_recent_count >= \(SELECT/);
    expect(f).not.toMatch(/referral_cap|referral_velocity/i);
  });
});

describe('get_vc_config(): grants and exposure surface', () => {
  it('is granted to anon and authenticated', () => {
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_vc_config\(\) TO anon, authenticated;/);
  });

  it('is a SECURITY DEFINER function with search_path locked down', () => {
    const f = fn(migration, 'get_vc_config');
    expect(f).toMatch(/SECURITY DEFINER/);
    expect(f).toMatch(/SET search_path = ''/);
  });

  it('exposes every Category A economy value, both the 12 newly-config-driven ones and the pre-existing cash-out columns', () => {
    const f = fn(migration, 'get_vc_config');
    for (const key of [
      'profile_completion_reward', 'ticket_purchase_reward',
      'referral_referred_reward', 'referral_referrer_reward', 'referral_referrer_hold_days',
      'badge_bronze_price', 'badge_silver_price', 'badge_gold_price',
      'feature_me_cost', 'feature_me_duration_days',
      'event_boost_cost', 'event_boost_duration_days',
      'cashout_rate_naira_per_1000', 'cashout_min_vc', 'cashout_max_vc',
      'cashout_daily_max_vc', 'cashout_daily_max_requests',
      'cashout_cooldown_minutes', 'cashout_maturation_hold_hours',
    ]) {
      expect(f).toContain(`'${key}'`);
    }
  });

  it('does NOT expose vc_min_ticket_price or vc_max_redemption_pct (dead columns for a removed feature) -- checked against the executable jsonb_build_object body, ignoring the explanatory comment', () => {
    const f = fn(migration, 'get_vc_config');
    const codeOnly = f.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(codeOnly).not.toMatch(/vc_min_ticket_price/);
    expect(codeOnly).not.toMatch(/vc_max_redemption_pct/);
  });

  it('does not expose anything sensitive: no user balances, no other-user data, no admin-only flags', () => {
    const f = fn(migration, 'get_vc_config');
    expect(f).not.toMatch(/vents_wallets|vc_transactions|maintenance_mode|disable_purchases|disable_scanning|disable_signups|disable_payouts|broadcast_message|min_client_version/);
  });

  it('the display-estimate field is named and positioned distinctly from the real cash-out rate field', () => {
    const f = fn(migration, 'get_vc_config');
    expect(f).toContain("'ticket_credit_display_estimate_rate', vc_naira_per_1000");
    expect(f).toContain("'cashout_rate_naira_per_1000', vc_cashout_naira_per_1000");
    // The two keys must not collide or be aliased to each other.
    expect(f.indexOf('ticket_credit_display_estimate_rate')).not.toBe(f.indexOf('cashout_rate_naira_per_1000'));
  });
});

describe('COMMENT ON COLUMN documents the two dead columns as deprecated instead of dropping them', () => {
  it('adds a COMMENT ON COLUMN for vc_min_ticket_price marking it deprecated/dead', () => {
    expect(migration).toMatch(/COMMENT ON COLUMN public\.app_config\.vc_min_ticket_price IS\s*\n\s*'Deprecated\/dead:/);
  });
  it('adds a COMMENT ON COLUMN for vc_max_redemption_pct marking it deprecated/dead', () => {
    expect(migration).toMatch(/COMMENT ON COLUMN public\.app_config\.vc_max_redemption_pct IS\s*\n\s*'Deprecated\/dead:/);
  });
  it('never drops either column (additive-only policy)', () => {
    expect(migration).not.toMatch(/DROP COLUMN/i);
  });
});

describe('no client-side UPDATE grant/policy exists on the new config -- config cannot be client-mutated', () => {
  it('this migration issues no GRANT ... UPDATE ... app_config statement', () => {
    expect(migration).not.toMatch(/GRANT[^;]*UPDATE[^;]*app_config/i);
  });
  it('this migration creates no new RLS policy on app_config at all (the existing root-only UPDATE policy from 0008_rls_and_policies.sql / 20260614103206 is untouched)', () => {
    expect(migration).not.toMatch(/CREATE POLICY[^;]*app_config/i);
  });
});

describe('cash-out (Batch A/D) is completely untouched by this migration', () => {
  it('0084 still defines the same request_vc_cashout reading vc_cashout_naira_per_1000 unchanged', () => {
    expect(priorCashout0084).toMatch(/SELECT vc_cashout_naira_per_1000 INTO v_rate FROM public\.app_config LIMIT 1;/);
  });
  it('this migration does not redefine request_vc_cashout at all', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.request_vc_cashout/);
  });
});

describe('the prior, hardcoded versions really did have bare literals (proves this is a real re-pointing, not a no-op)', () => {
  it('prior confirm_ticket_payment hardcoded 50 VC', () => {
    const f = fn(priorTicketReward, 'confirm_ticket_payment');
    expect(f).toMatch(/VALUES \(v_user_id, 50, 'earn', 'active', v_first_ticket_id, now\(\)\)/);
  });
  it('prior complete_referral hardcoded 150 / 300', () => {
    const f = fn(priorReferral, 'complete_referral');
    expect(f).toMatch(/VALUES \(v_referred_id, 150, 'referral'/);
    expect(f).toMatch(/VALUES \(v_referrer_id, 300, 'referral'/);
  });
});
