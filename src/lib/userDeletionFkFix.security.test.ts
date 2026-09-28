import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0113_fix_user_deletion_fk_blockers.sql.
//
// Bug: Supabase Dashboard -> Authentication -> Users -> Delete User failed
// with "Database error deleting user" for any account that had ever
// interacted with the app. Root cause, confirmed live via pg_constraint:
// public.users CASCADEs from auth.users, and 16 other tables had a plain
// (default ON DELETE NO ACTION) FK pointing at public.users or auth.users,
// so a hard delete could be blocked by a single row in any of them --
// Supabase's Admin API surfaces the underlying FK violation only as the
// generic "Database error deleting user".
//
// The app's existing supported soft-delete path (admin_soft_delete_user,
// and the end-user Settings > Delete Account flow) never touches
// auth.users or these FKs -- it already worked and is unchanged.
//
// Fix reclassifies each of the 16 blocking FKs individually:
//   - pure attribution columns ("who did this", not the row's own
//     ownership, nothing financial) -> SET NULL, so the record survives
//     with the actor reference cleared
//   - the row's own core identity (mostly NOT NULL, so SET NULL isn't even
//     possible) -> CASCADE, matching the precedent already set by
//     tickets.user_id/service_providers.user_id/organizer_reviews.reviewer_id
//   - real financial ledgers/balances/payout requests (user_wallets,
//     user_wallet_transactions, wallet_deposit_attempts,
//     vc_withdrawal_requests.user_id, organizer_withdrawal_requests.
//     organizer_id) are deliberately left untouched (still NO ACTION) --
//     a user with real money attached must still be routed to
//     admin_soft_delete_user, not hard-deleted.
//
// Behavioral proof was run live, in isolated rolled-back transactions with
// synthetic auth.users test accounts (bcrypt-hashed the same way the app's
// own signup does), against project slrtjxtzhowhwhebjprv:
//   - PRE-FIX: DELETE FROM auth.users for a test user referenced by
//     events.hidden_by failed with the exact FK violation
//     ("events_hidden_by_fkey ... still referenced from table events").
//   - POST-FIX: the identical delete succeeds; the event survives with
//     hidden_by = NULL.
//   - POST-FIX: a user with a real user_wallets row is STILL correctly
//     blocked from hard delete (foreign_key_violation) -- the fix did not
//     weaken financial-record protection.
//   - POST-FIX, full journey: a test user with their own ticket, a ticket
//     transfer they initiated, a completed service booking, and a
//     provider review -- after hard delete: auth.users and public.users
//     rows gone, their own ticket/booking/review/transfer gone (cascaded),
//     a DIFFERENT user's ticket they had paid for survives with
//     payer_id = NULL (not deleted), and their username is freed
//     (0 rows) for re-registration.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0113_fix_user_deletion_fk_blockers.sql'), 'utf8');
});

function sqlOnly(): string {
  return migration.replace(/--[^\n]*/g, '');
}

const setNullTargets = [
  ['app_config', 'updated_by'],
  ['events', 'hidden_by'],
  ['events', 'deleted_by'],
  ['users', 'deleted_by'],
  ['organizer_requests', 'reviewed_by'],
  ['organizer_withdrawal_requests', 'resolved_by'],
  ['tickets', 'payer_id'],
  ['tickets', 'refund_initiated_by'],
  ['service_bookings', 'refund_initiated_by'],
  ['vc_withdrawal_requests', 'resolved_by'],
];

const cascadeTargets = [
  ['pending_purchases', 'user_id'],
  ['pending_purchases', 'payer_id'],
  ['ticket_transfers', 'to_user_id'],
  ['ticket_transfers', 'from_user_id'],
  ['service_bookings', 'customer_id'],
  ['provider_reviews', 'reviewer_id'],
];

describe('Fixes the FKs blocking complete auth.users deletion', () => {
  it.each(setNullTargets)('sets %s.%s to ON DELETE SET NULL', (table, col) => {
    const re = new RegExp(
      `ALTER TABLE public\\.${table} ADD CONSTRAINT \\w+\\s+FOREIGN KEY \\(${col}\\) REFERENCES (public\\.users|auth\\.users)\\(id\\) ON DELETE SET NULL;`
    );
    expect(migration).toMatch(re);
  });

  it.each(cascadeTargets)('sets %s.%s to ON DELETE CASCADE', (table, col) => {
    const re = new RegExp(
      `ALTER TABLE public\\.${table} ADD CONSTRAINT \\w+\\s+FOREIGN KEY \\(${col}\\) REFERENCES public\\.users\\(id\\) ON DELETE CASCADE;`
    );
    expect(migration).toMatch(re);
  });

  it('does not touch the real financial-ledger FKs (deliberately left NO ACTION)', () => {
    const sql = sqlOnly();
    expect(sql).not.toMatch(/user_wallets_user_id_fkey/);
    expect(sql).not.toMatch(/user_wallet_transactions_user_id_fkey/);
    expect(sql).not.toMatch(/wallet_deposit_attempts_user_id_fkey/);
    expect(sql).not.toMatch(/vc_withdrawal_requests_user_id_fkey/);
    expect(sql).not.toMatch(/organizer_withdrawal_requests_organizer_id_public_users_fkey/);
  });

  it('does not create or drop any function, policy, or table', () => {
    const sql = sqlOnly();
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY|TABLE)/);
    expect(sql).not.toMatch(/DROP (FUNCTION|POLICY|TABLE)/);
  });
});
