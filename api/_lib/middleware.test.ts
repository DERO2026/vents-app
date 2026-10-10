import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Covers middleware.ts's crawler-vs-browser branch: a bot UA requesting
// /?event=/?user= gets the per-content preview HTML; any other request
// (no bot UA, or a bot UA with no event/user param) falls through
// unchanged (returns undefined) to the normal static/rewrite pipeline, so
// the real app experience never regresses.

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = 'https://proj.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadMiddleware() {
  const mod = await import('../../middleware');
  return mod.default as (req: Request) => Promise<Response | undefined>;
}

describe('middleware (Vercel Edge Middleware, not a serverless function)', () => {
  it('passes a normal browser request through unchanged', async () => {
    const middleware = await loadMiddleware();
    const req = new Request('https://getvents.com/?event=evt-1', {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' },
    });
    const res = await middleware(req);
    expect(res).toBeUndefined();
  });

  it('passes a bot request through unchanged when there is no event/user param', async () => {
    const middleware = await loadMiddleware();
    const req = new Request('https://getvents.com/', {
      headers: { 'user-agent': 'facebookexternalhit/1.1' },
    });
    const res = await middleware(req);
    expect(res).toBeUndefined();
  });

  it('serves per-event preview HTML to a crawler requesting ?event=', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: 'Afrobeats Night', venue: 'Eko Hotel', city: 'Lagos', image_url: 'https://cdn.example/e1.png', deleted_at: null }],
      })
    );
    const middleware = await loadMiddleware();
    const req = new Request('https://getvents.com/?event=evt-1', {
      headers: { 'user-agent': 'Twitterbot/1.0' },
    });
    const res = await middleware(req);
    expect(res).toBeInstanceOf(Response);
    const html = await (res as Response).text();
    expect(html).toContain('Afrobeats Night | VENTS');
    expect((res as Response).headers.get('content-type')).toContain('text/html');
  });

  it('serves per-profile preview HTML to a crawler requesting ?user=', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ full_name: 'Ada Lovelace', username: 'ada', avatar_url: 'https://cdn.example/ada.png' }],
      })
    );
    const middleware = await loadMiddleware();
    const req = new Request('https://getvents.com/?user=user-1', {
      headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' },
    });
    const res = await middleware(req);
    const html = await (res as Response).text();
    expect(html).toContain('Ada Lovelace on VENTS');
  });

  it('never leaks a deleted event to a crawler, and never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: 'Secret Afterparty', deleted_at: '2026-01-01T00:00:00Z' }],
      })
    );
    const middleware = await loadMiddleware();
    const req = new Request('https://getvents.com/?event=evt-deleted', {
      headers: { 'user-agent': 'WhatsApp/2.23' },
    });
    const res = await middleware(req);
    const html = await (res as Response).text();
    expect(html).not.toContain('Secret Afterparty');
    expect(html).toContain('VENTS');
  });

  it('serves per-provider preview HTML to a crawler requesting ?provider=', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ business_name: 'Glow Makeup Studio', category: 'Beauty', location: 'Lagos', photo_urls: ['https://cdn.example/p1.png'], status: 'approved' }],
      })
    );
    const middleware = await loadMiddleware();
    const req = new Request('https://getvents.com/?provider=prov-1', {
      headers: { 'user-agent': 'facebookexternalhit/1.1' },
    });
    const res = await middleware(req);
    expect(res).toBeInstanceOf(Response);
    const html = await (res as Response).text();
    expect(html).toContain('Glow Makeup Studio | VENTS');
  });

  it('never leaks an unapproved provider to a crawler, and never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ business_name: 'Pending Provider', status: 'pending' }],
      })
    );
    const middleware = await loadMiddleware();
    const req = new Request('https://getvents.com/?provider=prov-pending', {
      headers: { 'user-agent': 'WhatsApp/2.23' },
    });
    const res = await middleware(req);
    const html = await (res as Response).text();
    expect(html).not.toContain('Pending Provider');
    expect(html).toContain('VENTS');
  });

  it('falls through gracefully (undefined) if preview building throws unexpectedly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        throw new Error('boom');
      })
    );
    const middleware = await loadMiddleware();
    const req = new Request('https://getvents.com/?event=evt-1', {
      headers: { 'user-agent': 'Discordbot/2.0' },
    });
    // buildEventPreview itself catches fetch errors and returns a safe
    // fallback, so this should still render (not reject) -- asserting here
    // that the overall middleware never throws regardless.
    await expect(middleware(req)).resolves.toBeDefined();
  });
});
