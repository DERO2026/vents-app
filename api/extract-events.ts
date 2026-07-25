import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from './_lib/verifyAuth.js';
import { applyCors } from './_lib/cors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Cheap, unauthenticated status check for the admin UI's setup banner —
  // reveals only whether the key is configured, never the key itself. This
  // exists specifically so the client never needs its own copy of the
  // secret (see the ANTHROPIC_API_KEY-only read below: a VITE_-prefixed
  // env var would get inlined into the public JS bundle by Vite, which is
  // exactly what happened before this endpoint existed as the fix).
  if (req.method === 'GET') {
    return res.status(200).json({ configured: !!process.env.ANTHROPIC_API_KEY });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // This endpoint spends a paid Anthropic API call per request — must be a
  // live, validated VENTS session, not just any non-empty header.
  const session = await verifyInsforgeSession(req.headers.authorization);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // Vision branch: focus-aware flyer cropping. Folded into this (the existing
  // AI/Anthropic endpoint) to stay within the serverless-function limit — the
  // client posts { imageBase64 } here; text-extraction posts { text }.
  if (req.body && typeof req.body.imageBase64 === 'string') {
    return handleVisionCrop(req, res);
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text field required' });
  }
  if (text.length > 20000) {
    return res.status(400).json({ error: 'text field too long (max 20000 characters)' });
  }

  // Server-only, never VITE_-prefixed — a VITE_ var gets inlined into the
  // public client bundle by Vite at build time.
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
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

// Focus-aware flyer cropping via Claude vision. Returns the normalised focal
// point + keep-box of the most important content (faces/performers > title >
// artwork > logos > dates/venue > sponsors). Best-effort: the client already
// has an instant on-device heuristic and only upgrades to this when it returns.
async function handleVisionCrop(req: VercelRequest, res: VercelResponse) {
  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  if (imageBase64.length > 1_400_000) {
    return res.status(400).json({ error: 'image too large — downscale before sending' });
  }
  const media = typeof mimeType === 'string' && /^image\/(jpeg|png|webp)$/.test(mimeType) ? mimeType : 'image/jpeg';
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

  const prompt =
    'This is an event flyer that will be cropped into portrait (4:5) and landscape cards. ' +
    'Identify the single focal region to keep visible across every crop. ' +
    'Priority, most to least important: faces and performers, event title, main artwork, logos, dates and venue, sponsors, background graphics. ' +
    'Never centre on empty background when a clear subject exists; if there are faces, the focal point must keep them visible and never cut through a face. ' +
    'Return ONLY minified JSON, no markdown/backticks:\n' +
    '{"focus":{"x":0.5,"y":0.4},"keep":{"x":0.1,"y":0.15,"w":0.8,"h":0.6},"hasFaces":true,"primary":"faces"}\n' +
    'Coordinates are normalised 0..1 (x: 0=left,1=right; y: 0=top,1=bottom). ' +
    'focus = the point that should stay centred in every crop. ' +
    'keep = bounding box (top-left x,y and w,h) of the most important content that should remain fully visible if possible. ' +
    'primary = one of faces|title|artwork|logo|text|other.';

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    clearTimeout(timer);
    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: `Vision error: ${err.substring(0, 160)}` });
    }
    const data = await response.json();
    const content = data.content?.[0]?.text || '';
    let parsed: any = null;
    try { parsed = JSON.parse(content); }
    catch { const m = content.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } } }

    const clamp01 = (n: any) => (typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(1, n)) : null);
    const fx = clamp01(parsed?.focus?.x), fy = clamp01(parsed?.focus?.y);
    if (fx === null || fy === null) return res.status(200).json({ ok: false, reason: 'no-focus' });

    const keep = parsed?.keep && {
      x: clamp01(parsed.keep.x) ?? 0, y: clamp01(parsed.keep.y) ?? 0,
      w: clamp01(parsed.keep.w) ?? 1, h: clamp01(parsed.keep.h) ?? 1,
    };
    return res.status(200).json({
      ok: true,
      focus: { x: fx, y: fy },
      keep: keep || null,
      hasFaces: parsed?.hasFaces === true,
      primary: typeof parsed?.primary === 'string' ? parsed.primary : null,
    });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return res.status(aborted ? 504 : 500).json({ error: aborted ? 'vision timeout' : (e?.message || 'vision failed') });
  }
}
