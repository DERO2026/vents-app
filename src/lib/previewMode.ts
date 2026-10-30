// Build-time decision for Vercel Preview builds (used by vite.config.ts).
//
// Preview deployments currently share the production Supabase project, so a
// preview build runs the app read-only (see previewReadOnly.ts). The flags
// are compiled in as constants: production and native builds get `false`,
// so the preview-only code is dropped from their bundles entirely.

// Public identifier of the production project; not a secret.
export const PRODUCTION_SUPABASE_REF = 'slrtjxtzhowhwhebjprv';

export interface PreviewFlags {
  /** A Vercel Preview build (PostHog stays off). */
  vercelPreview: boolean;
  /** A Vercel Preview build that is not positively pointed at another project. */
  readOnly: boolean;
}

export function computePreviewFlags(env: { VERCEL_ENV?: string; VITE_SUPABASE_URL?: string }): PreviewFlags {
  const vercelPreview = env.VERCEL_ENV === 'preview';
  const ref = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec((env.VITE_SUPABASE_URL || '').trim())?.[1];
  const otherProject = !!ref && ref !== PRODUCTION_SUPABASE_REF;
  return { vercelPreview, readOnly: vercelPreview && !otherProject };
}
