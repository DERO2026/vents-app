import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0193_vents_earn_foundation.sql -- Stage 1 of
// "VENTS Earn" (recruiter/marketer partnerships). Static: reads the
// literal migration SQL and asserts on its text, following the same
// convention as platformFeeAllocation.security.test.ts /
// walletRefundFeeLedger.security.test.ts. These tests do NOT execute SQL
// against a live database -- they can confirm the right code is present,
// not that it runs correctly. For actual execution against a real
// Postgres engine (the authorization branches of withdraw_recruiter_invitation
// / revoke_recruiter_partnership / admin_set_recruiter_status, and the
// recruiters_select_partner RLS scoping, under real impersonated callers),
// see scripts/local-pg-test/run-vents-earn-verification.sh -- that script
// is the one that actually runs the SQL; everything in this file is a
// static text check.
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
  migration0192 = readFileSync(join(dir, '_superseded', '0192_platform_fee_accounting_foundation.sql'), 'utf8');
});

function respondFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.respond_to_recruiter_invitation\(p_partnership_id uuid, p_accept boolean\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

function inviteFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.invite_recruiter_partnership\([\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

function withdrawFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.withdraw_recruiter_invitation\([\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

function revokeFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.revoke_recruiter_partnership\([\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

function adminSetStatusFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.admin_set_recruiter_status\([\s\S]*?\$function\$\s*;/)?.[0] ?? '';
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

  it('recruiter_partnerships_response_consistency prevents a pending or withdrawn row from carrying a responder, and requires one for accepted/declined/revoked', () => {
    expect(migration).toMatch(/CONSTRAINT recruiter_partnerships_response_consistency CHECK \(\s*\(status IN \('pending', 'withdrawn'\) AND responded_at IS NULL AND responded_by IS NULL\) OR\s*\(status IN \('accepted', 'declined', 'revoked'\) AND responded_at IS NOT NULL AND responded_by IS NOT NULL\)\s*\)/);
  });

  it("status enum includes 'withdrawn' as distinct from 'revoked'", () => {
    expect(migration).toMatch(/status\s+text NOT NULL DEFAULT 'pending' CHECK \(status IN \('pending', 'accepted', 'declined', 'revoked', 'withdrawn'\)\)/);
  });
});

describe('0193: withdraw_recruiter_invitation closes the pending-invite deadlock (PR #47 review finding #1)', () => {
  it('exists, is SECURITY DEFINER, and search_path-locked', () => {
    const fn = withdrawFn();
    expect(fn).not.toBe('');
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
  });

  it('authorizes only recruiter_id -- never the invited organizer/provider, never an unrelated caller', () => {
    const fn = withdrawFn();
    expect(fn).toMatch(/IF v_partnership\.recruiter_id\s*<>\s*v_uid THEN\s*\n\s*RAISE EXCEPTION 'Not authorized to withdraw this invitation'/);
    // No reference to organizer_id or service_providers as a grant of
    // authority anywhere in this function -- only recruiter_id gates it.
    expect(fn).not.toMatch(/organizer_id\s*=\s*v_uid/);
    expect(fn).not.toMatch(/service_providers/);
  });

  it('only a pending invitation can be withdrawn', () => {
    const fn = withdrawFn();
    expect(fn).toMatch(/IF v_partnership\.status\s*<>\s*'pending' THEN\s*\n\s*RAISE EXCEPTION 'Only a pending invitation can be withdrawn/);
  });

  it("sets status = 'withdrawn', never 'revoked' or 'declined' (keeps the two end-states distinct per the CHECK constraint)", () => {
    const fn = withdrawFn();
    expect(fn).toMatch(/SET status = 'withdrawn', updated_at = now\(\)/);
  });

  it('is granted to authenticated only, revoked from PUBLIC/anon', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.withdraw_recruiter_invitation\(uuid\) FROM PUBLIC, anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.withdraw_recruiter_invitation\(uuid\) TO authenticated;/);
  });

  it('withdrawn rows fall outside both partial unique indexes (scoped to status=\'pending\'), so a corrected invite can be resent', () => {
    // Already asserted above that both indexes are WHERE status = 'pending' --
    // this test just makes the deadlock-fix connection explicit: a
    // 'withdrawn' row can never collide with that partial index.
    expect(migration).toMatch(/WHERE status = 'pending' AND organizer_id IS NOT NULL/);
    expect(migration).toMatch(/WHERE status = 'pending' AND provider_id IS NOT NULL/);
  });
});

describe('0193: revoke_recruiter_partnership authorization branches (PR #47 review finding #3)', () => {
  it('is a party-or-admin check: recruiter, organizer, provider-side user, or is_admin()', () => {
    const fn = revokeFn();
    expect(fn).toMatch(/v_is_party\s*:=\s*\(v_uid\s*=\s*v_partnership\.recruiter_id\)/);
    expect(fn).toMatch(/OR\s*\(v_partnership\.organizer_id\s*=\s*v_uid\)/);
    expect(fn).toMatch(/sp\.user_id\s*=\s*v_uid/);
    expect(fn).toMatch(/OR public\.is_admin\(\)/);
  });

  it('rejects a non-party, non-admin caller', () => {
    const fn = revokeFn();
    expect(fn).toMatch(/IF NOT v_is_party THEN\s*\n\s*RAISE EXCEPTION 'Not authorized to revoke this partnership'/);
  });

  it('only an accepted partnership can be revoked -- unchanged from the original review (preserves the existing flow)', () => {
    const fn = revokeFn();
    expect(fn).toMatch(/IF v_partnership\.status\s*<>\s*'accepted' THEN\s*\n\s*RAISE EXCEPTION 'Only an accepted partnership can be revoked/);
  });
});

describe('0193: admin_set_recruiter_status -- real, admin-only moderation (PR #47 review finding #2)', () => {
  it('exists, is SECURITY DEFINER, and search_path-locked', () => {
    const fn = adminSetStatusFn();
    expect(fn).not.toBe('');
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
  });

  it('is gated on is_admin() internally, not merely on the EXECUTE grant', () => {
    const fn = adminSetStatusFn();
    expect(fn).toMatch(/IF NOT public\.is_admin\(\) THEN\s*\n\s*RAISE EXCEPTION 'Not authorized'/);
  });

  it('validates the target status against the same active/suspended enum as the table CHECK', () => {
    const fn = adminSetStatusFn();
    expect(fn).toMatch(/IF p_status NOT IN \('active', 'suspended'\) THEN/);
  });

  it('register_as_recruiter never writes status -- suspension/reinstatement is admin_set_recruiter_status-only', () => {
    const registerFn = migration.match(/CREATE OR REPLACE FUNCTION public\.register_as_recruiter\([\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(registerFn).not.toMatch(/status\s*=/);
  });

  it('is granted to authenticated (authorization is enforced inside the function, matching is_admin() usage elsewhere in this file)', () => {
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_set_recruiter_status\(uuid, text\) TO authenticated;/);
  });
});

describe('0193: recruiters_select_partner is scoped to live partnerships only (PR #47 review finding #4)', () => {
  it("only grants partner visibility while status is 'pending' or 'accepted', not forever", () => {
    const policy = migration.match(/CREATE POLICY recruiters_select_partner ON public\.recruiters[\s\S]*?;/)?.[0] ?? '';
    expect(policy).not.toBe('');
    expect(policy).toMatch(/rp\.status IN \('pending', 'accepted'\)/);
  });
});

describe('0193: multi-account self-dealing limitation is documented for Stage 2 (PR #47 review finding #5)', () => {
  it('records the sock-puppet-account gap and the controls Stage 2 must decide on before payout ships', () => {
    expect(migration).toMatch(/Known limitation: multi-account self-dealing/);
    expect(migration).toMatch(/becomes a real control gap the moment Stage\s*\n-- 2 adds commission computation\/payout/);
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
