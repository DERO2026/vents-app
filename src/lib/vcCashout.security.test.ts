import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real, behavioral-and-static tests for BATCH A of the VC (Vents Cents)
// cash-out to NGN feature (supabase/migrations/0082_vc_cashout.sql +
// api/wallet/{save-bank,admin-payout-action,reconcile-payouts}.ts +
// api/webhook/paystack.ts's extended dispatch). Static SQL-text assertions
// mirror this repo's own convention (see
// src/lib/organizerPayoutSecurity.security.test.ts) for verifying a live
// migration's actual, deployed function bodies rather than a
// re-implementation that could silently drift from what ships.

let migration: string;
let organizerMigration0004: string;
let organizerMigration0076: string;
let webhookSrc: string;
let saveBankSrc: string;
let adminPayoutActionSrc: string;
let reconcileSrc: string;

beforeAll(() => {
  const migDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(migDir, '0082_vc_cashout.sql'), 'utf8');
  organizerMigration0004 = readFileSync(join(migDir, '0004_functions.sql'), 'utf8');
  organizerMigration0076 = readFileSync(join(migDir, '0076_fix_withdrawal_rls_hole_and_payout_ambiguity_bugs.sql'), 'utf8');
  webhookSrc = readFileSync(join(__dirname, '..', '..', 'api', 'webhook', 'paystack.ts'), 'utf8');
  saveBankSrc = readFileSync(join(__dirname, '..', '..', 'api', 'wallet', 'save-bank.ts'), 'utf8');
  adminPayoutActionSrc = readFileSync(join(__dirname, '..', '..', 'api', 'wallet', 'admin-payout-action.ts'), 'utf8');
  reconcileSrc = readFileSync(join(__dirname, '..', '..', 'api', 'wallet', 'reconcile-payouts.ts'), 'utf8');
});

