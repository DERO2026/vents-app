import { getAuthToken } from './insforge';
import { REGION } from './regionConfig';

export interface ImportedEvent {
  title: string;
  description: string;
  date: string;
  time: string;
  location: string;
  state: string;
  category: string;
  is_free: boolean;
  price: number;
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

export async function publishEvents(
  events: ImportedEvent[],
  organizerId: string,
  database: any
): Promise<{ success: number; failed: number; lastError?: string }> {
  let success = 0;
  let failed = 0;
  let lastError: string | undefined;

  for (const event of events) {
    try {
      const time = event.time || '10:00';
      // Imported events don't carry their own timezone info, so this
      // assumes the offset matches VENTS' current single launch region
      // (see regionConfig.ts) rather than a bare hardcoded literal.
      // events.event_date is timestamptz, so Postgres normalizes whatever
      // offset is supplied here to true UTC on write.
      const eventDate = event.date
        ? `${event.date}T${time}:00${REGION.timezoneOffset}`
        : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

      const { error } = await database.from('events').insert({
        title: event.title,
        description: event.description,
        image_url: event.image_url || null,
        location: event.location,
        event_date: eventDate,
        price: 0,
        category: event.category,
        organizer_id: organizerId,
        status: 'live',
        is_featured: false,
        hidden_by_admin: false,
        is_18_plus: false,
        ticket_goal: 0,
        start_time: time,
      });
      if (error) {
        lastError = error.message || JSON.stringify(error);
        failed++;
      } else {
        success++;
      }
    } catch (e: any) {
      lastError = e.message;
      failed++;
    }
  }

  return { success, failed, lastError };
}
