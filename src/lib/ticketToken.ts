import { useState, useEffect } from 'react';
import { supabase } from './supabase';

// ─── Offline-first signed v2 pass token ──────────────────────────────────────
// A v2 pass is "<base64url(payload)>.<hmacSha256(payload)>", binding ticketId,
// eventId, purchaserId, issuedAt, expiresAt, nonce and version. It is minted
// server-side (generate_ticket_token / purchase_ticket_with_tokens); the signing
// secret never reaches the client. The scanner strictly rejects anything that
// isn't a valid v2 signature, so every QR we render MUST be a signed token.
//
// Design goals (why this file is offline-first + cache-seeded):
//   • After purchase the token is generated server-side WITH the ticket and
//     seeded into this cache synchronously, so the QR renders instantly and the
//     success screen never shows "Generating…".
//   • Opening any ticket reads the cached token synchronously (no null flash),
//     then refreshes in the background when online.
//   • Fully offline at the gate: the last-cached token persists in localStorage.
const TOKEN_CACHE_KEY = 'vents_ticket_token_cache_v2';

function readTokenCache(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(TOKEN_CACHE_KEY) || '{}'); } catch { return {}; }
}

/** Public: seed the cache with a server-generated token (called right after purchase). */
export function cacheTicketToken(ticketId: string | null | undefined, token: string | null | undefined): void {
  if (!ticketId || !token) return;
  try {
    const cache = readTokenCache();
    cache[ticketId] = token;
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(cache));
  } catch { /* storage unavailable — token just won't persist across sessions */ }
}

/** Read a cached token synchronously (offline-safe). */
export function getCachedTicketToken(ticketId: string | null | undefined): string | null {
  if (!ticketId) return null;
  return readTokenCache()[ticketId] || null;
}

// On a shared device, this cache otherwise keeps a signed-out user's ticket
// QR tokens sitting in localStorage indefinitely -- readable by anyone with
// devtools access to that browser, even after they've signed out. Call this
// on sign-out so the next person to sign in on the same device starts with
// nothing of the previous user's left behind.
export function clearTicketTokenCache(): void {
  try { localStorage.removeItem(TOKEN_CACHE_KEY); } catch { /* storage unavailable */ }
}

// ─── Token freshness (root cause of the "multiple QR flash" bug) ────────────
// generate_ticket_token mints a genuinely NEW nonce + signature on every
// call -- it is not idempotent and does not return the same value for an
// already-valid ticket. verify_entry_pass (the scanner's verification RPC)
// accepts ANY validly-signed, non-expired token for a ticket; minting a new
// one never invalidates an older one. So there was zero correctness benefit
// to re-minting on every mount, only cost: useSignedTicketToken's background
// refresh used to call mintToken() unconditionally every time a component
// using it mounted (QRTicket, PaymentSuccessScreen -- both independently, on
// the same ticket, during the same purchase->success->ticket-detail
// journey). Each mint produces a different nonce, so the QR's encoded value
// visibly changed and the canvas repainted -- the exact "multiple different
// QR codes flash" symptom. Tokens are valid for ~2 days (see
// generate_ticket_token's v_expires), so there was never a need to refresh
// that often. Fixed by only minting when the cached token is missing,
// unparseable, or genuinely close to expiring -- a comfortably-valid cached
// token is now left alone and never silently swapped out from under the
// user.
const MIN_TOKEN_VALIDITY_MS = 12 * 60 * 60 * 1000; // refresh once under 12h of validity remains

/** Decode a v2 signed token's payload WITHOUT verifying its signature -- the
 * signing secret never reaches the client, so this can only ever be used for
 * client-side freshness/expiry decisions, never as a trust boundary. The
 * server (verify_entry_pass) remains the sole authority on validity. */
