import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// SCOPE OF THESE TESTS — read before trusting them.
//
// Static analysis of the shipped migration SQL, matching the house pattern
// (serviceProviderKyc.security.test.ts, organizerPayoutSecurity.security.test.ts,
// walletRefundFeeLedger.security.test.ts). There is NO live Postgres harness
// in this repo, so:
//
//   VERIFIED  — the authorization gate, policy, grant, index or log write is
//               literally present in the SQL that ships.
//   NOT VERIFIED — that Postgres enforces it at runtime for a real
//               Root/Admin/Sub-Admin JWT. That requires an integration
//               environment this repo does not have.
//
// Role behavior below is therefore asserted as "the gate that decides this
// role's outcome is present and is the correct one", not as an executed
// permission check.

const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const fnBody = (sql: string, name: string) =>
  sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*\\n?;`))?.[0] ?? '';

let m81: string, m82: string, m83: string, m84: string, m85: string, m86: string, m88: string, m89: string;
let m65: string, m11: string, m12: string, dash: string;

beforeAll(() => {
  m81 = read('0081_admin_wallet_visibility.sql');
  m82 = read('0082_harden_event_featuring.sql');
  m83 = read('0083_app_config_rpc_and_lockdown.sql');
  m84 = read('0084_payout_finalization_audit.sql');
  m85 = read('0085_atomic_request_decisions.sql');
  m86 = read('0086_dual_control_case_wiring.sql');
  m88 = read('0088_referral_rate_limit_and_vc_dedup.sql');
  m89 = read('0089_admin_ledger_read_foundations.sql');
  m65 = read('0065_user_wallets.sql');
  m11 = read('0011_grants.sql');
  m12 = read('0012_fix_default_table_grants.sql');
  dash = readFileSync(join(__dirname, '..', 'app', 'components', 'AdminDashboardScreen.tsx'), 'utf8');
});

// ─────────────────────────────────────────────────────────────────────
describe('P0-1 wallet visibility (0081): admins can READ, nobody can MUTATE', () => {
  it('adds admin SELECT policies on both wallet tables', () => {
    expect(m81).toMatch(/CREATE POLICY user_wallets_admin_select ON public\.user_wallets\s*\n\s*FOR SELECT TO authenticated USING \(public\.is_admin\(\)\);/);
    expect(m81).toMatch(/CREATE POLICY user_wallet_transactions_admin_select ON public\.user_wallet_transactions\s*\n\s*FOR SELECT TO authenticated USING \(public\.is_admin\(\)\);/);
  });

  it('normal-user own-row reads are unchanged: the 0065 policies are not dropped or altered', () => {
    expect(m81).not.toMatch(/DROP POLICY[\s\S]*user_wallets_own_read/);
    expect(m81).not.toMatch(/DROP POLICY[\s\S]*user_wallet_transactions_own_read/);
    // The original own-row policies still stand as written in 0065.
    expect(m65).toMatch(/CREATE POLICY user_wallets_own_read ON public\.user_wallets FOR SELECT TO authenticated\s*\n\s*USING \(user_id = \(SELECT auth\.uid\(\)\)\);/);
  });

  it('both new RPCs are is_admin()-gated and read-only', () => {
    for (const name of ['admin_get_wallet_aggregates', 'admin_get_user_wallet']) {
      const fn = fnBody(m81, name);
      expect(fn, `${name} not found`).not.toBe('');
      expect(fn).toMatch(/IF NOT public\.is_admin\(\) THEN RAISE EXCEPTION 'Admin access required'; END IF;/);
      expect(fn).toMatch(/STABLE SECURITY DEFINER/);
      expect(fn).toMatch(/SET search_path TO ''/);
    }
  });

  it('NO admin balance-mutation capability is introduced anywhere in this pass', () => {
    // Explicitly out of scope: crediting/debiting a customer wallet needs its
    // own dual-controlled, audited flow. Assert no migration in this pass
    // writes to user_wallets outside the read RPCs.
    for (const [name, sql] of Object.entries({ m81, m82, m83, m84, m85, m86, m88, m89 })) {
      expect(sql, `${name} must not write user_wallets`).not.toMatch(/UPDATE public\.user_wallets/);
      expect(sql, `${name} must not insert user_wallet_transactions`).not.toMatch(/INSERT INTO public\.user_wallet_transactions/);
    }
  });

  it('admin drill-down does not lazily create a wallet row (reading must not write)', () => {
    const fn = fnBody(m81, 'admin_get_user_wallet');
    expect(fn).not.toMatch(/INSERT INTO public\.user_wallets/);
  });

  it('pagination is clamped server-side, mirroring get_my_wallet_transactions', () => {
    expect(m81).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 100\)/);
  });

  it('anon cannot execute either RPC', () => {
    for (const name of ['admin_get_wallet_aggregates', 'admin_get_user_wallet']) {
      const grant = m81.match(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}[^;]*;`))?.[0] ?? '';
      expect(grant).toContain('authenticated');
      expect(grant).not.toContain('anon');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('P0-2/P0-3 event featuring (0082 + 0086): Sub-Admin blocked directly, works via queue', () => {
  it('Sub-Admin CANNOT execute directly: the gate is is_super_admin(), not is_admin()', () => {
    const fn = fnBody(m82, 'admin_set_event_featured');
    expect(fn).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(fn).not.toMatch(/IF NOT public\.is_admin\(\) THEN/);
  });

  it('Admin/Root CAN still execute: is_super_admin() is root OR role=admin (0004 definition unchanged)', () => {
    const m04 = read('0004_functions.sql');
    expect(m04).toMatch(/CREATE OR REPLACE FUNCTION public\.is_super_admin\(\)[\s\S]*?SELECT public\.is_root\(\)\s*\n\s*OR EXISTS \(SELECT 1 FROM public\.users WHERE id = auth\.uid\(\) AND role = 'admin'\);/);
  });

  it('existing featuring behavior is preserved: duration bounds, both branches, audit log', () => {
    const fn = fnBody(m82, 'admin_set_event_featured');
    expect(fn).toMatch(/p_duration_days <= 0 OR p_duration_days > 90/);
    expect(fn).toMatch(/UPDATE public\.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;/);
    expect(fn).toMatch(/UPDATE public\.events SET is_featured = false, featured_until = NULL WHERE id = p_event_id;/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
  });

  it('the dual-control escape hatch now EXISTS — this is the half that was missing', () => {
    expect(m86).toMatch(/WHEN 'toggle_event_featured'\s+THEN PERFORM public\.admin_set_event_featured\(/);
  });

  it('the queued action carries direction and duration so approval can reconstruct intent', () => {
    expect(m86).toMatch(/COALESCE\(\(r\.payload->>'featured'\)::boolean, false\)/);
    expect(m86).toMatch(/COALESCE\(\(r\.payload->>'duration_days'\)::integer, 14\)/);
    expect(dash).toMatch(/payload: \{ featured: nextFeatured, duration_days: nextFeatured \? 14 : null \}/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('P0-3 dead queue (0086): every action_type the client submits has an executor', () => {
  const clientTypes = (sql: string) =>
    [...sql.matchAll(/submitOrExecute\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const caseTypes = (sql: string) =>
    [...sql.matchAll(/WHEN '([a-z_]+)'\s+THEN PERFORM/g)].map((m) => m[1]);

  it('no client-submitted action_type is missing from approve_admin_action CASE', () => {
    const submitted = new Set(clientTypes(dash));
    const mapped = new Set(caseTypes(m86));
    const orphans = [...submitted].filter((t) => !mapped.has(t));
    expect(orphans, `orphaned action types would queue then fail at approval: ${orphans.join(', ')}`).toEqual([]);
  });

  it("the frontend no longer submits the unmapped 'restore_event' string", () => {
    expect(dash).toMatch(/submitOrExecute\('restore_deleted_event'/);
    expect(dash).not.toMatch(/submitOrExecute\('restore_event'/);
  });

  it("a 'restore_event' alias branch still exists so already-queued requests are not stranded", () => {
    expect(m86).toMatch(/WHEN 'restore_event'\s+THEN PERFORM public\.admin_restore_deleted_event\(r\.target_id\);/);
  });

  it('request_admin_action now rejects unmapped action types at SUBMIT time', () => {
    const fn = fnBody(m86, 'request_admin_action');
    expect(fn).toMatch(/IF p_action_type NOT IN \(/);
    expect(fn).toMatch(/RAISE EXCEPTION 'Unknown action_type: % \(no executor is mapped for it\)'/);
  });

  it('the submit-time whitelist and the CASE list agree exactly (no drift)', () => {
    const fn = fnBody(m86, 'request_admin_action');
    const whitelist = new Set(
      [...(fn.match(/IF p_action_type NOT IN \(([\s\S]*?)\) THEN/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    );
    const mapped = new Set(caseTypes(m86));
    expect([...whitelist].filter((t) => !mapped.has(t)), 'whitelisted but unmapped').toEqual([]);
    expect([...mapped].filter((t) => !whitelist.has(t)), 'mapped but not whitelisted').toEqual([]);
  });

  it('approval still requires is_super_admin(), so a Sub-Admin cannot approve their own request', () => {
    const fn = fnBody(m86, 'approve_admin_action');
    expect(fn).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(fn).toMatch(/IF r\.status <> 'pending' THEN RAISE EXCEPTION 'Request already %'/);
    expect(fn).toMatch(/FOR UPDATE/);
  });

  it('all 17 pre-existing CASE branches are preserved', () => {
    for (const t of [
      'organizer_verification_approve', 'organizer_verification_reject', 'hide_event',
      'reinstate_event', 'soft_delete_event', 'restore_deleted_event', 'set_user_role',
      'suspend_user', 'unsuspend_user', 'soft_delete_user', 'reinstate_user',
      'toggle_user_verified', 'credit_vents_cents', 'debit_vents_cents',
      'approve_payout', 'reject_payout', 'cancel_payout',
    ]) {
      expect(m86, `lost branch ${t}`).toMatch(new RegExp(`WHEN '${t}'\\s+THEN PERFORM`));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('P0-4 app_config (0083): Root-only, audited, and no silent no-op', () => {
  it('the RPC is Root-gated — matching the existing app_config_root_update policy, not loosened', () => {
    const fn = fnBody(m83, 'admin_update_app_config');
    expect(fn).toMatch(/IF NOT public\.is_root\(\) THEN/);
    // Must NOT have been relaxed to is_super_admin(), which would newly admit Admins.
    expect(fn).not.toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
  });

  it('an unauthorized caller gets a real exception, not a silent success', () => {
    const fn = fnBody(m83, 'admin_update_app_config');
    expect(fn).toMatch(/RAISE EXCEPTION 'Root access required to change platform configuration/);
    expect(dash).toMatch(/const \{ error \} = await supabase\.rpc\('admin_update_app_config'[\s\S]*?if \(error\) throw error;/);
  });

  it('every high-blast-radius kill switch is covered by the whitelist', () => {
    const fn = fnBody(m83, 'admin_update_app_config');
    for (const f of ['maintenance_mode', 'disable_purchases', 'disable_scanning', 'disable_signups', 'disable_payouts', 'disable_location_sharing']) {
      expect(fn, `missing field ${f}`).toMatch(new RegExp(`WHEN '${f}' THEN`));
    }
  });

  it('the field list is a structural whitelist — no dynamic SQL', () => {
    const fn = fnBody(m83, 'admin_update_app_config');
    expect(fn).toMatch(/RAISE EXCEPTION 'Unknown or non-updatable app_config field: %'/);
    expect(fn).not.toMatch(/EXECUTE format/);
    expect(fn).not.toMatch(/EXECUTE '/);
  });

  it('every change is audited server-side with field, old value and new value', () => {
    const fn = fnBody(m83, 'admin_update_app_config');
    expect(fn).toMatch(/INSERT INTO public\.admin_logs \(admin_id, action, target_user_id, details, actor_role\)/);
    expect(fn).toMatch(/jsonb_build_object\('field', p_field, 'old_value', v_oldval, 'new_value', v_newval\)/);
    expect(fn).toMatch(/public\.actor_role\(\)/);
  });

  it('direct client writes are revoked, so the RPC is the only write path', () => {
    expect(m83).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.app_config FROM anon, authenticated;/);
    expect(dash).not.toMatch(/from\('app_config'\)\.update/);
  });

  it('READS are completely unaffected for every role', () => {
    expect(m83).toMatch(/GRANT SELECT ON public\.app_config TO anon, authenticated;/);
    expect(m83).not.toMatch(/DROP POLICY[\s\S]*app_config_read_all/);
    // The feature-flag read paths still select normally.
    expect(dash).toMatch(/from\('app_config'\)\.select\(/);
  });

  it('VC economy fields are range-validated (P1-1)', () => {
    const fn = fnBody(m83, 'admin_update_app_config');
    expect(fn).toMatch(/vc_max_redemption_pct must be between 0 and 100/);
    expect(fn).toMatch(/vc_naira_per_1000 must be between 1 and 1000000/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('P0-5 payout finalization (0084): both terminal transitions are audited', () => {
  it('complete_organizer_payout logs actor, previous status, new status and amount', () => {
    const fn = fnBody(m84, 'complete_organizer_payout');
    expect(fn).toMatch(/INSERT INTO public\.admin_logs \(admin_id, action, target_user_id, details, actor_role\)/);
    expect(fn).toMatch(/'complete_payout'/);
    expect(fn).toMatch(/'previous_status', v_status/);
    expect(fn).toMatch(/'new_status', 'completed'/);
    expect(fn).toMatch(/COALESCE\(public\.actor_role\(\), 'system:project_admin'\)/);
  });

  it('fail_organizer_payout logs the reason and the amount restored to balance', () => {
    const fn = fnBody(m84, 'fail_organizer_payout');
    expect(fn).toMatch(/'fail_payout'/);
    expect(fn).toMatch(/'reason', p_reason/);
    expect(fn).toMatch(/'amount_restored_to_balance_kobo', v_amount_kobo/);
  });

  it('idempotent no-op paths are NOT logged (webhook retries must not bury real transitions)', () => {
    for (const name of ['complete_organizer_payout', 'fail_organizer_payout']) {
      const fn = fnBody(m84, name);
      // Exactly one admin_logs insert per function.
      expect((fn.match(/INSERT INTO public\.admin_logs/g) ?? []).length, name).toBe(1);
      // And it sits after the ROW_COUNT guard.
      const guardIdx = fn.indexOf('GET DIAGNOSTICS v_rows = ROW_COUNT;');
      const logIdx = fn.indexOf('INSERT INTO public.admin_logs');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(logIdx).toBeGreaterThan(guardIdx);
    }
  });

  it('existing payout logic is preserved exactly (guards, ledger row, wallet math)', () => {
    const c = fnBody(m84, 'complete_organizer_payout');
    expect(c).toMatch(/IF v_status = 'completed' THEN/);
    expect(c).toMatch(/WHERE id = v_id AND public\.organizer_withdrawal_requests\.status IN \('pending', 'processing'\)/);
    expect(c).toMatch(/total_withdrawn_kobo = COALESCE\(total_withdrawn_kobo, 0\) \+ v_amount_kobo/);
    expect(c).toMatch(/INSERT INTO public\.organizer_transactions/);
    const f = fnBody(m84, 'fail_organizer_payout');
    expect(f).toMatch(/IF v_status IN \('completed', 'failed', 'rejected'\) THEN/);
    expect(f).toMatch(/balance_kobo = balance_kobo \+ v_amount_kobo/);
  });

  it('remains unreachable from any client session', () => {
    expect(m84).toMatch(/REVOKE EXECUTE ON FUNCTION public\.complete_organizer_payout\(text\) FROM PUBLIC, anon, authenticated;/);
    expect(m84).toMatch(/REVOKE EXECUTE ON FUNCTION public\.fail_organizer_payout\(text, text\) FROM PUBLIC, anon, authenticated;/);
    const grants = m84.match(/GRANT EXECUTE ON FUNCTION public\.(complete|fail)_organizer_payout[^;]*;/g) ?? [];
    expect(grants.length).toBe(2);
    for (const g of grants) expect(g).not.toMatch(/\bauthenticated\b|\banon\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('P0-6/P0-7 request decisions (0085): atomic, authorized, audited', () => {
  it('admin_decide_organizer_request requires is_super_admin()', () => {
    const fn = fnBody(m85, 'admin_decide_organizer_request');
    expect(fn).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
  });

  it('it claims the request atomically — no check-then-act window', () => {
    const fn = fnBody(m85, 'admin_decide_organizer_request');
    expect(fn).toMatch(/UPDATE public\.organizer_requests[\s\S]*?WHERE id = p_request_id\s*\n\s*AND status = 'pending'\s*\n\s*RETURNING user_id INTO v_user_id;/);
    expect(fn).toMatch(/IF v_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Request not found or already reviewed';/);
  });

  it('status update AND role grant happen in ONE transaction (the old two-step bug)', () => {
    const fn = fnBody(m85, 'admin_decide_organizer_request');
    expect(fn).toMatch(/PERFORM public\.admin_set_user_role\(v_user_id, 'organizer'\);/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
  });

  it('approving a stale request cannot DEMOTE an account that is now admin/sub-admin', () => {
    const fn = fnBody(m85, 'admin_decide_organizer_request');
    expect(fn).toMatch(/IF v_prior_role = 'attendee' THEN/);
  });

  it('the frontend no longer does the raw two-step update + separate role RPC', () => {
    expect(dash).not.toMatch(/from\('organizer_requests'\)\s*\n?\s*\.update\(/);
    expect(dash).toMatch(/submitOrExecute\('decide_organizer_request'/);
    expect(dash).toMatch(/supabase\.rpc\('admin_decide_organizer_request' as any/);
  });

  it('service provider KYC decision is now atomic too', () => {
    const fn = fnBody(m85, 'admin_decide_service_provider_request');
    expect(fn).toMatch(/UPDATE public\.service_provider_requests[\s\S]*?WHERE id = p_request_id AND status = 'pending'\s*\n\s*RETURNING user_id, business_name, provider_type INTO v_user_id, v_business, v_type;/);
    expect(fn).toMatch(/IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;/);
  });

  it('service provider gate and side effects are preserved unchanged', () => {
    const fn = fnBody(m85, 'admin_decide_service_provider_request');
    expect(fn).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN RAISE EXCEPTION 'Admin access required'; END IF;/);
    expect(fn).toMatch(/UPDATE public\.users SET is_service_provider = true WHERE id = v_user_id;/);
    expect(fn).toMatch(/INSERT INTO public\.notifications/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
  });

  it('both decisions are reachable through the maker-checker queue', () => {
    expect(m86).toMatch(/WHEN 'decide_organizer_request' THEN PERFORM public\.admin_decide_organizer_request\(/);
    expect(m86).toMatch(/WHEN 'decide_service_provider_request' THEN PERFORM public\.admin_decide_service_provider_request\(/);
    expect(dash).toMatch(/submitOrExecute\('decide_service_provider_request'/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('P1-2 referral rate limiting (0088)', () => {
  it('reuses the existing check_rate_limit mechanism, keyed by user AND ip', () => {
    const fn = fnBody(m88, 'complete_referral');
    expect(fn).toMatch(/PERFORM public\.check_rate_limit\('complete_referral:' \|\| v_referred_id::text, 5, 3600\);/);
    expect(fn).toMatch(/PERFORM public\.check_rate_limit\('complete_referral:ip:' \|\| public\.client_ip\(\), 20, 3600\);/);
  });

  it('limits sit after the auth check but before the code lookup oracle', () => {
    const fn = fnBody(m88, 'complete_referral');
    const authIdx = fn.indexOf("'Not authenticated'");
    const rlIdx = fn.indexOf('check_rate_limit');
    const lookupIdx = fn.indexOf('WHERE upper(substr(id::text, 1, 8))');
    expect(authIdx).toBeLessThan(rlIdx);
    expect(rlIdx).toBeLessThan(lookupIdx);
  });

  it('a single legitimate referral is unaffected (limit is 5/hr against a once-ever call)', () => {
    const fn = fnBody(m88, 'complete_referral');
    expect(fn).toMatch(/'success', true, 'awarded_to_you', 150, 'referrer_pending', 300/);
    expect(fn).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'referral' DO NOTHING/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('P1-3 VC earn dedup (0088): retries can no longer double-award', () => {
  it('creates the partial unique index the ON CONFLICT clause needs', () => {
    expect(m88).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_earn_dedup_idx\s*\n\s*ON public\.vc_transactions \(user_id, reference_id\)\s*\n\s*WHERE \(type = 'earn' AND reference_id IS NOT NULL\);/);
  });

  it("excludes NULL reference_id so claim_profile_bonus's one-off earn is untouched", () => {
    expect(m88).toMatch(/reference_id IS NOT NULL/);
    const m04 = read('0004_functions.sql');
    const fn = m04.match(/CREATE OR REPLACE FUNCTION public\.claim_profile_bonus[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    // It inserts without reference_id, so it is outside the index predicate.
    expect(fn).toMatch(/INSERT INTO public\.vc_transactions \(user_id, amount, type, status, earned_at\)/);
  });

  it('admin credits remain unlimited: each uses a fresh uuid reference_id', () => {
    const m04 = read('0004_functions.sql');
    const fn = m04.match(/CREATE OR REPLACE FUNCTION public\.admin_credit_vents_cents[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    expect(fn).toMatch(/'earn', 'active', gen_random_uuid\(\)/);
  });

  it('pre-existing duplicates are collapsed BEFORE the unique index is built', () => {
    const dedupIdx = m88.indexOf('$dedup$');
    const createIdx = m88.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_earn_dedup_idx');
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(dedupIdx).toBeLessThan(createIdx);
    expect(m88).toMatch(/row_number\(\)\s+OVER \(PARTITION BY t\.user_id, t\.reference_id\s*\n\s*ORDER BY t\.earned_at ASC, t\.id ASC\)\s+AS rn/);
    expect(m88).toMatch(/WHERE r\.rn > 1/);
  });

  it('cleanup reverses the wallet credit those duplicates caused (no silent balance drift)', () => {
    // trg_vc_wallet_sync is AFTER INSERT only, so DELETE will not reverse it.
    // The debit applies the clamped, actually-reclaimable figure — see
    // vcDedupCleanup.security.test.ts for the full archive/accounting suite.
    expect(m88).toMatch(/UPDATE public\.vents_wallets w\s*\n\s*SET balance\s+= GREATEST\(0, w\.balance - r\.reclaimed\)::integer/);
    expect(m88).toMatch(/FILTER \(WHERE a\.was_credited\)/);
    expect(m88).toMatch(/'vc_earn_duplicate_cleanup'/);
  });

  it('every removed row is archived first, and the reclaim accounting is honest', () => {
    expect(m88).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_earn_duplicate_archive \(/);
    expect(m88).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_earn_duplicate_reclaim \(/);
    const archiveIdx = m88.indexOf('INSERT INTO public.vc_earn_duplicate_archive');
    const deleteIdx = m88.indexOf('DELETE FROM public.vc_transactions');
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(archiveIdx).toBeLessThan(deleteIdx);
    // The old, dishonest summary key is gone.
    expect(m88).not.toMatch(/vc_reclaimed_from_balances/);
    expect(m88).toMatch(/'vc_actually_reclaimed',\s+v_reclaimed/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('P1-4/P1-5 read foundations (0089): read-only and grounded in real columns', () => {
  it('both RPCs are admin-gated, STABLE, and never write', () => {
    for (const name of ['admin_list_service_bookings', 'admin_get_financial_aggregates']) {
      const fn = fnBody(m89, name);
      expect(fn, `${name} missing`).not.toBe('');
      expect(fn).toMatch(/STABLE SECURITY DEFINER/);
      expect(fn).toMatch(/IF NOT public\.is_admin(_or_root)?\(\) THEN RAISE EXCEPTION 'Admin access required'; END IF;/);
      expect(fn).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
    }
  });

  it('service booking listing is bounded and filterable', () => {
    const fn = fnBody(m89, 'admin_list_service_bookings');
    expect(fn).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 200\)/);
    expect(fn).toMatch(/\(p_status\s+IS NULL OR b\.status = p_status\)/);
    expect(fn).toMatch(/\(p_provider_id IS NULL OR b\.provider_id = p_provider_id\)/);
  });

  it('aggregates convert tickets.amount from naira, matching confirm_ticket_payment', () => {
    const fn = fnBody(m89, 'admin_get_financial_aggregates');
    expect(fn).toMatch(/sum\(round\(t\.amount \* 100\)\)/);
  });

  it('no invented ticket platform-fee metric is reported', () => {
    const fn = fnBody(m89, 'admin_get_financial_aggregates');
    expect(fn).not.toMatch(/1\.05/);
    expect(fn).not.toMatch(/ticket_fee_kobo/);
    // Service fee IS reported, because fee_kobo is a real stored column.
    expect(fn).toMatch(/sum\(b\.fee_kobo\)/);
  });

  it('VC points are reported separately and never summed into a naira figure', () => {
    const fn = fnBody(m89, 'admin_get_financial_aggregates');
    expect(fn).toMatch(/vc_circulation bigint/);
    expect(fn).not.toMatch(/vc_circulation_kobo/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('cross-cutting: no accidental permission broadening in this pass', () => {
  it('every new SECURITY DEFINER function pins search_path', () => {
    for (const [name, sql] of Object.entries({ m81, m82, m83, m84, m85, m86, m88, m89 })) {
      const defs = sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$function\$/g) ?? [];
      for (const d of defs) {
        if (/SECURITY DEFINER/.test(d)) {
          expect(/SET search_path TO/.test(d), `${name}: SECURITY DEFINER without search_path`).toBe(true);
        }
      }
    }
  });

  it('no new function grants EXECUTE to anon', () => {
    for (const [name, sql] of Object.entries({ m81, m83, m85, m89 })) {
      const grants = sql.match(/GRANT EXECUTE ON FUNCTION[^;]*;/g) ?? [];
      for (const g of grants) {
        expect(g.includes('anon'), `${name}: ${g}`).toBe(false);
      }
    }
  });

  it('no migration in this pass re-grants the app_config or admin_logs write access it removed', () => {
    expect(m83).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^;]*ON public\.app_config TO (anon|authenticated)/);
    // 0011/0012 are the historical broad grants this pass narrows; assert
    // they are the only place those appear, and that we did not re-add them.
    expect(m11).toMatch(/GRANT DELETE, INSERT, SELECT, UPDATE ON public\.app_config TO authenticated;/);
    expect(m12).toMatch(/GRANT DELETE, INSERT, SELECT, UPDATE ON public\.app_config TO authenticated;/);
  });

  it('no admin RPC in this pass accepts a caller-supplied actor/admin id', () => {
    for (const [name, sql] of Object.entries({ m81, m83, m85, m89 })) {
      expect(sql, `${name}`).not.toMatch(/p_admin_id|p_actor_id|p_actor_role/);
    }
  });
});
