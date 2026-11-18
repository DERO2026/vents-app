import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for migration 0216: free events NEVER qualify for the N50,000
// representative reward, on every server path. Real execution against
// Postgres (0201 -> 0210 -> 0216, the full reward flow and every refusal)
// lives in scripts/local-pg-test/run-representative-reward-integrity-
// verification.sh; this file pins what a later edit could silently drop.

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const m16 = read('supabase/migrations/0216_representative_rewards_free_events_never_qualify.sql');
const undo = read('supabase/rollback/undo_0216.sql');
const m09 = read('supabase/migrations/0209_representative_referral_links.sql');

describe('0216: free events never qualify', () => {
  it('builds on 0209, which removed free events from eligibility', () => {
    expect(m09).toMatch(/IF v_paid = 0 AND v_fees = 0 THEN\\n    v_reasons := array_append\(v_reasons, ''free_event''\);/);
    expect(m16).toMatch(/IF position\('\[0209\]' IN pg_get_functiondef\('public\.earn_event_eligibility\(uuid\)'::regprocedure\)\) = 0 THEN\s+RAISE EXCEPTION '0216 requires 0209/);
  });

  it('the approval executor refuses the retired override and any free event, and records no verification', () => {
    expect(m16).toContain(`AND r.payload->'free_event_verified' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'Free events never qualify for a representative reward; payload.free_event_verified is no longer accepted';`);
    expect(m16).toContain(`IF COALESCE((v_elig->>'is_free_event')::boolean, true) THEN
      RAISE EXCEPTION 'Free events never qualify for a representative reward';`);
    expect(m16).toContain(`free_event_verified = false,  -- [0216]`);
  });

  it('crediting re-checks the event: never a free event, never one taken off live, deleted or hidden', () => {
    expect(m16).toContain(`IF c.is_free_event OR c.free_event_verified THEN`);
    expect(m16).toContain(`ARRAY['event_not_found', 'event_deleted', 'event_hidden_by_admin', 'event_not_live', 'free_event']`);
    // The new check sits before any reservation or credit in the patched function.
    const b2 = m16.slice(m16.indexOf('b2_new constant text'), m16.indexOf('BEGIN\n  -- 1. earn_execute_admin_action'));
    expect(b2).not.toMatch(/earn_pool_move|organizer_wallets|organizer_transactions/);
  });

  it('patches only the expected text, exactly once, idempotently', () => {
    expect(m16.match(/not found exactly once/g)).toHaveLength(3);
    expect(m16.match(/IF position\('\[0216\]' IN v_def\) = 0 THEN/g)).toHaveLength(4);
  });

  it('an event is free unless a ticket is genuinely paid for and still paid (free RSVP, 100% promo, fully refunded are free)', () => {
    expect(m16).toContain(`SELECT count(*) INTO v_valid_paid FROM public.tickets
   WHERE event_id = p_event_id AND payment_status = 'paid'
     AND COALESCE(amount, 0) * (1 - COALESCE(discount_percentage, 0) / 100) > 0;`);
    expect(m16).toContain(`IF v_valid_paid = 0 THEN  -- [0216] free, 100% promo or fully refunded`);
    expect(m16).toContain(`'is_free_event',        (v_valid_paid = 0),  -- [0216]`);
  });

  it('free-event claims never count toward the 9+ rate review; the 9 threshold and rate rules are untouched', () => {
    expect(m16).toContain(`AND NOT is_free_event AND NOT free_event_verified;`);
    expect(m16).not.toMatch(/rate_review_threshold|representative_monthly_rates/);
  });

  it('the table CHECK forbids an approved, funded or credited free-event claim (NOT VALID: no row rewritten)', () => {
    expect(m16).toMatch(/ADD CONSTRAINT representative_reward_claims_free_never_qualifies\s+CHECK \(status NOT IN \('approved', 'funded', 'credited'\) OR NOT is_free_event\) NOT VALID;/);
    expect(m16).toMatch(/DROP CONSTRAINT IF EXISTS representative_reward_claims_free_needs_verification;/);
  });

  it('moves no money and changes no row: only functions, one constraint and a read-only report', () => {
    expect(m16).not.toMatch(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+public\./im);
    expect(m16).not.toMatch(/user_wallets|organizer_wallets SET|earn_pool_move\(/);
    expect(m16).not.toMatch(/base_reward_kobo\s*=|reward_kobo\s*:=/);   // the reward amount is not touched
  });

  it('has a confirmed rollback that restores the 0201 text', () => {
    expect(undo).toContain(`IS DISTINCT FROM 'undo-0216' THEN`);
    expect(undo).toContain(`RAISE EXCEPTION 'payload.free_event_verified must be true or false';`);
    expect(undo).toContain(`ADD CONSTRAINT representative_reward_claims_free_needs_verification`);
    // 0201 created it validated; the undo restores that state.
    expect(undo).toContain(`VALIDATE CONSTRAINT representative_reward_claims_free_needs_verification;`);
    expect(undo).toContain(`$a$  IF v_paid = 0 AND v_fees = 0 THEN$a$`);
  });
});

describe('the app no longer offers free-event rewards', () => {
  it('admin screen and representative rules copy', () => {
    expect(read('src/app/components/admin/AdminEarnScreen.tsx')).not.toMatch(/free_event_verified/);
    const rules = read('src/app/components/work/RepresentativeRewardsScreen.tsx');
    expect(rules).toContain('free events never qualify');
    expect(rules).not.toMatch(/free event counts|confirms it was genuine/);
  });
  it('docs state the rule', () => {
    const doc = read('docs/vents-work-earn.md');
    expect(doc).not.toMatch(/free event qualifies only if|free event counts only if/i);
    expect(doc).toMatch(/Free events never qualify/);
  });
});
