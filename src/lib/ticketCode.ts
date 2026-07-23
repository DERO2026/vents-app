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
