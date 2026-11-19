import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for migration 0220 (OEL-01: no ticket for a paid tier is usable
// for entry without a confirmed payment). Real execution -- the vulnerability
// reproduced before 0220, then free / Paystack / wallet / transferred tickets,
// capacity, duplicates, refunds and cancellations after it -- lives in
// scripts/local-pg-test/run-ticket-integrity-verification.sh. This pins what a
// later edit could silently drop.
const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const m = read('supabase/migrations/0220_ticket_payment_integrity.sql');
const undo = read('supabase/rollback/undo_0220.sql');

describe('0220: paid tickets only through checkout', () => {
  it('purchase_ticket refuses any ticket that costs something (free tiers and 100% promos unchanged)', () => {
    expect(m).toContain('IF v_effective > 0 THEN');
    expect(m).toContain("RAISE EXCEPTION 'Paid tickets are bought through checkout (card or VENTS Wallet); nothing was charged and no ticket was issued'");
    expect(m).toContain("v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;");
  });
});

describe('0220: no entry pass and no check-in without a confirmed payment', () => {
  it('generate_ticket_token signs only an active, paid ticket and returns NULL otherwise (never aborts a purchase)', () => {
    expect(m).toContain("IF v_status IS DISTINCT FROM 'active' OR v_payment IS DISTINCT FROM 'paid' THEN\n    RETURN NULL;");
    // The ownership check stays a hard error.
    expect(m).toContain("RAISE EXCEPTION 'Not authorized to sign this ticket';");
  });
  it('both check-in paths refuse a ticket whose payment is not confirmed, before the duplicate check', () => {
    const checks = m.match(/IF v_ticket\.payment_status IS DISTINCT FROM 'paid' THEN\n    v_reason := 'not_paid';/g) ?? [];
    expect(checks.length).toBe(2);
    expect(m).toContain("p_gate_name, false);\n    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);\n  END IF;\n\n  IF v_ticket.checked_in THEN");
    expect(m).toContain("p_gate_name, true);\n    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);\n  END IF;\n\n  IF v_ticket.checked_in THEN");
  });
});

describe('0220: safe to apply and to roll back', () => {
  it('patches in place, anchored and marked, refusing on drift; changes no grant and no row', () => {
    expect(m).toContain("RAISE EXCEPTION '0220: % is not the expected version (anchor % not found exactly once); refusing to patch'");
    expect(m).not.toMatch(/\bGRANT\b|\bREVOKE\b/);
    expect(m).not.toMatch(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+public\./m);
    for (const f of ['purchase_ticket(uuid,text,jsonb,text,text)', 'generate_ticket_token(uuid)', 'verify_entry_pass(text,uuid,text,text)', 'manual_check_in(uuid,uuid,text,text)']) {
      expect(m).toContain(`pg_temp.vents_0220_patch('public.${f}'`);
      expect(undo).toContain(`pg_temp.vents_0220_unpatch('public.${f}'`);
    }
  });
  it('the undo is confirmation-gated and refuses to leave any [0220] text behind', () => {
    expect(undo).toContain(`IS DISTINCT FROM 'undo-0220' THEN`);
    expect(undo).toContain("still carries [0220] text after restoring; refusing");
  });
});
