import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests for the two notification-lifecycle fixes found
// auditing "Someone Else Pays" end-to-end:
// 1. confirm_ticket_payment (0070) -- the payer previously got no in-app
//    confirmation their payment succeeded.
// 2. get_ticket_provenance (0071) -- "Paid by X" / "Transferred to you
//    from X" context, surfaced on the ticket/QR screen.

let m0070: string;
let m0071: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0070 = readFileSync(join(dir, '0070_payer_receipt_notification.sql'), 'utf8');
  m0071 = readFileSync(join(dir, '0071_ticket_provenance.sql'), 'utf8');
});

describe('confirm_ticket_payment: payer receipt notification', () => {
  const fn = () => m0070.match(/CREATE OR REPLACE FUNCTION public\.confirm_ticket_payment\(p_reference text, p_amount_kobo bigint\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';

  it('notifies the payer only when payer_id is set and genuinely differs from the ticket owner', () => {
    expect(fn()).toMatch(/IF v_payer_id IS NOT NULL AND v_payer_id IS DISTINCT FROM v_user_id THEN/);
  });

  it('names the actual ticket holder in the payer notification, never implying the payer owns the ticket', () => {
    const body = fn().match(/IF v_payer_id IS NOT NULL[\s\S]*?END IF;/)?.[0] ?? '';
    expect(body).toMatch(/COALESCE\(u\.full_name, u\.username, 'their'\)/);
    expect(body).toMatch(/v_payer_id,/);
  });

  it('still sends the ticket-owner confirmation and organizer sale notifications unchanged', () => {
    expect(fn()).toMatch(/'Ticket confirmed! 🎉'/);
    expect(fn()).toMatch(/'New sale! 💰'/);
  });

  it('is still project_admin-only, never reachable from the public Supabase client', () => {
    expect(m0070).toMatch(/REVOKE ALL ON FUNCTION public\.confirm_ticket_payment\(text, bigint\) FROM PUBLIC, anon, authenticated, project_admin;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.confirm_ticket_payment\(text, bigint\) TO project_admin;/);
  });
});

describe('get_ticket_provenance: display-only, scoped to the caller\'s own tickets', () => {
  it('is authenticated-only, never reachable by anon/PUBLIC/project_admin directly', () => {
    expect(m0071).toMatch(/REVOKE ALL ON FUNCTION public\.get_ticket_provenance\(uuid\[\]\) FROM PUBLIC, anon, project_admin;/);
    expect(m0071).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_ticket_provenance\(uuid\[\]\) TO authenticated;/);
  });

  it('only ever returns rows for tickets the caller actually owns', () => {
    expect(m0071).toMatch(/AND t\.user_id = \(SELECT auth\.uid\(\)\);/);
  });

  it('the transferred-from lookup only matches an ACCEPTED transfer landing on the current owner', () => {
    expect(m0071).toMatch(/WHERE ticket_id = t\.id AND status = 'accepted' AND to_user_id = t\.user_id/);
  });

  it('returns display names only -- never raw user rows/emails/phone numbers', () => {
    expect(m0071).toMatch(/RETURNS TABLE\(ticket_id uuid, paid_by_name text, transferred_from_name text\)/);
    expect(m0071).not.toMatch(/\.email|\.phone_number/);
  });
});
