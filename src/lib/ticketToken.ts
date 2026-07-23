import { useState, useEffect } from 'react';
import { insforge } from './insforge';

// ─── Offline-first signed v2 pass token ──────────────────────────────────────
// A v2 pass is "<base64url(payload)>.<hmacSha256(payload)>", where the payload
// binds ticketId, eventId, purchaserId, issuedAt, expiresAt, nonce and version.
// It is minted server-side by the generate_ticket_token RPC; the signing secret
// never reaches the client. The scanner (verify_entry_pass) strictly rejects
// anything that isn't a valid v2 signature — a bare UUID or a raw JSON blob
// yields "missing cryptographic signature" at the door — so every QR we render
// MUST be a signed token, never a raw id.
//
// This hook is shared by every ticket surface (QRTicket, PaymentSuccessScreen)
// so they can never drift: the QR renders instantly from cache when available,
// then silently upgrades to a freshly-minted token whenever online, keeping the
// pass usable offline at the gate.
const TOKEN_CACHE_KEY = 'vents_ticket_token_cache_v2';

function readTokenCache(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(TOKEN_CACHE_KEY) || '{}'); } catch { return {}; }
}

function writeTokenCache(ticketId: string, token: string) {
  try {
    const cache = readTokenCache();
    cache[ticketId] = token;
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(cache));
  } catch { /* storage unavailable — token just won't persist across sessions */ }
}

/**
 * Warm the token cache for a batch of tickets ahead of time (e.g. when the My
 * Tickets list loads) so opening any one of them shows its QR instantly. Skips
 * ids already cached, de-dupes, and fails silently offline. Fire-and-forget.
 */
export function prefetchTicketTokens(ticketIds: (string | null | undefined)[]): void {
  const cache = readTokenCache();
  const pending = Array.from(
    new Set(ticketIds.filter((id): id is string => !!id && !cache[id]))
  );
  for (const ticketId of pending) {
    insforge.database.rpc('generate_ticket_token' as any, { p_ticket_id: ticketId })
      .then(
        ({ data, error }: any) => {
          if (error || !data) return;
          writeTokenCache(ticketId, data as string);
        },
        () => { /* offline / unauthenticated — the QR screen will retry on open */ },
      );
  }
}

/**
 * Returns the signed v2 pass token for a ticket, or null until one is available
 * (from cache, or freshly minted). Callers render a "generating…" placeholder
 * while it's null rather than a QR that would be rejected at the door.
 */
export function useSignedTicketToken(ticketId: string | undefined | null): string | null {
  const [token, setToken] = useState<string | null>(() =>
    ticketId ? readTokenCache()[ticketId] || null : null
  );

  useEffect(() => {
    if (!ticketId) { setToken(null); return; }
    setToken(readTokenCache()[ticketId] || null);
    let cancelled = false;
    insforge.database.rpc('generate_ticket_token' as any, { p_ticket_id: ticketId })
      .then(
        ({ data, error }: any) => {
          if (cancelled || error || !data) return;
          writeTokenCache(ticketId, data as string);
          setToken(data as string);
        },
        () => { /* offline or not yet authenticated — cached token (if any) still stands */ },
      );
    return () => { cancelled = true; };
  }, [ticketId]);

  return token;
}
