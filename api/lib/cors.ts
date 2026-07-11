import type { VercelRequest, VercelResponse } from '@vercel/node';

// Explicit origin allowlist instead of '*'. A wildcard technically never
// blocked anything (it's maximally permissive), but it also means the
// browser refuses to send credentials/cookies on cross-origin requests and
// gives us no place to reason about "which origins can talk to this API" —
// this makes that explicit, as production hardening.
const ALLOWED_ORIGINS = ['https://getvents.com', 'https://www.getvents.com'];

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Vercel preview/branch deployments, e.g. https://vents-app-git-foo-team.vercel.app
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return true;
  // Local dev
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

/** Applies CORS headers for the given request, echoing the Origin only when
 * it's on the allowlist. Callers still handle the OPTIONS short-circuit
 * themselves (return 200) since that varies slightly by endpoint. */
export function applyCors(req: VercelRequest, res: VercelResponse, methods: string = 'POST, OPTIONS') {
  const origin = req.headers.origin as string | undefined;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