export function decodeTokenPayload(token: string | null | undefined): { expiresAt?: string; ticketId?: string; nonce?: string } | null {
  if (!token) return null;
  const seg1 = token.split('.')[0];
  if (!seg1) return null;
  try {
    const padded = seg1.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (seg1.length % 4)) % 4);
    const json = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** Whether a token is missing, unparseable, or within MIN_TOKEN_VALIDITY_MS
 * of expiring -- i.e. whether it's worth spending a mint call on. A
 * comfortably-valid token returns false so it is left displayed untouched. */
export function needsRefresh(token: string | null | undefined, minValidityMs = MIN_TOKEN_VALIDITY_MS): boolean {
  const payload = decodeTokenPayload(token);
  if (!payload?.expiresAt) return true;
  const expiresAt = new Date(payload.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() < minValidityMs;
}

// Mint one token with a couple of quick retries (transient network / cold auth).
async function mintToken(ticketId: string, attempts = 3): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const { data, error } = await supabase.rpc('generate_ticket_token' as any, { p_ticket_id: ticketId });
      if (!error && data) return data as string;
      if (error) console.warn('[ticketToken] mint error', { ticketId, attempt: i + 1, error });
    } catch (e) {
      console.warn('[ticketToken] mint threw', { ticketId, attempt: i + 1, e });
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

/**
 * Guarantee a signed token exists for a ticket: returns the cached one, or mints
 * (with retries) and caches it. Used to backfill the success screen whenever the
 * purchase call didn't hand one back (e.g. the "already has tickets" path), so
 * the QR is never left in a "Generating…" state.
 */
export async function ensureTicketToken(ticketId: string | null | undefined): Promise<string | null> {
  if (!ticketId) return null;
  const cached = getCachedTicketToken(ticketId);
  if (cached) return cached;
  const fresh = await mintToken(ticketId);
  if (fresh) cacheTicketToken(ticketId, fresh);
  return fresh;
}

/**
 * Warm the token cache for a batch of tickets ahead of time (My Tickets list),
 * so opening any one shows its QR instantly. Skips ids already cached, de-dupes,
 * retries, and fails silently offline. Fire-and-forget.
 */
export function prefetchTicketTokens(ticketIds: (string | null | undefined)[]): void {
  const cache = readTokenCache();
  const pending = Array.from(new Set(ticketIds.filter((id): id is string => !!id && needsRefresh(cache[id]))));
  for (const ticketId of pending) {
    mintToken(ticketId).then((token) => { if (token) cacheTicketToken(ticketId, token); });
  }
}

/**
 * Returns the signed v2 pass token for a ticket. Resolves synchronously from a
 * passed-in server token or the cache (no null flash), then mints in the
 * background ONLY if there's no valid token yet or the cached one is close to
 * expiring (see needsRefresh above) -- a comfortably-valid cached token is
 * never silently swapped for a different-looking one just because the
 * component mounted. This is what makes "one ticket -> one authoritative
 * credential -> one displayed QR" hold across remounts (tab switches,
 * navigating away and back, the purchase->success->My Tickets journey),
 * not just within a single component's lifetime.  Only ever REPLACES a
 * token — never clears a good one on failure — so an offline gate still
 * shows the last valid pass.
 */
export function useSignedTicketToken(
  ticketId: string | undefined | null,
  initialToken?: string | null,
): string | null {
  const seed = () => (initialToken || (ticketId ? getCachedTicketToken(ticketId) : null)) || null;
  const [token, setToken] = useState<string | null>(seed);

  // If a server token was provided (post-purchase), persist it immediately.
  useEffect(() => {
    if (ticketId && initialToken) cacheTicketToken(ticketId, initialToken);
  }, [ticketId, initialToken]);

  useEffect(() => {
    if (!ticketId) { setToken(null); return; }
    const cached = initialToken || getCachedTicketToken(ticketId);
    if (cached) setToken(cached);
    if (!needsRefresh(cached)) return; // already valid for a while -- nothing to do
    let cancelled = false;
    // Background refresh (keeps the pass fresh / recovers if never minted).
    mintToken(ticketId).then((fresh) => {
      if (cancelled || !fresh) return;
      cacheTicketToken(ticketId, fresh);
      setToken(fresh);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  return token;
}
