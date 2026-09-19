import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, short-lived confirmation tokens for VENTS AI's Phase 2 (mutating)
// tools. The assistant never executes a consequential action (ticket
// transfer/refund, service booking, report) on its own tool-use turn --
// api/ai-assistant.ts instead returns a `{proposal, requiresConfirmation:
// true}` shape carrying one of these tokens, and only actually calls the
// real RPC/endpoint after the client re-POSTs with `confirmedAction`
// carrying that exact token back. This is what makes "confirm, then
// execute" actually enforceable server-side instead of just a client-side
// UI convention the client could skip: the token binds the action name AND
// its exact params AND the user id together, so a tampered or substituted
// confirmation (different ticket id, different amount, a different user's
// token replayed) fails verification rather than silently executing
// whatever the client sends at confirm time.
//
// Same env-var convention as ANTHROPIC_API_KEY in api/extract-events.ts:
// server-only, read from process.env, never VITE_-prefixed (a VITE_ var
// gets inlined into the public client bundle by Vite at build time).
// Document AI_CONFIRMATION_SECRET alongside ANTHROPIC_API_KEY wherever this
// project's server env vars are documented/configured (e.g. the Vercel
// project's Environment Variables settings) -- it is not read from any
// .env.local checked into the repo.

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getSecret(): string {
  const secret = process.env.AI_CONFIRMATION_SECRET;
  if (!secret) {
    throw new Error('AI_CONFIRMATION_SECRET not configured on server');
  }
  return secret;
}

// Stable stringify: params keys are sorted so the same logical params object
// always signs/verifies identically regardless of property insertion order
// (JSON.stringify is otherwise order-dependent, which would make a
// semantically-identical params object fail signature verification purely
// because of key order).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function buildPayload(action: string, params: unknown, userId: string, expiresAt: number): string {
  return `${action}|${userId}|${expiresAt}|${stableStringify(params)}`;
}

/** Mints a confirmation token for one specific action+params+userId, expiring in TOKEN_TTL_MS. */
export function createConfirmationToken(action: string, params: unknown, userId: string): string {
  const secret = getSecret();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = buildPayload(action, params, userId, expiresAt);
  const sig = sign(payload, secret);
  const body = Buffer.from(JSON.stringify({ action, params, userId, expiresAt })).toString('base64url');
  return `${body}.${sig}`;
}

/**
 * Verifies a confirmation token against the action+params+userId being
 * confirmed right now. Rejects on: malformed token, bad signature, expiry,
 * or a mismatch between what the token was minted for and what's being
 * confirmed -- this last check is what prevents a client from showing the
 * user one proposal (e.g. a small refund) but sending a confirmedAction for
 * a different one (e.g. a larger refund, or a different ticket) using a
 * token minted for something else entirely.
 */
export function verifyConfirmationToken(
  token: string,
  action: string,
  params: unknown,
  userId: string
): { ok: true } | { ok: false; reason: string } {
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return { ok: false, reason: 'server not configured' };
  }

  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2) return { ok: false, reason: 'malformed token' };
  const [body, sig] = parts;

  let decoded: { action: string; params: unknown; userId: string; expiresAt: number };
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed token' };
  }

  const expectedPayload = buildPayload(decoded.action, decoded.params, decoded.userId, decoded.expiresAt);
  const expectedSig = sign(expectedPayload, secret);

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, reason: 'invalid signature' };
  }

  if (Date.now() > decoded.expiresAt) {
    return { ok: false, reason: 'token expired' };
  }

  if (decoded.action !== action) {
    return { ok: false, reason: 'action mismatch' };
  }
  if (decoded.userId !== userId) {
    return { ok: false, reason: 'user mismatch' };
  }
  if (stableStringify(decoded.params) !== stableStringify(params)) {
    return { ok: false, reason: 'params mismatch' };
  }

  return { ok: true };
}
