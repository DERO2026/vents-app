import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';

// Focus-aware smart cropping via Claude vision (reuses ANTHROPIC_API_KEY — the
// same key api/extract-events.ts uses, so no new provider/account). The client
// sends a small downscaled JPEG; we return a normalised focal point + the
// bounding box of the most important content, following the VENTS priority
// order (faces/performers > title > artwork > logos > dates/venue > sponsors).
// The client centres the crop on `focus` and can warn when `keep` would be cut.
//
// This is an ENHANCEMENT: the client already computes an instant heuristic crop
// and only upgrades to this when it returns, so a slow/failed call never blocks.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Setup-banner probe: reveals only whether the key exists, never its value.
  if (req.method === 'GET') return res.status(200).json({ configured: !!process.env.ANTHROPIC_API_KEY });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Paid vision call per request — require a live VENTS session.
  const session = await verifyInsforgeSession(req.headers.authorization);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  // ~1.4MB base64 ≈ 1MB image; the client should send a ~512px JPEG (far
  // smaller). Cap to keep cost/latency bounded.
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
        model: 'claude-haiku-4-5-20251001', // fast + cheap + vision-capable
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
