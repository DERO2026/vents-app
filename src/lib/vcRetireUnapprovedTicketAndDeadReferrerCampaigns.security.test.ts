import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents reconciliation: ticket_purchase (50 VC) and first_ticket_purchase
// (100 VC) were live and reachable -- wired into confirm_ticket_payment() and
// confirm_ticket_payment_via_wallet(), firing on every paid ticket -- but were
// never part of the approved earning rules (profile_complete, referral_referred,
// event_checkin, referral_referrer_checkin). referral_referrer (300 VC) was
// separately found enabled with zero call sites anywhere in the codebase,
// superseded by referral_referrer_checkin. This migration disables all three
// at the vc_reward_campaigns config level -- award_vc_reward() already
// returns {awarded:false, reason:'campaign_disabled'} for a disabled
// campaign BEFORE touching vc_transactions or the system pool, so no code
// in confirm_ticket_payment()/confirm_ticket_payment_via_wallet() needed to
// change: they only ever `PERFORM award_vc_reward(...)` and ignore its
// return value, so ticket issuance, notifications, and payment accounting
// are structurally unaffected by the campaigns' enabled state.
//
// Live-verified against project slrtjxtzhowhwhebjprv (read-only before, and
// the real config change after):
//   - Before: ticket_purchase and first_ticket_purchase total_awarded = 0,
//     zero vc_transactions rows with those campaign_keys. Nothing to
//     reverse, no pool adjustment required.
//   - After applying the migration: all three keys show enabled = false;
//     the four approved campaigns (profile_complete, referral_referred,
//     event_checkin, referral_referrer_checkin) are untouched (still
//     enabled = true with their original amount/lifetime/multiplier flags).
//   - Called award_vc_reward() directly for all three retired keys
//     post-migration: each returned {awarded: false, reason:
//     'campaign_disabled'} without inserting any vc_transactions row.
//   - admin_get_vc_pool_status() unchanged: pool_balance 899,501,160,
//     total_user_vc_outstanding 100,498,840, summing to the full
//     1,000,000,000 VC supply -- this migration moved no VC and no pool
//     balance.
//   - Zero vc_transactions rows were modified (this migration contains only
//     an UPDATE on vc_reward_campaigns; no DELETE or UPDATE touches
//     vc_transactions anywhere in its text).

let m0148: string;

beforeAll(() => {
  m0148 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0148_vc_retire_unapproved_ticket_and_dead_referrer_campaigns.sql'),
    'utf8'
  );
});

describe('the migration disables exactly the three unapproved/dead campaigns, nothing else', () => {
  it('targets only ticket_purchase, first_ticket_purchase, and referral_referrer', () => {
    const updateStatement = m0148.match(/UPDATE public\.vc_reward_campaigns[\s\S]*?;/)?.[0] ?? '';
    expect(updateStatement).toMatch(/SET enabled = false/);
    expect(updateStatement).toMatch(/WHERE key IN \('ticket_purchase', 'first_ticket_purchase', 'referral_referrer'\)/);
  });

  it('does not touch referral_referrer_checkin, profile_complete, referral_referred, or event_checkin', () => {
    for (const approved of ['referral_referrer_checkin', 'profile_complete', 'referral_referred', 'event_checkin']) {
      expect(m0148).not.toMatch(new RegExp(`'${approved}'`));
    }
  });

  it('contains no DELETE or UPDATE against vc_transactions -- no historical row is touched', () => {
    expect(m0148).not.toMatch(/DELETE FROM public\.vc_transactions/);
    expect(m0148).not.toMatch(/UPDATE public\.vc_transactions/);
  });

  it('contains no DROP or DELETE of the campaign rows -- disabling, not removing, historical config', () => {
    expect(m0148).not.toMatch(/DELETE FROM public\.vc_reward_campaigns/);
    expect(m0148).not.toMatch(/DROP/i);
  });

  it('does not touch the system pool, user balances, or admin credit/debit functions', () => {
    expect(m0148).not.toMatch(/vc_system_pool/);
    expect(m0148).not.toMatch(/vents_wallets/);
    expect(m0148).not.toMatch(/admin_credit_vents_cents|admin_debit_vents_cents/);
  });
});

describe('payment-confirmation code paths are untouched (config-only change)', () => {
  it('no migration file in this change modifies confirm_ticket_payment or confirm_ticket_payment_via_wallet', () => {
    expect(m0148).not.toMatch(/CREATE OR REPLACE FUNCTION public\.confirm_ticket_payment/);
  });
});
