import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isCrawlerUserAgent,
  buildEventPreview,
  buildUserPreview,
  renderPreviewHtml,
} from './socialPreview';

// Covers the fix for "share links resolve to generic www.getvents.com":
// crawler detection, per-event/per-user metadata fetching (public fields
// only), and the safe fallback for missing/deleted/private content -- see
// middleware.ts and this file's own header comment for the full writeup.

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = 'https://proj.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isCrawlerUserAgent', () => {
  it('recognizes known social-preview bots', () => {
    expect(isCrawlerUserAgent('facebookexternalhit/1.1')).toBe(true);
    expect(isCrawlerUserAgent('Twitterbot/1.0')).toBe(true);
    expect(isCrawlerUserAgent('Slackbot-LinkExpanding 1.0')).toBe(true);
    expect(isCrawlerUserAgent('WhatsApp/2.23')).toBe(true);
    expect(isCrawlerUserAgent('Mozilla/5.0 (compatible; Discordbot/2.0;)')).toBe(true);
    expect(isCrawlerUserAgent('LinkedInBot/1.0')).toBe(true);
    expect(isCrawlerUserAgent('TelegramBot (like TwitterBot)')).toBe(true);
  });

  it('does not flag a normal browser UA', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe(false);
    expect(isCrawlerUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0')).toBe(false);
  });

  it('treats a missing user agent as not a crawler', () => {
    expect(isCrawlerUserAgent(null)).toBe(false);
    expect(isCrawlerUserAgent(undefined)).toBe(false);
  });
});

describe('buildEventPreview', () => {
  it('returns the event-specific title/description/image for a real, non-deleted event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { title: 'Afrobeats Night', venue: 'Eko Hotel', city: 'Lagos', image_url: 'https://cdn.example/e1.png', deleted_at: null },
        ],
      })
    );
    const meta = await buildEventPreview('evt-1', 'https://getvents.com/?event=evt-1');
    expect(meta.title).toBe('Afrobeats Night | VENTS');
    expect(meta.description).toContain('Eko Hotel');
    expect(meta.image).toBe('https://cdn.example/e1.png');
    expect(meta.canonicalUrl).toBe('https://getvents.com/?event=evt-1');
  });

  it('falls back to the generic site preview for a soft-deleted event (never leaks its title/image)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ title: 'Secret Afterparty', deleted_at: '2026-01-01T00:00:00Z' }],
      })
    );
    const meta = await buildEventPreview('evt-deleted', 'https://getvents.com/?event=evt-deleted');
    expect(meta.title).toBe('VENTS');
    expect(meta.title).not.toContain('Secret Afterparty');
  });

  it('falls back to the generic site preview for an unknown event id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    const meta = await buildEventPreview('does-not-exist', 'https://getvents.com/?event=does-not-exist');
    expect(meta.title).toBe('VENTS');
    expect(meta.image).toBe('https://getvents.com/og-image.png');
  });

  it('falls back to the generic site preview, never throwing, when the fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const meta = await buildEventPreview('evt-1', 'https://getvents.com/?event=evt-1');
    expect(meta.title).toBe('VENTS');
  });

  it('falls back to the generic site preview, never throwing, on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => [] }));
    const meta = await buildEventPreview('evt-1', 'https://getvents.com/?event=evt-1');
    expect(meta.title).toBe('VENTS');
  });

  it('falls back safely when Supabase env vars are not configured', async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.VITE_SUPABASE_ANON_KEY;
    const meta = await buildEventPreview('evt-1', 'https://getvents.com/?event=evt-1');
    expect(meta.title).toBe('VENTS');
  });
});

describe('buildUserPreview', () => {
  it('returns the profile-specific title/image for a real public profile', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ full_name: 'Ada Lovelace', username: 'ada', avatar_url: 'https://cdn.example/ada.png' }],
      })
    );
    const meta = await buildUserPreview('user-1', 'https://getvents.com/?user=user-1');
    expect(meta.title).toBe('Ada Lovelace on VENTS');
    expect(meta.image).toBe('https://cdn.example/ada.png');
  });

  it('falls back to the generic site preview for a profile that is not publicly visible/does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    const meta = await buildUserPreview('private-user', 'https://getvents.com/?user=private-user');
    expect(meta.title).toBe('VENTS');
  });

  it('falls back to the generic site preview, never throwing, when the fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const meta = await buildUserPreview('user-1', 'https://getvents.com/?user=user-1');
    expect(meta.title).toBe('VENTS');
  });
});

describe('renderPreviewHtml', () => {
  it('embeds the given meta into og/twitter tags and escapes special characters', () => {
    const html = renderPreviewHtml({
      title: 'Rock & "Roll" <Fest>',
      description: 'desc',
      image: 'https://cdn.example/x.png',
      canonicalUrl: 'https://getvents.com/?event=abc',
    });
    expect(html).toContain('Rock &amp; &quot;Roll&quot; &lt;Fest&gt;');
    expect(html).toContain('og:image" content="https://cdn.example/x.png"');
    expect(html).toContain('rel="canonical" href="https://getvents.com/?event=abc"');
    expect(html).not.toContain('<script');
  });
});
