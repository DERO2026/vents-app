// Social-preview (crawler unfurl) metadata builder, shared between
// middleware.ts (the actual Edge runtime handler) and its unit tests.
//
// Root cause (BUG REPORT: share links resolve to generic www.getvents.com):
// index.html's og:title/og:description/og:image/canonical are static,
// site-wide values. Actual in-app navigation for a shared
// https://getvents.com/?event=<id> or ?user=<id> link already works
// correctly (App.tsx's hydrateAuth parses the query param and navigates --
// see shareLink.test.ts's existing coverage of that). But a crawler/bot
// (Facebook/Twitter/Slack/WhatsApp/Discord/LinkedIn/Telegram/iMessage link
// preview, etc.) never runs the JS bundle -- it just reads whatever HTML
// index.html serves, which is the same generic "VENTS" card for every URL
// regardless of ?event=/?user=. That mismatch is exactly the reported
// symptom. This module builds the per-event/per-user HTML a bot should see
// instead; a normal browser is never routed through it (see middleware.ts).

const BOT_USER_AGENT_RE =
  /facebookexternalhit|facebookcatalog|twitterbot|slackbot|whatsapp|discordbot|linkedinbot|telegrambot|pinterest|redditbot|vkshare|skypeuripreview|iframely|embedly|w3c_validator|outbrain|quora link preview|showyoubot|applebot/i;

export function isCrawlerUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return BOT_USER_AGENT_RE.test(userAgent);
}

export interface PreviewMeta {
  title: string;
  description: string;
  image: string;
  canonicalUrl: string;
}

const FALLBACK_IMAGE = 'https://getvents.com/og-image.png';
const SITE_DEFAULT: Omit<PreviewMeta, 'canonicalUrl'> = {
  title: 'VENTS',
  description:
    'Discover and book events in Nigeria with a user-friendly platform that offers ticket purchasing, event categories, and personalized recommendations.',
  image: FALLBACK_IMAGE,
};

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

// Fetches only public, non-sensitive fields -- never organizer contact info,
// payout details, ticket/revenue numbers, etc. Returns the safe site-default
// preview (never throws, never leaks partial data) for a missing, deleted,
// or otherwise unavailable event, exactly like a real browser's own
// ?event= handler in App.tsx treats a deleted/not-found event.
export async function buildEventPreview(eventId: string, canonicalUrl: string): Promise<PreviewMeta> {
  const env = getSupabaseEnv();
  if (!env) return { ...SITE_DEFAULT, canonicalUrl };
  try {
    const restUrl =
      `${env.url}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}` +
      `&select=title,venue,city,image_url,deleted_at&limit=1`;
    const res = await fetch(restUrl, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` },
    });
    if (!res.ok) return { ...SITE_DEFAULT, canonicalUrl };
    const rows = (await res.json()) as Array<{
      title?: string;
      venue?: string;
      city?: string;
      image_url?: string;
      deleted_at?: string | null;
    }>;
    const event = rows?.[0];
    if (!event || event.deleted_at) return { ...SITE_DEFAULT, canonicalUrl };
    const location = [event.venue, event.city].filter(Boolean).join(', ');
    return {
      title: event.title ? `${event.title} | VENTS` : SITE_DEFAULT.title,
      description: location ? `${location} · Get your tickets on VENTS` : SITE_DEFAULT.description,
      image: event.image_url || FALLBACK_IMAGE,
      canonicalUrl,
    };
  } catch {
    return { ...SITE_DEFAULT, canonicalUrl };
  }
}

// Same safety contract as buildEventPreview: public_profiles is already the
// RLS/view-scoped public surface (same one App.tsx's own ?user= handler
// queries), and only non-sensitive display fields are read.
export async function buildUserPreview(userId: string, canonicalUrl: string): Promise<PreviewMeta> {
  const env = getSupabaseEnv();
  if (!env) return { ...SITE_DEFAULT, canonicalUrl };
  try {
    const restUrl =
      `${env.url}/rest/v1/public_profiles?id=eq.${encodeURIComponent(userId)}` +
      `&select=full_name,username,avatar_url&limit=1`;
    const res = await fetch(restUrl, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` },
    });
    if (!res.ok) return { ...SITE_DEFAULT, canonicalUrl };
    const rows = (await res.json()) as Array<{ full_name?: string; username?: string; avatar_url?: string }>;
    const profile = rows?.[0];
    if (!profile) return { ...SITE_DEFAULT, canonicalUrl };
    const name = profile.full_name || profile.username;
    return {
      title: name ? `${name} on VENTS` : SITE_DEFAULT.title,
      description: SITE_DEFAULT.description,
      image: profile.avatar_url || FALLBACK_IMAGE,
      canonicalUrl,
    };
  } catch {
    return { ...SITE_DEFAULT, canonicalUrl };
  }
}

// Same safety contract as buildEventPreview/buildUserPreview: only public,
// non-sensitive fields (never payout/contact info), and the
// status=approved filter mirrors both service_providers_public_select_
// approved (RLS) and fetchServiceProviderById's own query -- an
// unapproved, removed, or unknown provider id resolves to the safe
// site-default here exactly like App.tsx's own ?provider= handler treats
// a null fetchServiceProviderById result.
export async function buildProviderPreview(providerId: string, canonicalUrl: string): Promise<PreviewMeta> {
  const env = getSupabaseEnv();
  if (!env) return { ...SITE_DEFAULT, canonicalUrl };
  try {
    const restUrl =
      `${env.url}/rest/v1/service_providers?id=eq.${encodeURIComponent(providerId)}` +
      `&select=business_name,category,location,photo_urls,status&limit=1`;
    const res = await fetch(restUrl, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` },
    });
    if (!res.ok) return { ...SITE_DEFAULT, canonicalUrl };
    const rows = (await res.json()) as Array<{
      business_name?: string;
      category?: string;
      location?: string;
      photo_urls?: string[];
      status?: string;
    }>;
    const provider = rows?.[0];
    if (!provider || provider.status !== 'approved') return { ...SITE_DEFAULT, canonicalUrl };
    const location = [provider.category, provider.location].filter(Boolean).join(' · ');
    return {
      title: provider.business_name ? `${provider.business_name} | VENTS` : SITE_DEFAULT.title,
      description: location ? `${location} · Book on VENTS` : SITE_DEFAULT.description,
      image: provider.photo_urls?.[0] || FALLBACK_IMAGE,
      canonicalUrl,
    };
  } catch {
    return { ...SITE_DEFAULT, canonicalUrl };
  }
}

// Renders the full HTML document a crawler receives, with per-content
// og/twitter meta swapped in. Deliberately minimal (no app bundle, no
// script tag) -- crawlers don't execute JS anyway, and this must never
// double as something a real user gets served.
export function renderPreviewHtml(meta: PreviewMeta): string {
  const { title, description, image, canonicalUrl } = meta;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="${esc(canonicalUrl)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="VENTS" />
<meta property="og:url" content="${esc(canonicalUrl)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:image" content="${esc(image)}" />
<meta property="og:image:secure_url" content="${esc(image)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${esc(image)}" />
</head>
<body></body>
</html>`;
}
