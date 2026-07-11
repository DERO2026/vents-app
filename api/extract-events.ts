import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from './lib/verifyAuth.js';
import { applyCors } from './lib/cors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // This endpoint spends a paid Anthropic API call per request — must be a
  // live, validated VENTS session, not just any non-empty header.
  const session = await verifyInsforgeSession(req.headers.authorization);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text field required' });
  }
  if (text.length > 20000) {
    return res.status(400).json({ error: 'text field too long (max 20000 characters)' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const today = new Date().toISOString().split('T')[0];

  try {
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
          content: `Today is ${today}. Extract all events from this text. May contain one or multiple events.

For each event extract or infer:
- title: event name
- description: 2-3 sentence description. Write one if not provided based on event name
- date: YYYY-MM-DD. Assume 2026 if year missing. Use 2-4 weeks from today if no date
- time: HH:MM 24hr. Default 10:00 if missing
- location: venue name
- state: Nigerian state. Infer from venue/city. Delta State University Oleh = Delta. Baze University = Abuja. ASUU Secretariat = check city context. De Aria/Club Deluxe/Vault Social House = Lagos. The Ozone E-centre = Lagos
- category: exactly one of: Music, Technology, Food & Drinks, Comedy Shows, Arts & Culture, Sports & Wellness, Conferences, Family Events, Nightlife, Fashion, Health & Wellness, Education, Business & Finance, Religious & Spiritual, Charity & Fundraising, Film & Media, Travel & Adventure, Art Exhibition, Open Mic, Workshop
- is_free: true
- price: 0
- image_url: ""

Return ONLY a valid JSON array. No markdown, no backticks, no explanation. Start with [ end with ].

Text:
${text}`
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(500).json({ error: `Anthropic error: ${error.substring(0, 200)}` });
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '[]';

    let events: any[] = [];
    try {
      events = JSON.parse(content);
    } catch {
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        try { events = JSON.parse(match[0]); } catch { events = []; }
      }
    }

    return res.status(200).json({ events: events.filter((e: any) => e && e.title) });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
