import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Apple App Store rejection (Guideline 1.5, submission 3098bebc-a2ff-43de-
//8b7e-358a82693200, Oct 14 2026): https://getvents.com/help did not direct
// reviewers to a functional support page. Root cause confirmed by reading
// App.tsx: it never reads window.location.pathname for routing, only query
// strings -- so hitting /help loaded the generic SPA shell (vercel.json's
// catch-all /(.*) -> /index.html) and landed on whatever the normal
// cold-start screen is, never the actual Help & Support content, and would
// have required auth to reach it in-app regardless.
//
// Fix: a self-contained static page (public/help.html, built into
// dist/help.html) served directly at /help via a dedicated rewrite placed
// BEFORE the SPA catch-all -- bypasses the React app, auth, and client-side
// routing entirely, so it can never fail to load for App Review regardless
// of app/auth state.

describe('/help: genuinely public, functional support page', () => {
  it('vercel.json routes /help to the static help.html BEFORE the SPA catch-all', () => {
    const vercelConfig = JSON.parse(readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
    const rewrites: Array<{ source: string; destination: string }> = vercelConfig.rewrites;
    const helpIdx = rewrites.findIndex((r) => r.source === '/help');
    const catchAllIdx = rewrites.findIndex((r) => r.source === '/(.*)');
    expect(helpIdx).toBeGreaterThan(-1);
    expect(rewrites[helpIdx].destination).toBe('/help.html');
    expect(catchAllIdx).toBeGreaterThan(-1);
    expect(helpIdx).toBeLessThan(catchAllIdx);
  });

  describe('public/help.html content', () => {
    let html: string;
    beforeAll(() => {
      html = readFileSync(join(__dirname, '..', '..', 'public', 'help.html'), 'utf8');
    });

    it('is a standalone document with no app bundle/auth dependency', () => {
      expect(html).toMatch(/<!DOCTYPE html>/i);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/main-[\w-]*\.js/);
    });

    it('displays support@getvents.com as a real contact method', () => {
      expect(html).toMatch(/mailto:support@getvents\.com/);
      expect(html.match(/support@getvents\.com/g)?.length).toBeGreaterThan(0);
    });

    it('provides guidance for account access, tickets, payments, and technical problems', () => {
      expect(html).toMatch(/Account access/i);
      expect(html).toMatch(/Tickets/i);
      expect(html).toMatch(/Payments/i);
      expect(html).toMatch(/Technical problems/i);
    });

    it('includes a working alternate contact method (WhatsApp)', () => {
      expect(html).toMatch(/wa\.me\/\d+/);
    });

    it('is responsive (no fixed (non-max-width) desktop-only layout, has a mobile viewport meta tag)', () => {
      expect(html).toMatch(/<meta name="viewport" content="width=device-width/);
      // A constraining max-width (readable line length) is fine; a plain
      // fixed `width:` in pixels would mean a non-responsive layout.
      expect(html).not.toMatch(/(?<!max-)width:\s*\d{3,}px/);
    });

    it('allows indexing (no noindex/robots block that would stop App Review\'s crawler)', () => {
      expect(html).not.toMatch(/noindex/i);
    });
  });
});
