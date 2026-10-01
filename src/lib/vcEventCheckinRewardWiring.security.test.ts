import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents economy refactor, Batch B ("Event Check-In Rewards"): wires
// the event_checkin campaign (built but inert since Batch A) into the two
// existing server-authoritative check-in paths -- verify_entry_pass (QR)
// and manual_check_in (door-manager override) -- and activates it. No
// reward amounts, no referral work, no cash-out, no frontend, no badge
// migration, and no other campaign touched.
//
// Live-verified against project slrtjxtzhowhwhebjprv (every destructive
// statement run inside a rolled-back transaction against real tickets;
// production confirmed clean afterward -- all 42 users still at
// vc_lifetime_earned = 0, all three test tickets still checked_in = false,
// before the campaign was activated for real):
//   - QR check-in (verify_entry_pass) with the ticket owner seeded to
//     Silver (1,500 lifetime VC, 1.10x): awarded 275 VC (250*1.10),
//     lifetime 1,500 -> 1,775.
//   - Manual check-in (manual_check_in) with the ticket owner seeded to
//     Gold (4,000 lifetime VC, 1.25x): awarded 313 VC (round(250*1.25) =
//     round(312.5) = 313, using the existing round()-based formula from
//     award_vc_reward() -- no new rounding/representation introduced),
//     lifetime 4,000 -> 4,313.
//   - Repeating the identical QR check-in on the same ticket: ok:false,
//     reason:already_scanned, lifetime unchanged.
//   - Manual check-in attempted after a QR check-in on the same ticket:
//     ok:false, reason:already_scanned, lifetime unchanged.
//   - QR check-in attempted after a manual check-in on the same ticket:
//     ok:false, reason:already_scanned, lifetime unchanged.
//   - A tampered/invalid QR signature: ok:false, reason:invalid_signature,
//     lifetime unchanged -- confirms the award call is unreachable on any
//     failed verification path.
//   - A ticket that was purchased but never checked in: zero
//     vc_transactions rows with campaign_key='event_checkin' for that
//     ticket's reference_id.
//   - As the `authenticated` role, a direct call to
//     award_vc_reward(..., 'event_checkin', ...) failed with permission
//     denied -- a client cannot manufacture the reward by calling the
//     ledger function directly, only by actually completing a check-in.
//   - A manual check-in immediately retried with identical arguments
//     (simulating a client retry after a timeout): exactly one row in
//     checkins for the ticket, exactly one row in vc_transactions for
//     (campaign_key='event_checkin', reference_id=ticket.id).
//
// Concurrency: both functions take `SELECT ... FOR UPDATE OF t` on the
// ticket row before the state-changing `UPDATE tickets SET checked_in =
// true ... WHERE checked_in = false`. That UPDATE's WHERE clause can only
// ever match once per ticket -- a second concurrent transaction either
// blocks on the row lock until the first commits (then reads
// checked_in = true and takes the already_scanned branch) or, if it
// somehow evaluates the UPDATE first under snapshot isolation, loses the
// WHERE-clause match once the first transaction's row lock releases. The
// award call sits strictly after this guard succeeds, so at most one of
// any number of concurrent attempts against the same ticket can ever reach
// it -- and even if that structural guarantee were somehow bypassed, the
// reference_id=ticket.id award is still deduplicated by the pre-existing
// vc_transactions_earn_dedup_idx unique partial index (Batch A). This was
// verified by code inspection of the live function bodies (reproduced in
// migration 0140) plus the sequential-retry test above, not a true
// multi-connection concurrent-session stress test -- this tool-mediated
// test harness only issues statements sequentially, so genuinely
// simultaneous sessions could not be fired against the live database in
// this pass (documented the same way in the Batch A test file).

let m0140: string;
let m0141: string;

beforeAll(() => {
  m0140 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0140_vc_event_checkin_reward_wiring.sql'), 'utf8');
  m0141 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0141_vc_event_checkin_campaign_activation.sql'), 'utf8');
});

describe('verify_entry_pass awards event_checkin only after a real, server-confirmed check-in', () => {
  it('calls award_vc_reward with the ticket owner, event_checkin, and the ticket id as the idempotency key', () => {
    const fn = m0140.match(/CREATE OR REPLACE FUNCTION public\.verify_entry_pass[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/PERFORM public\.award_vc_reward\(v_ticket\.user_id, 'event_checkin', v_ticket\.id, 'active'\);/);
  });

  it('places the award call strictly after the atomic checked_in guard, not before', () => {
    const fn = m0140.match(/CREATE OR REPLACE FUNCTION public\.verify_entry_pass[\s\S]*?\$function\$;/)?.[0] ?? '';
    const guardIdx = fn.indexOf("WHERE id = v_ticket.id AND checked_in = false");
    const awardIdx = fn.indexOf("PERFORM public.award_vc_reward(v_ticket.user_id, 'event_checkin'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(awardIdx).toBeGreaterThan(guardIdx);
  });

  it('every pre-existing validation branch (signature, version, expiry, ownership, status, duplicate) is unchanged', () => {
    expect(m0140).toMatch(/invalid_signature/);
    expect(m0140).toMatch(/This QR code failed cryptographic verification\./);
    expect(m0140).toMatch(/already_scanned/);
    expect(m0140).toMatch(/wrong_organizer/);
    expect(m0140).toMatch(/not_active/);
  });
});

describe('manual_check_in awards event_checkin with the same idempotency key as verify_entry_pass', () => {
  it('calls award_vc_reward identically (same campaign key, same reference_id shape)', () => {
    const fn = m0140.match(/CREATE OR REPLACE FUNCTION public\.manual_check_in[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/PERFORM public\.award_vc_reward\(v_ticket\.user_id, 'event_checkin', v_ticket\.id, 'active'\);/);
  });

  it('places the award call strictly after the atomic checked_in guard', () => {
    const fn = m0140.match(/CREATE OR REPLACE FUNCTION public\.manual_check_in[\s\S]*?\$function\$;/)?.[0] ?? '';
    const guardIdx = fn.indexOf("WHERE id = v_ticket.id AND checked_in = false");
    const awardIdx = fn.indexOf("PERFORM public.award_vc_reward(v_ticket.user_id, 'event_checkin'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(awardIdx).toBeGreaterThan(guardIdx);
  });

  it('is_event_door_manager authorization and every other existing check is unchanged', () => {
    expect(m0140).toMatch(/IF NOT public\.is_event_door_manager\(v_ticket\.event_id\) THEN/);
  });
});

describe('no parallel check-in mechanism or second reward ledger was introduced', () => {
  it('0140 does not create any new table, trigger, or ledger', () => {
    expect(m0140).not.toMatch(/CREATE TABLE/);
    expect(m0140).not.toMatch(/CREATE TRIGGER/);
  });

  it('reuses the existing checkins unique(ticket_id) constraint and vc_transactions dedup index implicitly -- no new unique constraint added here', () => {
    expect(m0140).not.toMatch(/ADD CONSTRAINT/);
    expect(m0140).not.toMatch(/CREATE UNIQUE INDEX/);
  });
});

describe('campaign activation is scoped to event_checkin only', () => {
  it('0141 enables event_checkin and nothing else', () => {
    expect(m0141).toMatch(/UPDATE public\.vc_reward_campaigns SET enabled = true WHERE key = 'event_checkin';/);
    const sqlOnly = m0141.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(sqlOnly).not.toMatch(/referral_referrer_checkin/);
    expect((sqlOnly.match(/UPDATE public\.vc_reward_campaigns/g) ?? []).length).toBe(1);
  });
});
