// Read-only mode for Vercel Preview builds that share production data.
//
// Installed on the Supabase client only when the build-time constant
// __VENTS_PREVIEW_READ_ONLY__ is true (see previewMode.ts and
// src/lib/supabase.ts). Production and native builds compile that constant
// to `false`, so none of this runs or ships there.
//
// A blocked call never reaches the network: it resolves to the client's
// normal `{ data: null, error }` shape, so each screen shows its existing
// error state. This prevents accidental writes during review; it is not a
// security boundary (the anon key is public, so RLS and the server-side
// guard in api/_lib/previewGuard.ts remain the enforcement).

import type { SupabaseClient } from '@supabase/supabase-js';

export const PREVIEW_READ_ONLY_MESSAGE =
  'Disabled in Preview: this deployment uses production data and is read-only.';

/**
 * The only RPCs a read-only preview may call. Each was checked against its
 * live production definition (2026-10-30) for direct AND indirect writes:
 * the function and every function it calls, transitively, contain no
 * INSERT/UPDATE/DELETE/MERGE/TRUNCATE, ON CONFLICT DO UPDATE, PERFORM,
 * dynamic EXECUTE, dblink, pg_net, pg_notify, sequence or set_config call.
 *
 * Deliberately NOT allowed although they look like reads, because they
 * write: get_my_wallet (creates a wallet row), get_my_vc_balance (expires
 * VENTS Cents and debits the balance), heartbeat_presence (last_active_at),
 * and check_auth_rate_limit, get_nearby_service_providers,
 * search_users_for_request, validate_promo_code (rate-limit rows).
 */
export const PREVIEW_ALLOWED_RPCS: ReadonlySet<string> = new Set([
  // STABLE in production, no writes in the call graph.
  'admin_get_new_user_stats', 'admin_get_user_vc_summary', 'admin_get_vc_aggregates',
  'admin_get_vc_pool_status', 'admin_get_verification_stats', 'admin_list_service_bookings',
  'admin_pending_request_count', 'ai_entitlement_enforced', 'check_signups_enabled',
  'get_account_status', 'get_ai_plans_public', 'get_door_stats', 'get_event_analytics',
  'get_event_attendees', 'get_event_ticket_stats', 'get_event_ticket_type_availability',
  'get_event_trending_scores', 'get_my_ai_entitlement', 'get_my_payment_requests',
  'get_my_wallet_transactions', 'get_organizer_events_overview', 'get_payment_request_details',
  'get_plans_overview', 'get_public_event_promotion_badges', 'get_recent_checkins',
  'get_recruiter_invite_target', 'get_scan_log', 'get_ticket_provenance',
  'search_events_fuzzy', 'search_services_fuzzy_filtered', 'vc_tier_and_multiplier_for_user',
  // VOLATILE in production but read-only by inspection (same transitive check).
  'admin_health_ping', 'admin_list_action_requests', 'admin_list_organizer_verifications',
  'admin_list_pending_payouts', 'check_user_exists', 'generate_ticket_token',
  'get_event_online_access', 'is_email_verified', 'my_latest_organizer_verification',
  'my_latest_service_provider_verification', 'resolve_username_to_email', 'search_direct_messages',
  // Migration 0201 (not in production yet): STABLE, no writes, helpers STABLE.
  'admin_get_event_profit_candidate', 'admin_get_vents_earn_overview',
  'get_my_referral_confirmations', 'get_my_representative_rewards',
]);

const BLOCKED_TABLE_METHODS = ['insert', 'update', 'upsert', 'delete'] as const;
const BLOCKED_STORAGE_FILE_METHODS = [
  'upload', 'update', 'move', 'copy', 'remove', 'uploadToSignedUrl', 'createSignedUploadUrl',
] as const;
const BLOCKED_STORAGE_BUCKET_METHODS = ['createBucket', 'updateBucket', 'deleteBucket', 'emptyBucket'] as const;
// Signing in and out of an existing account stays allowed; anything that
// creates, confirms, recovers or changes an account does not.
export const BLOCKED_AUTH_METHODS = [
  'signUp', 'signInWithOtp', 'signInWithOAuth', 'signInAnonymously', 'verifyOtp', 'resend',
  'resetPasswordForEmail', 'updateUser', 'reauthenticate', 'linkIdentity', 'unlinkIdentity',
] as const;

