import {
  isCrawlerUserAgent,
  buildEventPreview,
  buildUserPreview,
  renderPreviewHtml,
} from './api/_lib/socialPreview';

// Vercel Edge Middleware -- does NOT count against the Hobby plan's
// serverless function cap (api/ is already at exactly 12, the hard limit;
// see AGENTS.md / the task's own note). Runs in front of vercel.json's
// catch-all `/(.*) -> /index.html` rewrite.
//
// Fixes the reported "share links resolve to generic www.getvents.com"
// bug for link-preview crawlers (see api/_lib/socialPreview.ts for the full
// root-cause writeup): a known bot UA requesting `/?event=<id>` or
// `/?user=<id>` gets back HTML with that specific event's/user's
// og:title/og:description/og:image/canonical instead of the site-wide
// default. A normal browser (any UA that doesn't match the bot list) is
// passed through completely unchanged -- same SPA, same index.html, same
// client-side ?event=/?user= handling in App.tsx's hydrateAuth as before.
export const config = {
  matcher: '/',
};

export default async function middleware(req: Request) {
  const userAgent = req.headers.get('user-agent');
  if (!isCrawlerUserAgent(userAgent)) {
    return undefined; // fall through to the normal static/rewrite pipeline
  }

  const url = new URL(req.url);
  const eventId = url.searchParams.get('event');
  const userId = url.searchParams.get('user');
  if (!eventId && !userId) {
    return undefined;
  }

  const canonicalUrl = `https://getvents.com${url.pathname}${url.search}`;

  try {
    const meta = eventId
      ? await buildEventPreview(eventId, canonicalUrl)
      : await buildUserPreview(userId as string, canonicalUrl);
    return new Response(renderPreviewHtml(meta), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  } catch {
    // Never let a preview-generation failure take down the page for a
    // crawler (or, worse, a misclassified real user) -- fall through to the
    // normal SPA response exactly as if no event/user param were present.
    return undefined;
  }
}
