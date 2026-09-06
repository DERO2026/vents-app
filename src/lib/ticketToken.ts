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
  const pending = Array.from(new Set(ticketIds.filter((id): id is string => !!id && !cache[id])));
  for (const ticketId of pending) {
    mintToken(ticketId).then((token) => { if (token) cacheTicketToken(ticketId, token); });
  }
}

/**
 * Returns the signed v2 pass token for a ticket. Resolves synchronously from a
 * passed-in server token or the cache (no null flash), then refreshes in the
 * background when online. Only ever REPLACES a token — never clears a good one
 * on failure — so an offline gate still shows the last valid pass.
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
