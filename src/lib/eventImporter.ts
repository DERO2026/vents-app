import { getAuthToken } from './insforge';
import { REGION } from './regionConfig';
import { withTimeoutFallback } from './withTimeoutFallback';
import { isKnownState, isKnownCity } from './nigeriaLocations';

// Never let a raw SDK/framework error reach an admin's screen (leaks
// internal implementation details like "InsForgeError: ..."). Log the real
// error for diagnosis, return a clean, generic message for display.
export function friendlyPublishError(err: any): string {
  const raw = String(err?.message || err || '');
  console.error('[publishEvents] insert failed:', err);
  if (/timeout|timed out/i.test(raw)) return 'The server took too long to respond. Please try again.';
  if (/network|fetch failed|ECONNRESET/i.test(raw)) return 'A network error occurred. Please check your connection and try again.';
  // Anything else (including any InsForgeError / framework-named error) —
  // a human-readable database constraint message is still useful to an
  // admin, but never the raw class name.
  const cleaned = raw.replace(/InsForgeError:?\s*/gi, '').trim();
  return cleaned || 'Could not save this event. Please try again.';
}

export interface ImportedEvent {
  title: string;
  description: string;
  date: string;
  time: string;
  venue: string;
  address: string;
  city: string;
  state: string;
  categories: string[];
  ticket_type_name: string;
  is_free: boolean;
  price: number;
  capacity: number;
  image_url: string;
  source_url: string;
}


export async function extractEventsFromText(rawText: string): Promise<ImportedEvent[]> {
  try {
    const token = await getAuthToken();
    const response = await fetch('/api/v1/extract-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: rawText }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `Server error: ${response.status}`);
    }

    const data = await response.json();
    return (data.events || []).filter((e: any) => e && e.title && e.title.length > 2);
  } catch (error: any) {
    throw new Error(error.message || 'Failed to format events. Please try again.');
  }
}

export async function extractEventsFromUrl(url: string): Promise<ImportedEvent[]> {
  return extractEventsFromText(`Event page: ${url}`);
}

// Unauthenticated boolean status check — lets the admin UI show a "setup
// required" banner without ever needing its own copy of the API key.
export async function isEventExtractionConfigured(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/extract-events');
    if (!response.ok) return false;
    const data = await response.json();
    return !!data.configured;
  } catch {
    return false;
  }
}

// Publishing N events used to be N fully-sequential round trips with no
// per-request timeout and no retry — a single slow/hung request stalled
// every event behind it, and the whole batch could run well past 30s with
// nothing to show for it but a generic failure. Now: bounded concurrency
// (a few in flight at once, not all-at-once or one-at-a-time), a hard
// per-insert timeout so a stuck request fails fast instead of hanging, and
// one retry on a transient failure before giving up on that event.
const PUBLISH_CONCURRENCY = 4;
const PUBLISH_TIMEOUT_MS = 12000;

// True only if this import has everything a manually-created event requires
// (matches CreateEventScreen's own required fields). Anything less publishes
// as a draft instead of guessing — the admin completes it via the normal
// Edit Event screen, the same surface a manual creation would use.
function isImportComplete(event: ImportedEvent): boolean {
  return !!(event.title?.trim() && event.venue?.trim() && event.date && isKnownState(event.state) && event.city?.trim());
}

async function publishOne(event: ImportedEvent, organizerId: string, database: any): Promise<{ ok: true; draft: boolean } | { ok: false; error: string }> {
  const time = event.time || '10:00';
  // Imported events don't carry their own timezone info, so this assumes
  // the offset matches VENTS' current single launch region (see
  // regionConfig.ts) rather than a bare hardcoded literal. events.event_date
  // is timestamptz, so Postgres normalizes whatever offset is supplied here
  // to true UTC on write.
  const eventDate = event.date
    ? `${event.date}T${time}:00${REGION.timezoneOffset}`
    : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  // Never trust an AI-guessed state/city that doesn't match a real Nigerian
  // state/LGA — a wrong value here is worse than a blank one, since a blank
  // field visibly prompts the admin to fill it in during review instead of
  // silently shipping a bad location.
  const state = isKnownState(event.state) ? event.state : '';
  const city = isKnownCity(state, event.city) || (state && event.city?.trim()) ? event.city.trim() : '';
  const venue = (event.venue || '').trim();
  const address = (event.address || '').trim();

  // Same composite-string convention CreateEventScreen uses, so an imported
  // event edits identically to a manually-created one afterward.
  const locationParts = [venue, state, city].filter(Boolean);
  const locationString = locationParts.join(', ') + (address ? `, ${address}` : '');

  const categories = Array.isArray(event.categories) && event.categories.length ? event.categories : [];
  const capacity = Number(event.capacity) > 0 ? Number(event.capacity) : 0;
  const price = event.is_free ? 0 : Number(event.price) || 0;
  const ticketTypes = [{
    id: 't_0',
    name: (event.ticket_type_name || 'General Admission').trim(),
    price,
    quantity: capacity > 0 ? capacity : 500,
    description: '',
  }];

  const complete = isImportComplete(event);

  const row = {
    title: event.title,
    description: event.description,
    image_url: event.image_url || null,
    // events has no separate venue/city/state columns — only the composite
    // `location` string (same convention CreateEventScreen uses on insert).
    location: locationString,
    event_date: eventDate,
    price,
    category: categories[0] || '',
    categories,
    organizer_id: organizerId,
    // Incomplete location data (missing venue/state/city) never goes live —
    // it publishes as a draft so the admin finishes it in Edit Event first,
    // exactly like an organizer completing their own in-progress draft.
    status: complete ? 'live' : 'draft',
    is_featured: false,
    hidden_by_admin: false,
    is_18_plus: false,
    ticket_goal: capacity,
    ticket_types: ticketTypes,
    start_time: time,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await withTimeoutFallback(
        Promise.resolve(database.from('events').insert(row)),
        { timeoutMs: PUBLISH_TIMEOUT_MS, timeoutMessage: 'Publish timed out' }
      );
      if (!error) return { ok: true, draft: !complete };
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue; }
      return { ok: false, error: friendlyPublishError(error) };
    } catch (e: any) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue; }
      return { ok: false, error: friendlyPublishError(e) };
    }
  }
  return { ok: false, error: 'Could not save this event. Please try again.' };
}

export async function publishEvents(
  events: ImportedEvent[],
  organizerId: string,
  database: any
): Promise<{ success: number; drafted: number; failed: number; lastError?: string }> {
  let success = 0;
  let drafted = 0;
  let failed = 0;
  let lastError: string | undefined;

  for (let i = 0; i < events.length; i += PUBLISH_CONCURRENCY) {
    const batch = events.slice(i, i + PUBLISH_CONCURRENCY);
    const results = await Promise.all(batch.map((event) => publishOne(event, organizerId, database)));
    for (const r of results) {
      if (r.ok) {
        success++;
        if (r.draft) drafted++;
      } else {
        failed++;
        lastError = (r as { ok: false; error: string }).error;
      }
    }
  }

  return { success, drafted, failed, lastError };
}
