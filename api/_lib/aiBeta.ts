// Gate in front of VENTS AI chat. Originally (VENTS Phase 7) this called
// is_ai_beta_user() -- a single hand-seeded allowlist row, meant only to
// let a few testers generate traffic for Phase 5A's cost telemetry before
// any real subscription existed. That allowlist never grew and was never
// connected to the real entitlement system that shipped afterward
// (0165/0166 ai_entitlements, 0175 Paystack-verified purchases) -- so a
// genuine, paying, server-verified subscriber was still rejected here,
// because this check never looked at ai_entitlements at all. That was the
// production root cause of AI_BETA_RESTRICTED for every real customer.
//
// Fixed by calling has_ai_chat_access() instead (0176_ai_beta_gate_
// allows_real_entitlement.sql), which is true if EITHER the original
// beta allowlist says so (unchanged, still honors that one legacy
// account) OR the caller has a real, currently-valid ai_entitlements row
// (trialing/active/grace, same status+period/grace logic
// check_and_reserve_ai_usage() itself applies). A user with neither is
// still correctly rejected -- this is not "grant everyone access," it's
// "stop ignoring the subscription system this gate predates."
//
// Reachable only via the trusted project_admin Postgres connection (same
// pattern as isAiDisabled/checkAndReserveAiUsage) -- there is no
// anon/authenticated EXECUTE grant on has_ai_chat_access() at all, so
// this check can never be queried, let alone bypassed, by a client.
import { callProjectAdminRpc } from './projectAdminDb.js';

// Fail CLOSED: any error reaching or parsing the check (network hiccup,
// missing env var, unexpected response) is treated as "not approved",
// never as "approved". This mirrors isAiDisabled's own fail-closed
// reasoning (verifyAuth.ts) -- a gate whose purpose is to restrict access
// must never silently open on infra trouble. The safe default here is
// `false` (not approved), because approval is an allow-list, not a kill
// switch.
export async function isAiBetaUser(userId: string): Promise<boolean> {
  try {
    const result = await callProjectAdminRpc<boolean>('has_ai_chat_access', [userId]);
    return result === true;
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('has_ai_chat_access failed (fail-closed -> not approved):', err?.message || err);
    return false;
  }
}
