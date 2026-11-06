// Vercel Preview safety guard.
//
// Preview deployments of this project currently share the PRODUCTION
// Supabase project (no separate Preview database exists), so a reviewer
// clicking through a preview could otherwise confirm payments, credit
// wallets, start Paystack transfers/refunds or send real push/email/SMS
// against real users. This guard refuses those operations on a Vercel
// Preview deployment unless the deployment is positively configured with a
// different Supabase project and no live Paystack key.
//
// Production is untouched: everything here returns early unless
// VERCEL_ENV === 'preview' (Vercel sets 'production' on production
// deployments; native builds and local development never set 'preview').
// Error messages name the offending variable, never its value.

import type { VercelResponse } from '@vercel/node';

// Public identifier of the production project (it is in every browser
// bundle); not a secret.
export const PRODUCTION_SUPABASE_REF = 'slrtjxtzhowhwhebjprv';

export const PREVIEW_BLOCKED_MESSAGE =
  'Disabled in Preview: this deployment uses production data and is read-only.';

type Env = Record<string, string | undefined>;

/** https://<ref>.supabase.co -> <ref>, else null. */
export function supabaseRefFromUrl(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec((url || '').trim());
  return m ? m[1] : null;
}

/**
 * The project ref inside a Postgres connection string: the pooler user
 * (`<role>.<ref>@...pooler.supabase.com`) or the direct host
 * (`@db.<ref>.supabase.co`). Null when neither form is present.
 */
export function supabaseRefFromDbUrl(dbUrl: string | undefined): string | null {
  const s = (dbUrl || '').trim();
  const pooler = /^postgres(?:ql)?:\/\/[^.:@/]+\.([a-z0-9]{20})[:@]/.exec(s);
  if (pooler) return pooler[1];
  const direct = /@db\.([a-z0-9]{20})\.supabase\.co[:/]/.exec(s);
  return direct ? direct[1] : null;
}

/**
 * Why a dangerous operation must be refused on this deployment, or null
 * when it may run. Fails closed: on Preview, anything not positively shown
 * to be a non-production database blocks.
 */
export function previewBlockReason(env: Env = process.env): string | null {
  if (env.VERCEL_ENV !== 'preview') return null;

  const urlRef = supabaseRefFromUrl(env.VITE_SUPABASE_URL);
  if (!urlRef) return 'VITE_SUPABASE_URL is missing or not a recognisable Supabase project URL';
  if (urlRef === PRODUCTION_SUPABASE_REF) return 'VITE_SUPABASE_URL is the production Supabase project';

  if (env.PROJECT_ADMIN_DATABASE_URL) {
    const dbRef = supabaseRefFromDbUrl(env.PROJECT_ADMIN_DATABASE_URL);
    if (!dbRef) return 'PROJECT_ADMIN_DATABASE_URL does not name a recognisable Supabase project';
    if (dbRef === PRODUCTION_SUPABASE_REF) return 'PROJECT_ADMIN_DATABASE_URL is the production Supabase project';
    if (dbRef !== urlRef) return 'PROJECT_ADMIN_DATABASE_URL and VITE_SUPABASE_URL point at different projects';
  }

  if ((env.PAYSTACK_SECRET_KEY || '').trim().startsWith('sk_live_')) {
    return 'PAYSTACK_SECRET_KEY is a live key';
  }
  return null;
}

export class PreviewBlockedError extends Error {
  constructor(operation: string, reason: string) {
    super(`${PREVIEW_BLOCKED_MESSAGE} (${operation}: ${reason})`);
    this.name = 'PreviewBlockedError';
  }
}

/** Throws before any external call or database write when blocked. */
export function assertPreviewSafe(operation: string, env: Env = process.env): void {
  const reason = previewBlockReason(env);
  if (reason) throw new PreviewBlockedError(operation, reason);
}

/**
 * For HTTP handlers: when blocked, answers 503 and returns true so the
 * caller returns immediately. Call it after CORS/OPTIONS handling so the
 * browser can read the refusal.
 */
export function refuseInPreview(res: VercelResponse, operation: string, env: Env = process.env): boolean {
  const reason = previewBlockReason(env);
  if (!reason) return false;
  console.warn(`[preview-guard] refused ${operation}: ${reason}`);
  res.status(503).json({ error: PREVIEW_BLOCKED_MESSAGE, preview_read_only: true });
  return true;
}
