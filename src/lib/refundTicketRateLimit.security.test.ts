import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0109_add_refund_ticket_rate_limit.sql.
//
// Master security audit (MEDIUM #4): refund_ticket() was the one
// organizer-facing money-moving RPC in the tickets domain with no
// check_rate_limit() call. Fix adds the same PERFORM public.check_rate_
// limit(...) pattern used by every sibling RPC, keyed per-caller, 30/hour,
// placed after the existing auth/reason checks and before the row lock.
//
// IMPORTANT, verified live and worth stating plainly: unlike verify_entry_
// pass/manual_check_in (which never RAISE for an expected business-logic
// failure -- they always RETURN a jsonb {ok:false,...}), refund_ticket
// DOES use RAISE EXCEPTION for several of its own guard conditions
// ("Ticket not found", "Only paid tickets can be refunded", "A checked-in
// ticket cannot be refunded", the authorization check). Because those
// raise inside the same transaction as the RPC call, a caller who
// deliberately triggers one of those specific exceptions does NOT have
// their check_rate_limit() increment persist for that particular call --
// PL/pgSQL's implicit savepoint semantics roll back everything in that
// call, including the counter row, when the function raises. This means
// the limit does not stack up from repeated failed/rejected attempts
// (bad ticket_id, spamming an already-checked-in ticket, etc).
//
// It DOES correctly cap what the audit finding was actually about: real,
// successful, money-moving refunds. Every successful path in this function
// (the zero-amount branch, the wallet-refund branch, and the payment-
// gateway refund-pending branch) ends in RETURN, never RAISE, so its
// check_rate_limit() increment always commits. Verified live in an
// isolated rolled-back transaction against project slrtjxtzhowhwhebjprv:
// 31 real refundable tickets, calling refund_ticket sequentially -- calls
// 1-30 succeed, call 31 fails with SQLSTATE P0429 ('rate_limited').
//
// A tighter fix (e.g. incrementing the counter in a way that survives the
// caller's own exception, or moving the check after the guards) is out of
// scope for this smallest-safe-fix batch and would touch working
// exception-handling behavior other code may depend on; tracked as a
// known limitation rather than silently treated as fully closed.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0109_add_refund_ticket_rate_limit.sql'), 'utf8');
});

function body(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.refund_ticket\([\s\S]*?\$function\$;/)?.[0] ?? '';
}

describe('Adds a rate limit to refund_ticket()', () => {
  it('redefines refund_ticket (not a new function)', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket\(/);
  });

  it('calls check_rate_limit keyed per-caller, before the ticket row lock', () => {
    const fn = body();
    const rlIdx = fn.indexOf("PERFORM public.check_rate_limit('refund_ticket:' || auth.uid()::text, 30, 3600);");
    const lockIdx = fn.indexOf('FOR UPDATE OF t;');
    expect(rlIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(rlIdx);
  });

  it('leaves every existing guard and refund branch unchanged', () => {
    const fn = body();
    expect(fn).toMatch(/A refund reason is required/);
    expect(fn).toMatch(/Only the event organizer or an admin can refund this ticket/);
    expect(fn).toMatch(/already_refunded/);
    expect(fn).toMatch(/A checked-in ticket cannot be refunded/);
    expect(fn).toMatch(/Only paid tickets can be refunded/);
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'refund' AND reference_id IS NOT NULL\) DO NOTHING/);
  });
});