export function previewBlockedError(operation: string) {
  return {
    name: 'PreviewReadOnlyError',
    message: PREVIEW_READ_ONLY_MESSAGE,
    code: 'PREVIEW_READ_ONLY',
    details: operation,
    hint: '',
    status: 403,
  };
}

/**
 * A stand-in for a PostgREST builder: any chained call (`.select()`,
 * `.eq()`, `.single()`, ...) returns it again, and awaiting it resolves to
 * `{ data: null, error }` -- or rejects, after `.throwOnError()`, as the
 * real builder would. No request is made.
 */
export function blockedQuery(operation: string, rejects = false): any {
  const error = previewBlockedError(operation);
  const result = { data: null, error, count: null, status: 403, statusText: 'Preview read-only' };
  const settled = rejects ? Promise.reject(Object.assign(new Error(error.message), error)) : Promise.resolve(result);
  settled.catch(() => {}); // only the caller's await should observe it
  const proxy: any = new Proxy(function blocked() {}, {
    get(_target, prop) {
      if (prop === 'then') return settled.then.bind(settled);
      if (prop === 'catch') return settled.catch.bind(settled);
      if (prop === 'finally') return settled.finally.bind(settled);
      if (prop === 'throwOnError') return () => blockedQuery(operation, true);
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function warn(operation: string) {
  console.warn(`[preview read-only] blocked ${operation}`);
}

/** Puts the client into read-only mode. Idempotent. */
export function installPreviewReadOnlyGuard(client: SupabaseClient): void {
  const c = client as any;
  if (c.__previewReadOnly) return;
  c.__previewReadOnly = true;

  const from = c.from.bind(c);
  c.from = (relation: string) => {
    const builder = from(relation);
    for (const m of BLOCKED_TABLE_METHODS) {
      builder[m] = () => { warn(`${m} on ${relation}`); return blockedQuery(`${m} ${relation}`); };
    }
    return builder;
  };

  const rpc = c.rpc.bind(c);
  c.rpc = (fn: string, args?: unknown, options?: unknown) => {
    if (PREVIEW_ALLOWED_RPCS.has(fn)) return rpc(fn, args, options);
    warn(`rpc ${fn}`);
    return blockedQuery(`rpc ${fn}`);
  };

  // Reads go through other schemas only if a caller asks for one; none do
  // today, so any schema() call is refused outright.
  c.schema = (schema: string) => { warn(`schema ${schema}`); return { from: () => blockedQuery(`schema ${schema}`), rpc: () => blockedQuery(`schema ${schema}`) }; };

  const storage = c.storage;
  const storageFrom = storage.from.bind(storage);
  storage.from = (bucket: string) => {
    const api = storageFrom(bucket);
    for (const m of BLOCKED_STORAGE_FILE_METHODS) {
      api[m] = async () => { warn(`storage ${m} in ${bucket}`); return { data: null, error: previewBlockedError(`storage ${m} ${bucket}`) }; };
    }
    return api;
  };
  for (const m of BLOCKED_STORAGE_BUCKET_METHODS) {
    storage[m] = async () => { warn(`storage ${m}`); return { data: null, error: previewBlockedError(`storage ${m}`) }; };
  }

  const blockedInvoke = async (name: string) => {
    warn(`function ${name}`);
    return { data: null, error: previewBlockedError(`function ${name}`) };
  };
  Object.defineProperty(c, 'functions', { configurable: true, get: () => ({ invoke: blockedInvoke }) });

  for (const m of BLOCKED_AUTH_METHODS) {
    c.auth[m] = async () => {
      warn(`auth ${m}`);
      return { data: { user: null, session: null }, error: previewBlockedError(`auth ${m}`) };
    };
  }
}
