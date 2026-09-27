import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0110_revoke_broad_write_grants_wallet_and_audit_tables.sql.
//
// Master security audit (MEDIUM #2, #3, #7): vc_transactions, vents_wallets,
// vc_bonuses, vc_withdrawal_requests, organizer_wallets,
// organizer_transactions, organizer_withdrawal_requests, scan_log,
// ticket_transfers, and admin_action_requests all had INSERT/UPDATE/DELETE
// granted to anon and authenticated, backstopped only by RLS (mostly
// default-deny, a couple with narrow admin-only or own-row policies).
// Every legitimate write to every one of these tables already goes through
// a SECURITY DEFINER function, confirmed live by searching every function
// body for a direct INSERT into each table -- all of them (complete_
// organizer_payout, confirm_ticket_payment_via_wallet, cancel_service_
// booking, finalize_ticket_refund, finalize_service_booking_refund,
// _vc_deduct, _vc_restore, request_vc_cashout, credit_organizer_wallet,
// initiate_ticket_transfer, admin_credit_vents_cents, complete_referral,
// confirm_ticket_payment, log_scan_attempt, refund_ticket, request_
// organizer_payout, credit_provider_wallet_for_booking) are SECURITY
// DEFINER and bypass RLS/grants entirely, so revoking the grants is
// behavior-preserving.
//
// Behavioral proof was run live, in isolated rolled-back transactions,
// against project slrtjxtzhowhwhebjprv:
//   - PRE-FIX: a user could INSERT their own row directly into vc_bonuses
//     (the vcb_own ALL policy allows it -- the one table in this list with
//     a real client-writable policy today).
//   - POST-FIX: the identical direct INSERT now fails with
//     "permission denied for table vc_bonuses" (42501).
//   - POST-FIX: refund_ticket's full wallet-refund path (writing to
//     user_wallets, user_wallet_transactions, organizer_wallets,
//     organizer_transactions, admin_logs) still succeeds end-to-end.
//   - Post-migration grants: anon/authenticated have no INSERT, UPDATE, or
//     DELETE on any of the ten tables; existing SELECT and admin-only
//     write policies are untouched.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0110_revoke_broad_write_grants_wallet_and_audit_tables.sql'), 'utf8');
});

function sqlOnly(): string {
  return migration.replace(/--[^\n]*/g, '');
}

const tables = [
  'vc_transactions', 'vents_wallets', 'vc_bonuses', 'vc_withdrawal_requests',
  'organizer_wallets', 'organizer_transactions', 'organizer_withdrawal_requests',
  'scan_log', 'ticket_transfers', 'admin_action_requests',
];

describe('Revokes INSERT/UPDATE/DELETE from anon and authenticated on wallet and audit tables', () => {
  it.each(tables)('revokes write grants on %s', (table) => {
    expect(migration).toMatch(
      new RegExp(`REVOKE INSERT, UPDATE, DELETE ON public\\.${table} FROM anon, authenticated;`)
    );
  });

  it('touches exactly these ten tables, no more, no fewer', () => {
    const matches = [...migration.matchAll(/REVOKE INSERT, UPDATE, DELETE ON public\.(\w+) FROM anon, authenticated;/g)]
      .map((m) => m[1]);
    expect(matches.sort()).toEqual([...tables].sort());
  });

  it('does not touch SELECT grants, any policy, or any function', () => {
    const sql = sqlOnly();
    expect(sql).not.toMatch(/REVOKE SELECT/);
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).not.toMatch(/DROP POLICY|CREATE POLICY/);
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
  });
});
