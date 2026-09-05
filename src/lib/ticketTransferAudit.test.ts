import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Audit of the ticket-transfer system (0040_ticket_transfer.sql,
// 0043_ticket_transfer_fee.sql, MyTicketsScreen.tsx) after a report that
// testerboy's My Tickets showed Transfers: 0. No bug was found in the
// transfer RPCs themselves -- these tests lock in what the audit
// confirmed, and document the one real (but by-design) UX subtlety found:
// the Transfers TAB BADGE counts only *pending* transfers
// (incomingPending.length + outgoingPending.length), not total transfer
// history. A user with zero pending transfers sees "Transfers 0" even if
// they have resolved (accepted/declined/expired) transfers sitting in the
// History sub-tab -- that is a badge-semantics choice (mirrors an
// unread-count convention), not evidence of a missing-data bug. Whether
// testerboy specifically has any ticket_transfers row at all is a live-data
// question this static audit cannot answer -- see the accompanying report.

let migration0043: string;
let myTicketsSrc: string;

beforeAll(() => {
  migration0043 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0043_ticket_transfer_fee.sql'), 'utf8');
  myTicketsSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'MyTicketsScreen.tsx'), 'utf8');
});

describe('MyTicketsScreen: transfer query correctness', () => {
  it('loadTransfers fetches ALL transfers involving the user, either direction, any status', () => {
    const fn = myTicketsSrc.match(/const loadTransfers = useCallback\(async \(\) => \{[\s\S]*?\}, \[currentUserId\]\);/)?.[0] ?? '';
    expect(fn).toMatch(/\.or\(`from_user_id\.eq\.\$\{currentUserId\},to_user_id\.eq\.\$\{currentUserId\}`\)/);
    expect(fn).not.toMatch(/\.eq\('status', 'pending'\)/);
  });

  it('the Transfers tab badge count is documented as pending-only, not total history -- explains a "Transfers 0" badge coexisting with resolved transfers in History', () => {
    expect(myTicketsSrc).toMatch(/incomingPending\.length \+ outgoingPending\.length/);
  });

  it('resolved transfers (accepted/declined/etc.) are still rendered, in their own History sub-section, not dropped', () => {
    expect(myTicketsSrc).toMatch(/const transferHistory = transfers\.filter\(\(t\) => t\.status !== 'pending'\);/);
  });
});

describe('Ticket transfer RPCs: atomic ownership swap (0043_ticket_transfer_fee.sql)', () => {
  it('confirm_transfer_fee_payment moves ownership atomically, scoped to the expected prior owner and an uncompromised ticket', () => {
    const fn = migration0043.match(/CREATE OR REPLACE FUNCTION public\.confirm_transfer_fee_payment[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/UPDATE public\.tickets\s*\n\s*SET user_id = v_transfer\.to_user_id,/);
    expect(fn).toMatch(/WHERE id = v_transfer\.ticket_id\s*\n\s*AND user_id = v_transfer\.from_user_id\s*\n\s*AND checked_in = false;/);
    expect(fn).toMatch(/GET DIAGNOSTICS v_rows = ROW_COUNT;/);
  });

  it('accept_ticket_transfer (free/no-fee path) requires the fee to be paid before ever running the ownership swap', () => {
    const fn = migration0043.match(/CREATE OR REPLACE FUNCTION public\.accept_ticket_transfer[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_transfer\.fee_kobo > 0 AND v_transfer\.fee_paid_at IS NULL THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'A transfer fee must be paid before this transfer can be accepted';/);
  });

  it('initiate_ticket_transfer re-validates ownership, payment/active status, and blocks transferring an already-started event', () => {
    const fn = migration0043.match(/CREATE OR REPLACE FUNCTION public\.initiate_ticket_transfer[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_ticket\.user_id IS DISTINCT FROM v_uid THEN/);
    expect(fn).toMatch(/IF v_ticket\.payment_status <> 'paid' THEN/);
    expect(fn).toMatch(/IF v_ticket\.checked_in THEN/);
    expect(fn).toMatch(/This event has already started/);
  });

  it('a duplicate pending transfer for the same ticket is rejected', () => {
    const fn = migration0043.match(/CREATE OR REPLACE FUNCTION public\.initiate_ticket_transfer[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/This ticket already has a pending transfer/);
  });
});
