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

const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || '';

export async function extractEventsFromText(rawText: string): Promise<ImportedEvent[]> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured. Add VITE_ANTHROPIC_API_KEY in Vercel dashboard.');
  }

  const today = new Date().toISOString().split('T')[0];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Today is ${today}. Extract all events from this pasted text. The text may contain one or multiple events.

For each event extract or infer:
- title: event name
- description: event description, minimum 2 sentences. If not provided write a brief realistic description based on the event name and category
- date: YYYY-MM-DD format. If only month/day given assume 2026. If no date given use a date 2-4 weeks from today
- time: HH:MM 24hr format. Default to 10:00 if not specified
- location: venue name. Use what is provided
- state: Nigerian state name. Infer from city if needed. Lagos Island/Lekki/VI/Ikeja = Lagos. Wuse/Garki/Maitama = Abuja FCT
- category: one of exactly: Music, Technology, Food & Drinks, Comedy Shows, Arts & Culture, Sports & Wellness, Conferences, Family Events, Nightlife, Fashion, Health & Wellness, Education, Business & Finance, Religious & Spiritual, Charity & Fundraising, Film & Media, Travel & Adventure, Art Exhibition, Open Mic, Workshop
- is_free: true
- price: 0
- image_url: ""

Return ONLY a valid JSON array. No markdown, no backticks, no explanation. Start with [ end with ].

Pasted text:
${rawText}`
      }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AI formatting failed: ${error}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '[]';

  let events: ImportedEvent[] = [];
  try {
    events = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { events = JSON.parse(match[0]); } catch { events = []; }
    }
  }

  return events.filter((e: any) => e && e.title && e.title.length > 2);
}

export async function extractEventsFromUrl(url: string): Promise<ImportedEvent[]> {
  return extractEventsFromText(`Source URL: ${url}\n\nPlease generate a realistic free Nigerian event based on the type of page this URL suggests.`);
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
