import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for 0103_harden_tickets_write_policies.sql.
//
// Scope note: this is a pure RLS hardening migration -- it drops two
// currently-unreachable policies (insert_tickets, update_tickets) rather
// than adding application code, so there is no client-side path to write a
// behavioral test against. The actual behavioral proof for all 6 required
// scenarios was run live, in isolated transactions rolled back with no
// residue, against project slrtjxtzhowhwhebjprv:
//
//   1. legitimate ticket owner SELECT access succeeds -- confirmed live
//      (unaffected; SELECT policies untouched by this migration).
//   2. another user cannot SELECT another user's ticket -- confirmed live
//      (unaffected; already correctly scoped before this migration).
//   3. unauthorized ticket mutation is rejected -- confirmed live BOTH
//      ways: this migration was proven necessary by first simulating a
//      future GRANT INSERT/UPDATE ON tickets TO authenticated (temporary,
//      rolled back, never persisted) against the PRE-fix policies, which
//      let a ticket's own owner flip checked_in and the event's organizer
//      forge payment_status directly -- the exact latent bug this
//      migration closes. The same simulated-grant scenario against the
//      POST-fix (deployed) policies confirmed both writes are now blocked
//      (0 rows affected), and a forged free-ticket INSERT is rejected too.
//   4. authorized organizer/scanner flows still work -- confirmed live:
//      purchase_ticket (checkout), refund_ticket (organizer), and
//      manual_check_in (scanner, proven in the 0102 migration's own live
//      verification) all still succeed after this migration, since every
//      one of them is a SECURITY DEFINER function owned by the table
//      owner (postgres) with relforcerowsecurity=false on `tickets` --
//      confirmed live via pg_proc/pg_class -- so none of them are subject
//      to RLS at all, regardless of what INSERT/UPDATE policies exist.
//   5. admin flow still works -- confirmed live: refund_ticket succeeds
//      when called by the platform root/admin actor for an event they do
//      not organize, via that function's own is_admin()/root-UID business
//      logic (also SECURITY DEFINER, unaffected by this migration).
//   6. transfer/refund/check-in flows are not broken -- confirmed live:
//      initiate_ticket_transfer succeeds end-to-end after this migration;
//      accept_ticket_transfer's business-rule rejection (unpaid transfer
//      fee) is unrelated to this migration and identical before/after;
//      refund_ticket and manual_check_in both confirmed working above.
//
// These tests instead assert the deployed migration's SQL shape so a
// future edit can't silently reintroduce a write policy without a test
// failing, and that it does not touch anything beyond what it says.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0103_harden_tickets_write_policies.sql'), 'utf8');
});

describe('tickets INSERT/UPDATE policies are dropped, not narrowed or replaced', () => {
  it('drops both the insert_tickets and update_tickets policies', () => {
    expect(migration).toMatch(/DROP POLICY IF EXISTS insert_tickets ON public\.tickets/);
    expect(migration).toMatch(/DROP POLICY IF EXISTS update_tickets ON public\.tickets/);
  });

  it('does not create a replacement INSERT or UPDATE policy on tickets', () => {
    expect(migration).not.toMatch(/CREATE POLICY[^\n]*\n\s*ON public\.tickets/);
  });

  it('does not touch the SELECT policies (select_tickets, tickets_select_own_as_payer) -- reads are unaffected', () => {
    expect(migration).not.toMatch(/(CREATE|DROP) POLICY[^\n]*select_tickets/);
    expect(migration).not.toMatch(/(CREATE|DROP) POLICY[^\n]*tickets_select_own_as_payer/);
  });

  it('does not introduce or modify any RPC -- this is RLS-only, every real mutation path is unaffected', () => {
    expect(migration).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
  });

  it('does not grant or revoke any table-level privilege -- the fix is at the policy layer only', () => {
    const sqlOnly = migration.replace(/--[^\n]*/g, ''); // strip line comments before checking
    expect(sqlOnly).not.toMatch(/\bGRANT\b/);
    expect(sqlOnly).not.toMatch(/\bREVOKE\b/);
  });
});
