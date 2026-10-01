import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents economy refactor, Batch C ("Referral Redesign"): replaces the
// old, pre-campaign-framework referral reward (150 VC flat to the referred
// user via a direct vc_transactions insert, 300 VC pending-for-14-days to
// the referrer via another direct insert) with two campaign-framework
// awards: a flat 500 VC referred-user signup bonus (no multiplier), and a
// 1,000 VC x current-badge-multiplier referrer bonus gated on the referred
// user's first real, server-verified event check-in. No badge thresholds,
// multipliers, cash-out, wallet conversion, ticket redemption, frontend, or
// Batch B check-in reward logic were touched.
//
// Live-verified against project slrtjxtzhowhwhebjprv (every statement run
// inside a rolled-back transaction against real users/tickets; production
// confirmed clean afterward -- all users still at vc_lifetime_earned = 0,
// referral_referrer_checkin still disabled, zero tickets created in the
// preceding 5 minutes, the one pre-existing legacy referral transaction
// untouched, before the campaign was activated for real):
//   - complete_referral() with the referred user pre-seeded to Elite
//     (15,000 lifetime VC) still awarded exactly 500 VC, not a
//     multiplied amount -- confirms the flat, non-multiplied reward.
//   - repeating complete_referral() for the same referred user (even with
//     a technically-different code) returned {success:false, message:
//     'Referral already applied'} and left lifetime-earned unchanged --
//     the referral_referred campaign's cap_per_user=1 now blocks stacking
//     bonuses from multiple different referrers, closing a real gap in
//     the old per-(user,reference_id) unique index.
//   - self-referral (own code) and an invalid code were both still
//     rejected with their original messages; an unauthenticated call
//     returned 'Not authenticated'.
//   - immediately after a successful referral, before any check-in, the
//     referrer had zero referral_referrer_checkin transactions (nothing
//     awarded at signup alone).
//   - across all six badge tiers (referrer lifetime seeded to 500, 1,500,
//     4,000, 8,000, 15,000, 30,000 before each referred user's first
//     check-in), the referrer was awarded exactly 1,000 / 1,100 / 1,250 /
//     1,500 / 2,000 / 3,000 VC respectively, and lifetime-earned
//     increased by exactly that amount in each case.
//   - a second ticket for the same referred user at a different event
//     (no longer their first-ever check-in) produced no second referrer
//     award; repeating the first ticket's check-in call (duplicate and
//     simulated retry) also produced no additional award; exactly one
//     referral_referrer_checkin transaction existed for that referral
//     relationship afterward.
//   - QR check-in first then a manual check-in attempt on the same
//     ticket, and manual check-in first then a QR attempt, each produced
//     exactly one referrer award and no second one regardless of which
//     path ran first.
//   - as the `authenticated` role, a direct call to
//     award_vc_reward(..., 'referral_referrer_checkin', ...) failed with
//     permission denied.
//   - profile_complete and event_checkin campaigns were confirmed
//     unaffected (same amount_vc and enabled state as before this batch).
//   - zero new 'pending'-status type='referral' vc_transactions rows were
//     ever created by the redesigned complete_referral(), confirming the
//     old 14-day-hold mechanism can no longer produce a referral reward
//     at all, duplicate or otherwise.
//
// Concurrency: the referrer award's idempotency key is
// (referrer_id, 'referral_referrer_checkin', referred_user_id) via the
// existing vc_transactions_earn_dedup_idx (Batch A) -- this is the
// backstop even in the theoretical case of two different tickets for the
// same referred user being checked in at truly the same instant (the
// first-check-in COUNT read is not itself protected by the per-ticket row
// lock, only the final award is). This was verified by code inspection
// and by the sequential multi-ticket test above, not a true
// multi-connection concurrent-session stress test -- this tool-mediated
// test harness only issues statements sequentially, so genuinely
// simultaneous sessions could not be fired against the live database in
// this pass (same disclosed limitation as Batch A/B).

let m0142: string;
let m0143: string;
let m0144: string;

beforeAll(() => {
  m0142 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0142_vc_referral_redesign_referred_reward.sql'), 'utf8');
  m0143 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0143_vc_referral_referrer_checkin_wiring.sql'), 'utf8');
  m0144 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0144_vc_referral_referrer_checkin_activation.sql'), 'utf8');
});

