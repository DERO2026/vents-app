// ─── Human-facing ticket code ────────────────────────────────────────────────
// The real ticket identifier is a UUID (e.g. 89ac9a41-f868-49f0-8607-…). It's
// the authoritative key used by the scanner and the DB, but it reads like a raw
// database guid and shouldn't be what a guest sees on their pass.
//
// ticketDisplayCode() derives a short, uppercase alphanumeric label from that
// UUID. It is a pure function of the id, so the same ticket always shows the
// same code, and it's a bijection over the id's 128 bits (base36 of the full
// hex), so two different tickets can never collide. Prefixed and grouped for
// readability: "VT-XXXXX-XXXXX-XXXXX". No lookup, no storage, no network — the
// UUID is never displayed, only this.

/** Crockford-ish base32 of the full UUID, grouped. Deterministic + collision-free. */
export function ticketDisplayCode(ticketId: string | null | undefined): string {
  if (!ticketId) return '—';
  const hex = ticketId.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 8) return ticketId.toUpperCase();

  let n: bigint;
  try {
    n = BigInt('0x' + hex);
  } catch {
    return ticketId.toUpperCase();
  }

  // base36 keeps it compact while staying a lossless encoding of every bit.
  let out = n.toString(36).toUpperCase();
  // Pad so short values (leading-zero UUIDs) still produce a full-width code.
  out = out.padStart(25, '0');

  // Group into blocks of 5 for legibility: VT-ABCDE-FGHIJ-…
  const groups = out.match(/.{1,5}/g) || [out];
  return 'VT-' + groups.join('-');
}

/**
 * Inverse of ticketDisplayCode(): recovers the raw ticket UUID from a
 * "VT-XXXXX-XXXXX-…" code a guest reads off their ticket and an organizer
 * types into the scanner's manual-entry fallback. Purely a decode — it
 * carries no cryptographic authority of its own (unlike the signed QR
 * token) and proves nothing about validity; the resolved UUID is only ever
 * handed to a server-authoritative RPC (manual_check_in), which re-derives
 * ownership/status/duplicate-check-in from the database itself. Returns
 * null for anything that doesn't decode to a well-formed UUID, rather than
 * guessing or silently truncating.
 */
export function parseTicketDisplayCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const cleaned = code.trim().toUpperCase().replace(/^VT-?/, '').replace(/[-\s]/g, '');
  // Every char must be a valid base36 digit (0-9, A-Z) -- reject anything else
  // up front instead of letting a bad char silently parse as NaN.
  if (!cleaned || !/^[0-9A-Z]+$/.test(cleaned)) return null;
  let n: bigint;
  try {
    n = cleaned.split('').reduce((acc, ch) => acc * 36n + BigInt(parseInt(ch, 36)), 0n);
  } catch {
    return null;
  }
  let hex = n.toString(16);
  if (hex.length > 32) return null; // overflowed 128 bits -- not a real ticket code
  hex = hex.padStart(32, '0');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) ? uuid : null;
}
