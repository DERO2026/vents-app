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
    const response = await fetch('/api/extract-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

export async function publishEvents(
  events: ImportedEvent[],
  organizerId: string,
  database: any
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const { error } = await database.from('events').insert({
        title: event.title,
        description: event.description,
        start_date: event.date,
        start_time: event.time || '09:00',
        location: event.location,
        state: event.state,
        category: event.category,
        is_free: true,
        price: 0,
        organizer_id: organizerId,
        status: 'live',
        is_featured: false,
        cover_image: event.image_url || null,
      });
      if (error) failed++;
      else success++;
    } catch {
      failed++;
    }
  }

  return { success, failed };
}
