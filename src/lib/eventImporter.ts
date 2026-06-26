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

export async function extractEventsFromUrl(url: string): Promise<ImportedEvent[]> {
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const pageResponse = await fetch(proxyUrl);
    const pageData = await pageResponse.json();
    const htmlContent = pageData.contents || '';

    const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY || '';
    if (!apiKey) throw new Error('VITE_ANTHROPIC_API_KEY not set');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `Extract all FREE events from this webpage content. Only include events that are completely free with no ticket price. For each event extract: title, description, date (YYYY-MM-DD format), time (HH:MM format), location (venue name), state (Nigerian state name), category (one of: Music, Technology, Food & Drinks, Comedy Shows, Arts & Culture, Sports & Wellness, Conferences, Family Events, Nightlife, Fashion, Health & Wellness, Education, Weddings, Gaming, Business & Finance, Religious & Spiritual, Charity & Fundraising, Film & Media, Politics, Travel & Adventure, Kids & Family, Art Exhibition, Open Mic, Workshop), image_url (if found), is_free (boolean), price (number, 0 for free).

Return ONLY a valid JSON array with no markdown, no explanation, no backticks. Just the raw JSON array.

If no free events are found return an empty array [].

webpage content:
${htmlContent.substring(0, 15000)}`
        }]
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    let events: ImportedEvent[] = [];
    try {
      events = JSON.parse(text);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) events = JSON.parse(match[0]);
    }

    return events.filter((e) => e.is_free !== false && (e.price === 0 || e.price === undefined));
  } catch (error) {
    console.error('Event import error:', error);
    throw error;
  }
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
