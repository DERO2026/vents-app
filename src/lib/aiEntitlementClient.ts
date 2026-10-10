// Shared client-side read of the real VENTS AI entitlement -- the one
// place that decides "does this row actually grant access right now",
// so VentsAiUnlockedScreen and AiPlansScreen can't drift into disagreeing
// definitions of "real access" the way two independent copies of this
// logic eventually would. Mirrors check_and_reserve_ai_usage()'s own
// status/period/grace logic (supabase/migrations/0165_ai_subscription_
// foundation.sql) -- this is a read-only client-side mirror for display
// purposes only; the server's own check is the actual enforcement point
// and is never replaced by this.
export interface AiEntitlementRow {
  plan_id: string | null;
  status: string;
  period_end?: string | null;
  grace_until?: string | null;
  used_units?: number;
  included_units?: number;
  hard_ceiling?: number;
}

export function resolveHasRealAiAccess(ent: AiEntitlementRow | null): boolean {
  if (!ent || !ent.plan_id || ent.status === 'inactive') return false;
  if (ent.status === 'expired' || ent.status === 'canceled') return false;
  if (ent.status !== 'trialing' && ent.status !== 'active' && ent.status !== 'grace') return false;
  const periodEndPassed = !!ent.period_end && new Date(ent.period_end).getTime() < Date.now();
  if (periodEndPassed && (!ent.grace_until || new Date(ent.grace_until).getTime() < Date.now())) return false;
  return true;
}
