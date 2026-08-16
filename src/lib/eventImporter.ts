import { getAuthToken } from './supabase';
import { REGION } from './regionConfig';
import { withTimeoutFallback } from './withTimeoutFallback';
import { isKnownState, isKnownCity, matchNigeriaState } from './nigeriaLocations';
import { apiUrl } from './apiBase';
import { loadGoogleMaps } from './googleMaps';

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
  organizer_name?: string;
  date: string;
  end_date?: string;
  time: string;
  end_time?: string;
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
  contact_phone?: string;
  social_instagram?: string;
  // Populated client-side after extraction by resolveEventLocations() below
  // — never returned by the AI itself, which has no way to geocode.
  latitude?: number | null;
  longitude?: number | null;
  place_id?: string | null;
  // True once Google Places has confirmed venue+city+state resolve to a
  // real place — lets the UI show a "location verified" signal distinct
  // from "the AI merely guessed a plausible-looking city/state".
  location_verified?: boolean;
}


export async function extractEventsFromText(rawText: string): Promise<ImportedEvent[]> {
  try {
    const token = await getAuthToken();
    const response = await fetch(apiUrl('/api/v1/extract-events'), {
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

function parseGeocoderAddress(components: any[] | undefined): { city: string; state: string } {
  const byType = (type: string) => components?.find((c) => c.types?.includes(type))?.long_name ?? '';
  const city = byType('locality') || byType('administrative_area_level_2') || '';
  const rawState = byType('administrative_area_level_1');
  return { city, state: matchNigeriaState(rawState) || rawState };
}

// Best-effort geocoding pass over already-extracted events — the AI has no
// way to actually verify a location exists, only to transcribe what the
// source text says. This resolves venue+city+state (whatever's present)
// through Google's Geocoder and fills in gaps / confirms the guess with a
// real coordinate, without ever overriding a field the AI (or an admin
// editing afterward) already populated with something more specific.
// Never throws and never blocks the import — a geocoding failure just
// means the event goes through un-verified, same as before this existed.
export async function resolveEventLocations(events: ImportedEvent[]): Promise<ImportedEvent[]> {
  try {
    await loadGoogleMaps();
  } catch {
    return events; // Places unavailable — import still works, just unverified.
  }
  const google = (window as any).google;
  if (!google?.maps?.Geocoder) return events;
  const geocoder = new google.maps.Geocoder();

  const geocodeOne = (query: string): Promise<{ lat: number; lng: number; placeId: string; city: string; state: string } | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000);
      geocoder.geocode({ address: `${query}, Nigeria` }, (results: any[], status: string) => {
        clearTimeout(timer);
        if (status !== 'OK' || !results?.[0]) return resolve(null);
        const r = results[0];
        const { city, state } = parseGeocoderAddress(r.address_components);
        resolve({
          lat: r.geometry.location.lat(),
          lng: r.geometry.location.lng(),
          placeId: r.place_id,
          city,
          state,
        });
      });
    });

  return Promise.all(
    events.map(async (event) => {
      const query = [event.venue, event.city, event.state].filter(Boolean).join(', ');
      if (!query.trim()) return event; // nothing to geocode at all
      const geo = await geocodeOne(query);
      if (!geo) return event;
      return {
        ...event,
        latitude: geo.lat,
        longitude: geo.lng,
        place_id: geo.placeId,
        // Only fills a gap — never overwrites a value the AI already found.
        city: event.city || geo.city,
        state: event.state || geo.state,
        location_verified: true,
      };
    })
  );
}

// Unauthenticated boolean status check — lets the admin UI show a "setup
// required" banner without ever needing its own copy of the API key.
export async function isEventExtractionConfigured(): Promise<boolean> {
  try {
    const response = await fetch(apiUrl('/api/v1/extract-events'));
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
//
// Takes the SANITIZED state/city (post isKnownState/isKnownCity), not the
// raw AI-guessed event.state/event.city — checking the raw values meant an
// event with a bogus, rejected city could still be marked "complete" and
// publish straight to 'live' with an empty location field, since the row
// actually written uses the sanitized (possibly blanked) city.
function isImportComplete(event: ImportedEvent, sanitizedState: string, sanitizedCity: string): boolean {
  // A Google-verified coordinate (resolveEventLocations already confirmed a
  // real place exists at venue+city+state) is as good as a clean
  // state/city match even if the geocoder's own city/state strings didn't
  // line up perfectly with our canonical list.
  const locationOk = (sanitizedState && sanitizedCity) || (event.location_verified && event.latitude != null);
  return !!(event.title?.trim() && event.venue?.trim() && event.date && locationOk);
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
  // Multi-day support (see migrations/20260802120000_add-end-date-to-events)
  // — only set when the source text explicitly named a later end date.
  const endDate = event.end_date
    ? `${event.end_date}T${event.end_time || time}:00${REGION.timezoneOffset}`
    : null;

  // Never trust an AI-guessed state/city that doesn't match a real Nigerian
  // state/LGA — a wrong value here is worse than a blank one, since a blank
  // field visibly prompts the admin to fill it in during review instead of
  // silently shipping a bad location.
  const state = isKnownState(event.state) ? event.state : '';
  // Was `isKnownCity(...) || (state && event.city?.trim()) ? ... : ''` —
  // operator precedence made the whole `A || B` the ternary condition, so
  // ANY non-empty city was accepted as long as a state was set, defeating
  // the isKnownCity check the comment above promises. Also threw if
  // isKnownCity returned true for an undefined event.city. Only trust the
  // city when isKnownCity itself confirms it.
  const city = isKnownCity(state, event.city) ? (event.city || '').trim() : '';
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

  const complete = isImportComplete(event, state, city);

  const row = {
    title: event.title,
    description: event.description,
    image_url: event.image_url || null,
    // events has no separate venue/city/state columns — only the composite
    // `location` string (same convention CreateEventScreen uses on insert).
    location: locationString,
    event_date: eventDate,
    end_date: endDate,
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
    end_time: event.end_time || null,
    latitude: event.latitude ?? null,
    longitude: event.longitude ?? null,
    place_id: event.place_id ?? null,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    // withTimeoutFallback only abandons the wait, not the request — a slow
    // insert from a timed-out first attempt can still land server-side.
    // Without this check, the retry below would insert this event a
    // second time. There's no external reference to key an idempotency
    // check on (unlike ticket purchases' payment_ref), so use the same
    // organizer_id + title + event_date + location match the manual
    // CreateEventScreen publish path uses for the identical race.
    if (attempt > 0) {
      const { data: recentDupe } = await database
        .from('events')
        .select('id')
        .eq('organizer_id', organizerId)
        .eq('title', row.title)
        .eq('location', row.location)
        .eq('event_date', row.event_date)
        .gte('created_at', new Date(Date.now() - 2 * 60 * 1000).toISOString())
        .limit(1);
      if (recentDupe && recentDupe[0]?.id) return { ok: true, draft: !complete };
    }
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
