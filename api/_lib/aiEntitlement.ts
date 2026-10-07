// VENTS Phase 4 -- AI subscription backend foundation. Server-authoritative
// entitlement + usage enforcement for the VENTS AI chat assistant
// (api/_lib/aiAssistantHandler.ts ONLY -- see check_and_reserve_ai_usage's
// own comment in the migration for why extraction/vision are a separate,
// unwired surface bucket rather than sharing this enforcement).
//
// Both RPCs this module calls (ai_entitlement_enforced excepted) are
// reachable ONLY via the trusted project_admin Postgres connection
// (api/_lib/projectAdminDb.ts) -- there is no anon/authenticated EXECUTE
// grant on check_and_reserve_ai_usage or start_ai_trial at all (see
// supabase/migrations/0165_ai_subscription_foundation.sql), so a client
// calling the public REST RPC endpoint directly gets a permission error,
// never a usable response -- the only path to these functions is this
// server code, which always supplies the already-verified session's own
// user id, never anything a client can influence.
import { callProjectAdminRpc } from './projectAdminDb.js';

export type AiSurface = 'chat' | 'extraction' | 'vision';

export class AiEntitlementError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// Monetization gate, NOT a cost-safety gate -- see the migration's own
// comment on app_config.ai_entitlement_enforced for why this fails OPEN
// (enforcement off) rather than closed on any error, unlike isAiDisabled.
// Every real cost control (kill switch, rate limits, caps, caching) is
// completely independent of this flag and stays enforced either way.
export async function isAiEntitlementEnforced(authHeader: string): Promise<boolean> {
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!baseUrl || !anonKey) return false;
  try {
    const res = await fetch(`${baseUrl}/rest/v1/rpc/ai_entitlement_enforced`, {
      method: 'POST',
      headers: { Authorization: authHeader, apikey: anonKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return false;
    const value = await res.json().catch(() => false);
    return value === true;
  } catch {
    return false;
  }
}

// Atomically verifies the user's entitlement is active and within its
// period, then reserves one usage unit against it -- see
// check_and_reserve_ai_usage() in the migration for the actual atomicity
// (row lock + single-statement upsert) that makes this safe against two
// concurrent requests both trying to consume the last unit. Throws
// AiEntitlementError with a stable `code` the caller can map to an HTTP
// response; any other thrown error is an unexpected infra failure, not a
// legitimate "not entitled" outcome.
export async function checkAndReserveAiUsage(userId: string, surface: AiSurface): Promise<{
  allowed: true;
  plan_id: string;
  status: string;
  used_units: number;
  included_units: number;
  hard_ceiling: number;
  over_included: boolean;
}> {
  try {
    return await callProjectAdminRpc('check_and_reserve_ai_usage', [userId, surface]);
  } catch (err: any) {
    const message = String(err?.message || '');
    const knownCodes = ['no_entitlement', 'entitlement_inactive', 'entitlement_expired', 'plan_not_found', 'usage_ceiling_exceeded'];
    const matched = knownCodes.find((c) => message.includes(c));
    if (matched) throw new AiEntitlementError(matched);
    throw err;
  }
}

// One-time, account-bound trial grant -- see start_ai_trial() in the
// migration for why trial_used can never be reset through any
// authenticated-reachable path. Throws AiEntitlementError('trial_already_used')
// if this account has already consumed its trial.
export async function startAiTrial(userId: string): Promise<{ plan_id: string; status: string; included_units: number; hard_ceiling: number }> {
  try {
    return await callProjectAdminRpc('start_ai_trial', [userId]);
  } catch (err: any) {
    const message = String(err?.message || '');
    if (message.includes('trial_already_used')) throw new AiEntitlementError('trial_already_used');
    if (message.includes('trial_plan_not_configured')) throw new AiEntitlementError('trial_plan_not_configured');
    throw err;
  }
}
