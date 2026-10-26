import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0193_vents_earn_foundation.sql -- Stage 1 of
// "VENTS Earn" (recruiter/marketer partnerships). Static: reads the
// literal migration SQL and asserts on its text, following the same
// convention as platformFeeAllocation.security.test.ts /
// walletRefundFeeLedger.security.test.ts. Does NOT execute SQL against a
// live database.
//
// Deferred to later stages (explicitly NOT covered here):
//   - Commission ledger computation / payout logic (no such table/function
//     exists yet in this migration).
//   - Frontend screens, team management, counter-offer negotiation.
//   - Any change to confirm_ticket_payment / credit_organizer_wallet /
//     refund_ticket / finalize_ticket_refund -- this migration does not
//     touch any of them, asserted explicitly below.
//   - Migration 0192 is untouched -- asserted explicitly below.

let migration: string;
let migration0192: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0193_vents_earn_foundation.sql'), 'utf8');
  migration0192 = readFileSync(join(dir, '0192_platform_fee_accounting_foundation.sql'), 'utf8');
});

function respondFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.respond_to_recruiter_invitation\(p_partnership_id uuid, p_accept boolean\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

function inviteFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.invite_recruiter_partnership\([\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

describe('0193: scope discipline -- does not touch payment processing or migration 0192', () => {
  it('does not modify confirm_ticket_payment, credit_organizer_wallet, refund_ticket, or finalize_ticket_refund', () => {
    for (const fn of ['confirm_ticket_payment', 'credit_organizer_wallet', 'refund_ticket', 'finalize_ticket_refund']) {
      expect(migration).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    }
  });

  it('introduces no recruiter-commission-ledger or payout table/function (Stage 2+ only)', () => {
    expect(migration).not.toMatch(/recruiter_commission_ledger/);
    expect(migration).not.toMatch(/CREATE (OR REPLACE FUNCTION|TABLE).*payout/i);
  });

  it('migration 0192 file is untouched by this change (sanity: its own content still contains its known markers)', () => {
    expect(migration0192).toMatch(/allocate_ticket_platform_fees/);
    expect(migration0192).toMatch(/platform_fee_reconciliation/);
  });
});

describe('0193: self-approval is structurally impossible', () => {
  it('respond_to_recruiter_invitation authorizes only the organizer_id or the provider-side user_id, never recruiter_id', () => {
    const fn = respondFn();
    expect(fn).not.toBe('');
    // The authorization check compares auth.uid() against organizer_id or
    // service_providers.user_id -- never against recruiter_id as a grant
    // of authority (recruiter_id only appears in the explicit self-check
    // that REJECTS the recruiter, confirmed by the next assertion).
    expect(fn).toMatch(/v_is_authorized_responder\s*:=\s*\(v_partnership\.organizer_id\s*=\s*v_uid\)/);
    expect(fn).toMatch(/sp\.user_id\s*=\s*v_uid/);
  });

  it('explicitly rejects the recruiter responding to their own invitation, even redundantly', () => {
    const fn = respondFn();
    expect(fn).toMatch(/v_uid\s*=\s*v_partnership\.recruiter_id[\s\S]{0,80}RAISE EXCEPTION 'The recruiter cannot respond to their own invitation'/);
  });

  it('invite_recruiter_partnership rejects a recruiter naming themselves as the organizer or provider side', () => {
    const fn = inviteFn();
    expect(fn).toMatch(/p_organizer_id\s*=\s*v_uid[\s\S]{0,60}RAISE EXCEPTION 'Cannot form a partnership with yourself'/);
    expect(fn).toMatch(/sp\.user_id\s*=\s*v_uid[\s\S]{0,40}RAISE EXCEPTION 'Cannot form a partnership with yourself'/);
  });

  it('no UPDATE/INSERT grant on recruiter_partnerships is given directly to authenticated -- all writes go through SECURITY DEFINER functions', () => {
    expect(migration).toMatch(/GRANT SELECT ON public\.recruiter_partnerships TO authenticated;/);
    expect(migration).not.toMatch(/GRANT (INSERT|UPDATE).*ON public\.recruiter_partnerships TO authenticated/);
  });

  it('both invite and respond functions are SECURITY DEFINER with search_path locked', () => {
    for (const fn of [inviteFn(), respondFn()]) {
      expect(fn).toMatch(/SECURITY DEFINER/);
      expect(fn).toMatch(/SET search_path TO ''/);
    }
  });
});

describe('0193: idempotent invitations', () => {
  it('has a partial unique index preventing more than one pending invite per (recruiter, organizer) pair', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX recruiter_partnerships_pending_organizer_uidx\s+ON public\.recruiter_partnerships \(recruiter_id, organizer_id\)\s+WHERE status = 'pending' AND organizer_id IS NOT NULL;/);
  });

  it('has a partial unique index preventing more than one pending invite per (recruiter, provider) pair', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX recruiter_partnerships_pending_provider_uidx\s+ON public\.recruiter_partnerships \(recruiter_id, provider_id\)\s+WHERE status = 'pending' AND provider_id IS NOT NULL;/);
  });

  it('a declined/revoked row does not permanently block a fresh invite (index is scoped to status=pending, not unconditional)', () => {
    // Both unique indexes above are confirmed scoped to `WHERE status = 'pending'`
    // rather than unconditional, so a non-pending row never participates in
    // the uniqueness constraint.
    expect(migration).toMatch(/recruiter_partnerships_pending_organizer_uidx[\s\S]*?WHERE status = 'pending'/);
  });
});

