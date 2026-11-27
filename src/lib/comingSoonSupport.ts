// Coming Soon (migration 0224) on a database that may not have it yet.
//
// P0 2026-11-27: 0224 is not applied in production. Create Event offered
// "Publish as Coming Soon"; the insert sent events.sales_open_at, PostgREST
// refused it ("Could not find the 'sales_open_at' column of 'events' in the
// schema cache", HTTP 400, PGRST204) and the raw message appeared above a
// green "Ready to publish!". Nothing was created (the insert is one
// statement), but the screen looked ready and kept offering the option.
//
// This module recognises that whole family of "0224 is missing" errors and
// probes once per session whether the database supports Coming Soon, so the
// option is only offered where it can work. Normal publishing never sends
// sales_open_at and is unaffected.

type DbError = { code?: string; message?: string; details?: string; hint?: string } | null | undefined;
type ProbeClient = { from: (t: string) => { select: (c: string) => { limit: (n: number) => PromiseLike<{ error: DbError }> } } };

/** True when the error says the 0224 schema (column, status value, functions) is not on this database. */
export function isMissingComingSoonSchemaError(err: DbError | Error | unknown): boolean {
  const e = (err ?? {}) as { code?: string; message?: string; details?: string };
  const text = `${e.message ?? ''} ${e.details ?? ''}`;
  if (/sales_open_at/i.test(text) && (e.code === 'PGRST204' || e.code === '42703' || /schema cache|does not exist|could not find/i.test(text))) return true;
  // Before 0224 events_status_check only allows 'live' and 'draft'.
  if (e.code === '23514' && /events_status_check/i.test(text)) return true;
  // 0224's functions (PostgREST: function not found).
  if (e.code === 'PGRST202' && /open_event_sales|open_due_event_sales|event_sale_alert|subscribe_event_sale_alert/i.test(text)) return true;
  return false;
}

export const COMING_SOON_UNAVAILABLE =
  "Coming Soon isn't available yet, so your event was not published. Choose “Open now” to publish with tickets on sale, or save it as a draft.";

/** Friendly text for a publish/save error; never the raw schema message. */
export function publishErrorMessage(err: unknown, fallback: string): string {
  if (isMissingComingSoonSchemaError(err)) return COMING_SOON_UNAVAILABLE;
  const msg = (err as { message?: string } | null)?.message || '';
  if (/schema cache|column .* does not exist|could not find the .* column/i.test(msg)) {
    return 'This change needs an update on our side before it can be saved. Nothing was published. Please try again later or contact support.';
  }
  return msg || fallback;
}

let cached: boolean | null = null;
let inflight: Promise<boolean | null> | null = null;

/**
 * Whether this database supports Coming Soon: true, false, or null when it
 * could not be determined (network). A read only (select one column, one
 * row); cached for the session once known.
 */
export function probeComingSoonSupport(client: ProbeClient): Promise<boolean | null> {
  if (cached !== null) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = Promise.resolve(client.from('events').select('sales_open_at').limit(1))
    .then(({ error }) => {
      if (!error) cached = true;
      else if (isMissingComingSoonSchemaError(error)) cached = false;
      return cached;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

/** Remember a definitive answer learnt elsewhere (for example from a failed publish). */
export function markComingSoonUnsupported(): void { cached = false; }

/** Tests only. */
export function resetComingSoonSupportCache(): void { cached = null; inflight = null; }
