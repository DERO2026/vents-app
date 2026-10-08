// VENTS Phase 7 -- temporary, server-side AI beta allowlist. Exists ONLY
// to let a small number of explicitly-approved accounts generate real
// VENTS AI chat traffic so Phase 5A's telemetry can measure actual
// Anthropic cost (Phase 6 found zero production rows) -- this is a
// measurement gate, not the subscription system. It is deliberately
// independent of ai_entitlements/check_and_reserve_ai_usage/
// ai_entitlement_enforced: none of that is touched by this file, and
// this gate is removed (or widened) once real usage data exists, without
// needing to unwind anything about the entitlement foundation.
//
// Reachable only via the trusted project_admin Postgres connection (same
// pattern as isAiDisabled/checkAndReserveAiUsage) -- there is no
// anon/authenticated EXECUTE grant on is_ai_beta_user() at all (see
// supabase/migrations/0168_ai_beta_allowlist.sql), so this check can
// never be queried, let alone bypassed, by a client.
import { callProjectAdminRpc } from './projectAdminDb.js';

// Fail CLOSED: any error reaching or parsing the check (network hiccup,
// missing env var, unexpected response) is treated as "not approved",
// never as "approved". This mirrors isAiDisabled's own fail-closed
// reasoning (verifyAuth.ts) -- a gate whose purpose is to restrict access
// must never silently open on infra trouble. Unlike isAiDisabled, the
// safe default here is `false` (not approved) rather than `true`,
// because approval is an allow-list, not a kill switch.
export async function isAiBetaUser(userId: string): Promise<boolean> {
  try {
    const result = await callProjectAdminRpc<boolean>('is_ai_beta_user', [userId]);
    return result === true;
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('is_ai_beta_user failed (fail-closed -> not approved):', err?.message || err);
    return false;
  }
}