describe('0193: commission split is bounded and keyed in basis points, not a float percentage', () => {
  it('commission_split_bps is an integer column CHECKed to [0, 10000]', () => {
    expect(migration).toMatch(/commission_split_bps\s+integer NOT NULL CHECK \(commission_split_bps >= 0 AND commission_split_bps <= 10000\)/);
  });

  it('invite_recruiter_partnership re-validates the bound server-side, not trusting client input', () => {
    const fn = inviteFn();
    expect(fn).toMatch(/p_commission_split_bps[\s\S]{0,40}<\s*0\s+OR\s+p_commission_split_bps\s*>\s*10000/);
  });
});

describe('0193: organizer-XOR-provider modeling and response consistency are enforced by CHECK constraints', () => {
  it('recruiter_partnerships_one_side_only enforces exactly one of organizer_id/provider_id', () => {
    expect(migration).toMatch(/CONSTRAINT recruiter_partnerships_one_side_only CHECK \(\s*\(organizer_id IS NOT NULL AND provider_id IS NULL\) OR\s*\(organizer_id IS NULL AND provider_id IS NOT NULL\)\s*\)/);
  });

  it('recruiter_partnerships_response_consistency prevents a pending row from carrying a responder', () => {
    expect(migration).toMatch(/CONSTRAINT recruiter_partnerships_response_consistency CHECK \(\s*\(status = 'pending' AND responded_at IS NULL AND responded_by IS NULL\) OR/);
  });
});

describe('0193: grants and RLS follow the established 0012 convention', () => {
  it('both new tables are REVOKEd from PUBLIC/anon/authenticated immediately after creation, then narrowly re-granted', () => {
    for (const table of ['recruiters', 'recruiter_partnerships']) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON public\\.${table} FROM PUBLIC, anon, authenticated;`));
    }
  });

  it('RLS is enabled on both new tables', () => {
    for (const table of ['recruiters', 'recruiter_partnerships']) {
      expect(migration).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
    }
  });

  it('recruiter_partnerships has no UPDATE or DELETE policy for any non-admin role (writes are function-mediated only)', () => {
    const updateOrDeletePolicies = migration.match(/CREATE POLICY \w+ ON public\.recruiter_partnerships\s+FOR (UPDATE|DELETE)/g) ?? [];
    expect(updateOrDeletePolicies).toHaveLength(0);
  });
});

describe('0193: reuses existing username-search infrastructure rather than building new discovery', () => {
  it('does not define a new user-search function -- search_users_for_request (0069) is reused client-side', () => {
    expect(migration).not.toMatch(/CREATE (OR REPLACE FUNCTION|TABLE).*search/i);
  });
});