describe('complete_referral routes the referred-user reward through the central campaign framework', () => {
  it('calls award_vc_reward with referral_referred and the referrer id as reference_id', () => {
    expect(m0142).toMatch(/award_vc_reward\(v_referred_id, 'referral_referred', v_referrer_id, 'active'\)/);
  });

  it('no longer inserts directly into vc_transactions for either side of the referral', () => {
    const fn = m0142.match(/CREATE OR REPLACE FUNCTION public\.complete_referral[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toMatch(/INSERT INTO public\.vc_transactions/);
  });

  it('sets the campaign amount to the approved flat 500 VC', () => {
    expect(m0142).toMatch(/UPDATE public\.vc_reward_campaigns SET amount_vc = 500 WHERE key = 'referral_referred';/);
  });

  it('preserves self-referral protection and both rate-limit checks', () => {
    const fn = m0142.match(/CREATE OR REPLACE FUNCTION public\.complete_referral[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_referrer_id = v_referred_id THEN/);
    expect(fn).toMatch(/check_rate_limit\('complete_referral:' \|\| v_referred_id::text, 5, 3600\)/);
    expect(fn).toMatch(/check_rate_limit\('complete_referral:ip:' \|\| public\.client_ip\(\), 20, 3600\)/);
  });
});

describe('referrer reward is tied only to the referred user\'s first real check-in', () => {
  it('both check-in functions gate the referrer award on count(*) = 1 in checkins', () => {
    for (const fnName of ['verify_entry_pass', 'manual_check_in']) {
      const fn = m0143.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fnName}[\\s\\S]*?\\$function\\$;`))?.[0] ?? '';
      expect(fn).toMatch(/SELECT \(count\(\*\) = 1\) INTO v_is_first_checkin FROM public\.checkins WHERE user_id = v_ticket\.user_id;/);
      expect(fn).toMatch(/campaign_key = 'referral_referred' AND type = 'earn' AND status = 'active'/);
      expect(fn).toMatch(/award_vc_reward\(v_referrer_id, 'referral_referrer_checkin', v_ticket\.user_id, 'active'\)/);
    }
  });

  it('the referrer award is placed strictly after the attendee\'s own event_checkin award, both after the atomic checked_in guard', () => {
    for (const fnName of ['verify_entry_pass', 'manual_check_in']) {
      const fn = m0143.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fnName}[\\s\\S]*?\\$function\\$;`))?.[0] ?? '';
      const guardIdx = fn.indexOf('WHERE id = v_ticket.id AND checked_in = false');
      const attendeeAwardIdx = fn.indexOf("award_vc_reward(v_ticket.user_id, 'event_checkin'");
      const referrerAwardIdx = fn.indexOf("award_vc_reward(v_referrer_id, 'referral_referrer_checkin'");
      expect(guardIdx).toBeGreaterThan(-1);
      expect(attendeeAwardIdx).toBeGreaterThan(guardIdx);
      expect(referrerAwardIdx).toBeGreaterThan(attendeeAwardIdx);
    }
  });

  it('introduces no new table, trigger, or ledger -- reuses the existing checkins and vc_transactions dedup mechanisms', () => {
    expect(m0143).not.toMatch(/CREATE TABLE/);
    expect(m0143).not.toMatch(/CREATE TRIGGER/);
    expect(m0143).not.toMatch(/ADD CONSTRAINT/);
    expect(m0143).not.toMatch(/CREATE UNIQUE INDEX/);
  });
});

describe('activation is scoped to referral_referrer_checkin only', () => {
  it('0144 enables referral_referrer_checkin and nothing else', () => {
    expect(m0144).toMatch(/UPDATE public\.vc_reward_campaigns SET enabled = true WHERE key = 'referral_referrer_checkin';/);
    const sqlOnly = m0144.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect((sqlOnly.match(/UPDATE public\.vc_reward_campaigns/g) ?? []).length).toBe(1);
  });
});

describe('Batch B event check-in reward logic is untouched', () => {
  it('the event_checkin award call is byte-identical to the Batch B wiring', () => {
    expect(m0143).toMatch(/PERFORM public\.award_vc_reward\(v_ticket\.user_id, 'event_checkin', v_ticket\.id, 'active'\);/);
  });
});