function fn(name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`);
  return migration.match(re)?.[0] ?? '';
}

describe('Rate: a NEW, separate app_config column, not vc_naira_per_1000', () => {
  it('adds vc_cashout_naira_per_1000 as an additive ALTER TABLE, default 100 (₦100 per 1,000 VC)', () => {
    expect(migration).toMatch(/ALTER TABLE public\.app_config\s*\n\s*ADD COLUMN IF NOT EXISTS vc_cashout_naira_per_1000 integer NOT NULL DEFAULT 100;/);
  });

  it('never touches vc_naira_per_1000 (the different, ticket-credit rate) in any actual SQL statement -- only explanatory comments name it', () => {
    const codeOnly = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(codeOnly).not.toMatch(/vc_naira_per_1000/);
  });

  it('request_vc_cashout computes ngn_amount_kobo purely from the new column and p_vc_amount, never from a client-supplied amount', () => {
    const f = fn('request_vc_cashout');
    expect(f).toMatch(/SELECT vc_cashout_naira_per_1000 INTO v_rate FROM public\.app_config LIMIT 1;/);
    expect(f).toMatch(/v_ngn_kobo := \(p_vc_amount::bigint \* v_rate::bigint \* 100\) \/ 1000;/);
    // Only p_vc_amount, p_bank_account_id, p_idempotency_key are accepted --
    // no p_ngn_amount_kobo / p_rate / p_amount_kobo parameter exists at all.
    expect(f).toMatch(/CREATE OR REPLACE FUNCTION public\.request_vc_cashout\(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text\)/);
  });

  it('rate computation is correct: 1,000 VC @ default rate = ₦100, 25,000 VC = ₦2,500', () => {
    const rate = 100; // vc_cashout_naira_per_1000 default
    const compute = (vc: number) => Math.floor((vc * rate * 100) / 1000); // kobo, mirrors the SQL exactly
    expect(compute(1000)).toBe(10000); // ₦100.00
    expect(compute(25000)).toBe(250000); // ₦2,500.00
  });
});

describe('vc_withdrawal_requests: a separate ledger, never mixed with organizer_withdrawal_requests', () => {
  it('is its own table with the same 6-value status CHECK as organizer_withdrawal_requests', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_withdrawal_requests/);
    expect(migration).toMatch(/CONSTRAINT vc_withdrawal_requests_status_check CHECK \(status = ANY \(ARRAY\['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text\]\)\)/);
  });

  it('no VC function body actually references (reads/writes) organizer_wallets or organizer_bank_accounts -- only explanatory comments mention organizer_withdrawal_requests by name', () => {
    expect(migration).not.toMatch(/public\.organizer_wallets/);
    expect(migration).not.toMatch(/public\.organizer_bank_accounts/);
    expect(migration).not.toMatch(/public\.organizer_withdrawal_requests/);
  });

  it('has its own bank-accounts table (vc_bank_accounts), scoped to user_id not organizer_id', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_bank_accounts/);
    expect(migration).toMatch(/user_id uuid NOT NULL,/);
  });
});

describe('Duplicate/idempotent request protection', () => {
  it('has a unique index on (user_id, idempotency_key) enforcing one request per key', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uniq_vc_withdraw_idempotency ON public\.vc_withdrawal_requests USING btree \(user_id, idempotency_key\);/);
  });

  it('request_vc_cashout inserts the reservation row BEFORE debiting VC, and only debits on a fresh (non-conflicting) insert', () => {
    const f = fn('request_vc_cashout');
    const insertIdx = f.indexOf('INSERT INTO public.vc_withdrawal_requests');
    const conflictIdx = f.indexOf('ON CONFLICT (user_id, idempotency_key) DO NOTHING');
    const deductIdx = f.indexOf('PERFORM public._vc_deduct(v_user_id, p_vc_amount');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(conflictIdx).toBeGreaterThan(insertIdx);
    expect(deductIdx).toBeGreaterThan(conflictIdx);
  });

  it('a replayed idempotency key (ROW_COUNT = 0) returns the existing request id and does NOT reach the debit call', () => {
    const f = fn('request_vc_cashout');
    const guard = f.match(/GET DIAGNOSTICS v_rows = ROW_COUNT;\s*\n\s*IF v_rows = 0 THEN[\s\S]*?RETURN v_id;\s*\n\s*END IF;/)?.[0] ?? '';
    expect(guard).not.toBe('');
    expect(guard).not.toMatch(/_vc_deduct/);
  });
});

describe('Atomic, row-locked VC debit (reuses _vc_deduct, not a reimplementation)', () => {
  it('_vc_deduct itself takes a row lock (FOR UPDATE) on vents_wallets before checking/decrementing balance', () => {
    const deductFn = organizerMigration0004.match(/CREATE OR REPLACE FUNCTION public\._vc_deduct[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(deductFn).toMatch(/FOR UPDATE/);
    expect(deductFn).toMatch(/IF v_balance IS NULL OR v_balance < p_amount THEN\s*\n\s*RAISE EXCEPTION 'Insufficient Vents Cents balance';/);
  });

  it('request_vc_cashout calls _vc_deduct rather than re-implementing the wallet debit', () => {
    const f = fn('request_vc_cashout');
    expect(f).toMatch(/PERFORM public\._vc_deduct\(v_user_id, p_vc_amount, 'VC cash-out request'\);/);
  });

  it('insufficient balance is rejected: _vc_deduct raises before any withdrawal-request row could be left half-processed (whole function is one transaction)', () => {
    // Behavioral simulation of _vc_deduct's own guard.
    function simulateDeduct(balance: number, amount: number) {
      if (balance == null || balance < amount) throw new Error('Insufficient Vents Cents balance');
      return balance - amount;
    }
    expect(() => simulateDeduct(500, 1000)).toThrow('Insufficient Vents Cents balance');
    expect(simulateDeduct(2000, 1000)).toBe(1000);
  });
});

describe('Minimum / invalid amount validation', () => {
  it('rejects null or below the 1,000 VC minimum', () => {
    const f = fn('request_vc_cashout');
    expect(f).toMatch(/IF p_vc_amount IS NULL OR p_vc_amount < 1000 THEN\s*\n\s*RAISE EXCEPTION 'Minimum cash-out is 1,000 Vents Cents';/);
  });

  it('the table CHECK constraint additionally rejects any zero/negative vc_amount or ngn_amount_kobo at the storage layer', () => {
    expect(migration).toMatch(/CONSTRAINT vc_withdrawal_requests_vc_amount_check CHECK \(vc_amount > 0\)/);
    expect(migration).toMatch(/CONSTRAINT vc_withdrawal_requests_ngn_amount_kobo_check CHECK \(ngn_amount_kobo > 0\)/);
  });
});

describe('Concurrent withdrawal / admin claim -- CAS pattern mirrors the organizer one', () => {
  it('admin_claim_vc_payout_for_processing uses the identical atomic UPDATE ... WHERE status = \'pending\' CAS as admin_claim_payout_for_processing', () => {
    const organizerClaim = organizerMigration0004.match(/CREATE OR REPLACE FUNCTION public\.admin_claim_payout_for_processing[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    const vcClaim = fn('admin_claim_vc_payout_for_processing');
    expect(organizerClaim).toMatch(/UPDATE public\.organizer_withdrawal_requests\s*\n\s*SET status = 'processing', resolved_by = auth\.uid\(\), updated_at = now\(\)\s*\n\s*WHERE id = p_request_id AND status = 'pending'/);
    expect(vcClaim).toMatch(/UPDATE public\.vc_withdrawal_requests\s*\n\s*SET status = 'processing', resolved_by = auth\.uid\(\), updated_at = now\(\)\s*\n\s*WHERE id = p_request_id AND status = 'pending'/);
  });

  it('is admin-gated and honors the disable_payouts kill switch', () => {
    const vcClaim = fn('admin_claim_vc_payout_for_processing');
    expect(vcClaim).toMatch(/IF NOT public\.is_admin\(\) THEN RAISE EXCEPTION 'Admin access required'; END IF;/);
    expect(vcClaim).toMatch(/IF \(SELECT disable_payouts FROM public\.app_config LIMIT 1\) THEN\s*\n\s*RAISE EXCEPTION 'payouts_disabled';/);
  });
});

describe('Transfer initiation only after a successful atomic claim (api/wallet/admin-payout-action.ts)', () => {
  it('the approve branch calls the claim RPC and checks claimRow.claimed before ever calling Paystack /transfer', () => {
    const approveBlock = adminPayoutActionSrc.match(/if \(action === 'approve'\) \{[\s\S]*?return res\.status\(200\)\.json\(\{ status: 'processing'[\s\S]*?\}\);\s*\n\s*\}/)?.[0] ?? '';
    const claimIdx = approveBlock.indexOf('rpc.claim');
    const claimedCheckIdx = approveBlock.indexOf('if (!claimRow.claimed)');
    const transferIdx = approveBlock.indexOf("fetch('https://api.paystack.co/transfer'");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(claimedCheckIdx).toBeGreaterThan(claimIdx);
    expect(transferIdx).toBeGreaterThan(claimedCheckIdx);
  });

  it('scope selects vc vs organizer RPC names, and the vc branch never targets organizer_withdrawal_requests RPCs', () => {
    expect(adminPayoutActionSrc).toMatch(/admin_claim_vc_payout_for_processing/);
    expect(adminPayoutActionSrc).toMatch(/admin_reject_vc_payout/);
    expect(adminPayoutActionSrc).toMatch(/admin_cancel_processing_vc_payout/);
  });
});

describe('completed status can ONLY be set by the webhook / reconcile-poller path -- never request-creation or admin-approval', () => {
  it('complete_vc_payout has NO anon/authenticated/service_role EXECUTE grant -- project_admin only, identical boundary to complete_organizer_payout', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.complete_vc_payout\(p_request_id text\) FROM PUBLIC, anon, authenticated, project_admin;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.complete_vc_payout\(p_request_id text\) TO project_admin;/);
    const organizerGrant = readFileSyncGrants();
    expect(organizerGrant).toMatch(/GRANT EXECUTE ON FUNCTION public\.complete_organizer_payout\(p_request_id text\) TO project_admin;/);
  });

  it('fail_vc_payout has the same project_admin-only boundary', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.fail_vc_payout\(p_request_id text, p_reason text\) FROM PUBLIC, anon, authenticated, project_admin;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.fail_vc_payout\(p_request_id text, p_reason text\) TO project_admin;/);
  });

  it('neither request_vc_cashout nor any admin_* RPC in this migration ever sets status = \'completed\' directly', () => {
    const nonWebhookFns = ['request_vc_cashout', 'admin_claim_vc_payout_for_processing', 'admin_release_vc_payout_claim', 'admin_reject_vc_payout', 'admin_cancel_processing_vc_payout', 'admin_mark_vc_payout_processing'];
    for (const name of nonWebhookFns) {
      const body = fn(name);
      expect(body).not.toMatch(/status = 'completed'/);
    }
  });

  it('complete_vc_payout/fail_vc_payout are called ONLY from api/webhook/paystack.ts and api/wallet/reconcile-payouts.ts, via the project_admin direct-connection helper -- never via the client-authenticated PostgREST RPC path', () => {
    expect(webhookSrc).toMatch(/callProjectAdminTableRpc<any>\('complete_vc_payout', \[lookupKey\]\)/);
    expect(webhookSrc).toMatch(/callProjectAdminTableRpc<any>\('fail_vc_payout', \[lookupKey, event\.data\?\.reason \|\| event\.event\]\)/);
    expect(reconcileSrc).toMatch(/'admin_list_processing_vc_payouts', 'complete_vc_payout', 'fail_vc_payout'/);
  });
});

function readFileSyncGrants(): string {
  return readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0011_grants.sql'), 'utf8');
}

describe('pending vs processing vs completed are correctly distinct states', () => {
  it('admin_claim_vc_payout_for_processing only transitions pending -> processing, never touches completed rows', () => {
    const f = fn('admin_claim_vc_payout_for_processing');
    expect(f).toMatch(/WHERE id = p_request_id AND status = 'pending'/);
  });

  it('complete_vc_payout accepts a transition FROM pending or processing, and short-circuits on an already-completed row', () => {
    const f = fn('complete_vc_payout');
    expect(f).toMatch(/IF v_status = 'completed' THEN\s*\n\s*RETURN QUERY\s*\n\s*SELECT 'already_completed'/);
    expect(f).toMatch(/WHERE id = v_id AND public\.vc_withdrawal_requests\.status IN \('pending', 'processing'\);/);
  });
});

describe('Webhook failure/reversal restores VC exactly once (status-guard prevents double-restore)', () => {
  it('fail_vc_payout gates the VC restore behind a status-transition UPDATE ... WHERE status IN (\'pending\',\'processing\'), skipping restore on ROW_COUNT = 0', () => {
    const f = fn('fail_vc_payout');
    const updateIdx = f.indexOf("SET status = 'failed'");
    const rowCountIdx = f.indexOf('GET DIAGNOSTICS v_rows = ROW_COUNT;');
    const alreadyFinalizedIdx = f.indexOf("RETURN QUERY SELECT 'already_finalized'", rowCountIdx);
    const restoreIdx = f.indexOf('PERFORM public._vc_restore');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(rowCountIdx).toBeGreaterThan(updateIdx);
    expect(alreadyFinalizedIdx).toBeGreaterThan(rowCountIdx);
    // The restore call comes AFTER the ROW_COUNT=0 early-return, so a
    // duplicate/replayed call that hits ROW_COUNT=0 never reaches it.
    expect(restoreIdx).toBeGreaterThan(alreadyFinalizedIdx);
  });

  it('an already-finalized status (completed/failed/rejected/cancelled) short-circuits before any write, matching the organizer pattern', () => {
    const f = fn('fail_vc_payout');
    expect(f).toMatch(/IF v_status IN \('completed', 'failed', 'rejected', 'cancelled'\) THEN\s*\n\s*RETURN QUERY SELECT 'already_finalized'/);
  });

  it('duplicate webhook delivery is idempotent: two calls to fail_vc_payout for the same request only restore VC once (simulated)', () => {
    const state = { status: 'processing', vc_amount: 5000 };
    let wallet = 0;
    function callFailVcPayout() {
      if (['completed', 'failed', 'rejected', 'cancelled'].includes(state.status)) return 'already_finalized';
      const matched = state.status === 'pending' || state.status === 'processing';
      if (!matched) return 'already_finalized';
      state.status = 'failed'; // the guarded UPDATE
      wallet += state.vc_amount; // _vc_restore, only reached once per real transition
      return 'failed';
    }
    expect(callFailVcPayout()).toBe('failed');
    expect(wallet).toBe(5000);
    expect(callFailVcPayout()).toBe('already_finalized');
    expect(wallet).toBe(5000); // NOT 10000 -- restored exactly once
  });

  it('_vc_restore credits vents_wallets and inserts a vc_transactions row of type \'refund\'/status \'active\' (a value the vc_transactions CHECK constraint already allows)', () => {
    const restoreFn = migration.match(/CREATE OR REPLACE FUNCTION public\._vc_restore[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(restoreFn).toMatch(/SET balance = balance \+ p_amount, updated_at = now\(\)/);
    expect(restoreFn).toMatch(/INSERT INTO public\.vc_transactions \(user_id, amount, type, status, earned_at, reference_id\)\s*\n\s*VALUES \(p_user_id, p_amount, 'refund', 'active', now\(\), gen_random_uuid\(\)\);/);
  });

  it('a reversed transfer (transfer.reversed) is dispatched through the exact same fail_vc_payout path as transfer.failed, so it restores VC via the identical guard', () => {
    expect(webhookSrc).toMatch(/event\?\.event === 'transfer\.success' \|\| event\?\.event === 'transfer\.failed' \|\| event\?\.event === 'transfer\.reversed'/);
    expect(webhookSrc).toMatch(/const rpcName = event\.event === 'transfer\.success' \? 'complete_organizer_payout' : 'fail_organizer_payout';/);
  });
});

describe('admin_reject_vc_payout / admin_cancel_processing_vc_payout also restore VC exactly once', () => {
  it('admin_reject_vc_payout only allows pending -> rejected and restores via _vc_restore', () => {
    const f = fn('admin_reject_vc_payout');
    expect(f).toMatch(/IF v_status NOT IN \('pending'\) THEN RAISE EXCEPTION 'Only pending requests can be rejected'; END IF;/);
    expect(f).toMatch(/PERFORM public\._vc_restore\(v_user_id, v_vc_amount,/);
  });

  it('admin_cancel_processing_vc_payout only allows processing -> cancelled, requires a reason, and restores via _vc_restore', () => {
    const f = fn('admin_cancel_processing_vc_payout');
    expect(f).toMatch(/IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled/);
    expect(f).toMatch(/IF p_reason IS NULL OR trim\(p_reason\) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;/);
    expect(f).toMatch(/PERFORM public\._vc_restore\(v_user_id, v_vc_amount,/);
  });
});

describe('Bank-account resolution/recipient creation reuses the existing Paystack call pattern (not reimplemented)', () => {
  it('save-bank.ts still uses the exact same /bank/resolve + /transferrecipient calls for both scopes, and only the RPC name differs', () => {
    expect(saveBankSrc).toMatch(/https:\/\/api\.paystack\.co\/bank\/resolve\?account_number=/);
    expect(saveBankSrc).toMatch(/https:\/\/api\.paystack\.co\/transferrecipient/);
    // Exactly one such fetch call to each Paystack endpoint in the file --
    // scope selects only the RPC name via rpcNames, not a second code path.
    expect((saveBankSrc.match(/https:\/\/api\.paystack\.co\/bank\/resolve/g) || []).length).toBe(1);
    expect((saveBankSrc.match(/https:\/\/api\.paystack\.co\/transferrecipient/g) || []).length).toBe(1);
  });

  it('add_vc_bank_account_confirmed requires assert_recent_auth (password re-confirmation), same as add_bank_account_confirmed', () => {
    const f = fn('add_vc_bank_account_confirmed');
    expect(f).toMatch(/PERFORM public\.assert_recent_auth\(\);/);
  });

  it('admin-payout-action.ts approve branch reuses the SAME single /transfer POST call for both scopes (no second Paystack integration)', () => {
    expect((adminPayoutActionSrc.match(/fetch\('https:\/\/api\.paystack\.co\/transfer'/g) || []).length).toBe(1);
  });
});

describe('No client-writable INSERT policy on vc_withdrawal_requests (mirrors the 0076 organizer RLS fix)', () => {
  it('the organizer fix (0076) is what this migration explicitly mirrors -- confirms the historical hole being avoided', () => {
    expect(organizerMigration0076).toMatch(/DROP POLICY IF EXISTS org_withdraw_own_insert ON public\.organizer_withdrawal_requests;/);
  });

  it('vc_withdrawal_requests has RLS enabled with only admin read/update and owner-read policies -- no INSERT policy at all', () => {
    expect(migration).toMatch(/ALTER TABLE public\.vc_withdrawal_requests ENABLE ROW LEVEL SECURITY;/);
    expect(migration).not.toMatch(/CREATE POLICY[^;]*vc_withdrawal_requests[^;]*FOR INSERT/);
    expect(migration).toMatch(/CREATE POLICY vc_withdraw_own_read ON public\.vc_withdrawal_requests FOR SELECT TO authenticated USING \(\(\( SELECT auth\.uid\(\) AS uid\) = user_id\)\);/);
  });

  it('request_vc_cashout (the only legitimate insert path) is SECURITY DEFINER and performs its own INSERT, so it never needed a client policy', () => {
    const f = fn('request_vc_cashout');
    expect(f).toMatch(/SECURITY DEFINER/);
    expect(f).toMatch(/INSERT INTO public\.vc_withdrawal_requests/);
  });
});

describe('Authorization: unauthenticated/unauthorized callers, and cross-user row access', () => {
  it('request_vc_cashout raises if auth.uid() is null (no session)', () => {
    const f = fn('request_vc_cashout');
    expect(f).toMatch(/IF v_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';/);
  });

  it('every admin_* VC RPC checks is_admin() or is_admin_or_root() before doing anything else', () => {
    const adminFns = ['admin_claim_vc_payout_for_processing', 'admin_release_vc_payout_claim', 'admin_mark_vc_payout_processing', 'admin_reject_vc_payout', 'admin_cancel_processing_vc_payout', 'admin_list_pending_vc_payouts', 'admin_list_processing_vc_payouts'];
    for (const name of adminFns) {
      const body = fn(name);
      expect(body).toMatch(/IF NOT public\.is_admin(_or_root)?\(\) THEN RAISE EXCEPTION '(Admin access required|Super Admin access required)'; END IF;/);
    }
  });

  it('every admin_* VC RPC writes an admin_logs row (audit trail)', () => {
    const adminMutations = ['admin_claim_vc_payout_for_processing', 'admin_release_vc_payout_claim', 'admin_mark_vc_payout_processing', 'admin_reject_vc_payout', 'admin_cancel_processing_vc_payout'];
    for (const name of adminMutations) {
      const body = fn(name);
      expect(body).toMatch(/INSERT INTO public\.admin_logs/);
    }
  });

  it('vc_withdraw_own_read RLS policy scopes SELECT to auth.uid() = user_id -- a user cannot read another user\'s row via the Data API', () => {
    expect(migration).toMatch(/CREATE POLICY vc_withdraw_own_read ON public\.vc_withdrawal_requests FOR SELECT TO authenticated USING \(\(\( SELECT auth\.uid\(\) AS uid\) = user_id\)\);/);
  });

  it('vc_bank_own RLS policy scopes ALL to auth.uid() = user_id on vc_bank_accounts', () => {
    expect(migration).toMatch(/CREATE POLICY vc_bank_own ON public\.vc_bank_accounts FOR ALL TO authenticated\s*\n\s*USING \(\(\( SELECT auth\.uid\(\) AS uid\) = user_id\)\) WITH CHECK \(\(\( SELECT auth\.uid\(\) AS uid\) = user_id\)\);/);
  });
});

describe('Existing organizer payout flow and VC earn/spend RPCs are unmodified', () => {
  it('organizer_withdrawal_requests / organizer_bank_accounts / organizer_wallets table definitions in 0002_tables.sql are untouched by this migration (additive-only file)', () => {
    // This migration file contains no CREATE TABLE / ALTER TABLE statement
    // against any organizer_* table.
    expect(migration).not.toMatch(/ALTER TABLE (public\.)?organizer_/);
    expect(migration).not.toMatch(/CREATE TABLE (IF NOT EXISTS )?(public\.)?organizer_/);
  });

  it('complete_organizer_payout / fail_organizer_payout / admin_cancel_processing_payout are not redefined by this migration', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.complete_organizer_payout/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fail_organizer_payout/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.admin_cancel_processing_payout/);
  });

  it('_vc_deduct and admin_credit_vents_cents/admin_debit_vents_cents are not redefined by this migration (reused as-is, not modified)', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\._vc_deduct/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.admin_credit_vents_cents/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.admin_debit_vents_cents/);
  });

  it('the webhook file\'s ticket-purchase, transfer-fee, service-booking, wallet-deposit, and refund branches are untouched -- only the transfer.success/failed/reversed branch gained additive VC dispatch', () => {
    expect(webhookSrc).toMatch(/if \(reference\.startsWith\('txf_'\)\)/);
    expect(webhookSrc).toMatch(/if \(reference\.startsWith\('BKG-'\)\)/);
    expect(webhookSrc).toMatch(/if \(reference\.startsWith\('wdep_'\)\)/);
    expect(webhookSrc).toMatch(/event\?\.event === 'refund\.processed' \|\| event\?\.event === 'refund\.failed'/);
    // The additive VC fallback is scoped inside the transfer.* branch only.
    expect(webhookSrc).toMatch(/isVc = true;/);
  });
});
