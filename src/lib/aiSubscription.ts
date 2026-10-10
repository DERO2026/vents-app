// VENTS AI subscription purchase -- real data layer for the paywall,
// reusing the exact same create-pending/Paystack-popup/server-verify
// architecture every other VENTS payment already uses (see
// supabase/migrations/0175_ai_subscription_payments.sql and
// api/webhook/paystack.ts's 'aisub_' branch). No client code here ever
// grants access itself -- every function either reads real server state
// or asks the server to verify a real Paystack transaction.

import { supabase, getAuthToken } from './supabase';
import { apiUrl } from './apiBase';

export interface AiPlanPublic {
  plan_id: string;
  label: string;
  included_units: number;
  hard_ceiling: number;
  price_kobo: number;
  currency: string;
  billing_period_days: number;
}

// Only ever returns plans that are active, purchasable, and have an
// approved price (get_ai_plans_public() itself enforces this server-side
// -- ai_pro and the trial plan can never appear here, whatever this
// client asks for).
export async function fetchAiPlansPublic(): Promise<AiPlanPublic[]> {
  const { data, error } = await supabase.rpc('get_ai_plans_public');
  if (error) throw error;
  return Array.isArray(data) ? (data as AiPlanPublic[]) : [];
}

export interface AiSubscriptionIntent {
  reference: string;
  amount_kobo: number;
  currency: string;
  plan_id: string;
  label: string;
}

// Records real purchase intent server-side (amount/plan locked in from
// ai_plans at this moment, never client-supplied) and returns a disposable
// reference for the Paystack popup. Throws plan_not_purchasable if the
// plan doesn't exist, isn't active/purchasable, or has no approved price
// (e.g. ai_pro) -- the caller should never reach this for such a plan
// (fetchAiPlansPublic already excludes it), but the server refuses it
// regardless of what the client sends.
export async function initiateAiSubscriptionPayment(planId: string): Promise<AiSubscriptionIntent> {
  const { data, error } = await supabase.rpc('initiate_ai_subscription_payment', { p_plan_id: planId });
  if (error) throw error;
  return data as AiSubscriptionIntent;
}

export type AiSubscriptionVerifyResult =
  | { status: 'success'; planId?: string }
  | { status: 'failed' | 'abandoned' | 'error'; error?: string };

// The one place that turns a Paystack popup "success" callback into an
// actual entitlement -- never trusts that callback alone. Hits the same
// api/webhook/paystack.ts?action=verify endpoint every other payment type
// in this app uses, which re-verifies the transaction directly with
// Paystack server-side before calling confirm_ai_subscription_payment
// (project_admin-only, not reachable from this client at all).
export async function verifyAiSubscriptionPayment(reference: string): Promise<AiSubscriptionVerifyResult> {
  const token = await getAuthToken();
  const res = await fetch(apiUrl('/api/webhook/paystack?action=verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ reference }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) return { status: 'error', error: 'Could not verify this payment. If you were charged, contact support with your reference.' };
  if (json.status === 'success') return { status: 'success', planId: json.planId };
  if (json.status === 'abandoned') return { status: 'abandoned' };
  if (json.status === 'failed') return { status: 'failed' };
  return { status: 'error', error: json.error || 'Could not verify this payment.' };
}
