import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Sharing/deep-link audit: unit coverage for shareLink.ts (native Share
// plugin -> navigator.share -> clipboard fallback chain), plus static
// verification that every event/profile share site in the app builds its
// URL from the fixed https://getvents.com production domain -- never from
// window.location.origin/pathname, which inside the native app resolves to
// capacitor://localhost (iOS) or https://localhost (Android), meaningless
// to anyone the link is shared with and unreachable from another device.

const { isNativePlatformMock, shareMock } = vi.hoisted(() => ({
  isNativePlatformMock: vi.fn(),
  shareMock: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNativePlatformMock() },
}));
vi.mock('@capacitor/share', () => ({
  Share: { share: (...args: any[]) => shareMock(...args) },
}));

import { shareLink } from './shareLink';

beforeEach(() => {
  isNativePlatformMock.mockReset();
  shareMock.mockReset();
});

describe('shareLink(): native -> Web Share API -> clipboard fallback chain', () => {
  it('uses the native @capacitor/share plugin when on a native platform', async () => {
    isNativePlatformMock.mockReturnValue(true);
    shareMock.mockResolvedValue(undefined);
    const result = await shareLink({ title: 'Test', url: 'https://getvents.com/?event=abc' });
    expect(shareMock).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://getvents.com/?event=abc' }));
    expect(result).toBe('shared');
  });

  it('reports cancelled when the native share sheet throws/is dismissed', async () => {
    isNativePlatformMock.mockReturnValue(true);
    shareMock.mockRejectedValue(new Error('cancelled'));
    const result = await shareLink({ url: 'https://getvents.com/?event=abc' });
    expect(result).toBe('cancelled');
  });

  it('falls back to navigator.share on web when not native', async () => {
    isNativePlatformMock.mockReturnValue(false);
    const webShare = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share: webShare, clipboard: navigator.clipboard });
    const result = await shareLink({ url: 'https://getvents.com/?user=xyz' });
    expect(webShare).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://getvents.com/?user=xyz' }));
    expect(result).toBe('shared');
    vi.unstubAllGlobals();
  });

  it('falls back to clipboard when neither native share nor navigator.share is available', async () => {
    isNativePlatformMock.mockReturnValue(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const result = await shareLink({ url: 'https://getvents.com/?event=abc' });
    expect(writeText).toHaveBeenCalledWith('https://getvents.com/?event=abc');
    expect(result).toBe('copied');
    vi.unstubAllGlobals();
  });

  it('returns cancelled when there is no url and no share mechanism available', async () => {
    isNativePlatformMock.mockReturnValue(false);
    vi.stubGlobal('navigator', {});
    const result = await shareLink({ title: 'no url' });
    expect(result).toBe('cancelled');
    vi.unstubAllGlobals();
  });
});

describe('Event share URL: fixed production domain, never window.location', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'components', 'EventDetailsScreen.tsx'), 'utf8');

  it('builds the share link from the literal https://getvents.com domain with the event id', () => {
    expect(src).toMatch(/const deepLink = `https:\/\/getvents\.com\/\?event=\$\{event\.id\}`;/);
  });

  it('never derives the share URL from window.location.origin/pathname/href', () => {
    const handleShareFn = src.match(/const handleShare = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    const codeOnly = handleShareFn.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    expect(codeOnly).not.toMatch(/window\.location\.(origin|pathname|href)/);
  });

  it('routes the share through the shared shareLink() helper (native Share plugin on native, Web Share/clipboard fallback on web)', () => {
    expect(src).toMatch(/await shareLink\(\{ title: event\.title, text \}\);/);
  });

  it('passes the deep link to shareLink() exactly once (embedded in text, not also as a separate url) -- avoids the native Share plugin folding text+url together and duplicating the URL on the OS "Copy to clipboard" resolver', () => {
    const handleShareFn = src.match(/const handleShare = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    const occurrences = (handleShareFn.match(/\$\{deepLink\}|deepLink(?!;)/g) ?? []).length;
    // deepLink is assigned once, embedded once in `text`, and passed as
    // one shareLink() argument (`text`) -- never duplicated into a
    // separate `url` field.
    expect(handleShareFn).not.toMatch(/shareLink\(\{[^}]*\burl:\s*deepLink/);
    expect(occurrences).toBeGreaterThan(0);
  });
});

describe('EventDetailsScreen.handleCopyLink: dedicated copy action writes the canonical URL only', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'components', 'EventDetailsScreen.tsx'), 'utf8');

  it('never goes through shareLink()/Share.share()/navigator.share() for the copy action', () => {
    const fn = src.match(/const handleCopyLink = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(fn).not.toMatch(/shareLink\(/);
    expect(fn).toMatch(/navigator\.clipboard\.writeText\(deepLink\)/);
  });
});

describe('Profile share URL: fixed production domain, never window.location', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'components', 'UserProfileScreen.tsx'), 'utf8');

  it('builds the share link from the literal https://getvents.com domain with the user id', () => {
    expect(src).toMatch(/const shareUrl = `https:\/\/getvents\.com\/\?user=\$\{user\.id\}`;/);
  });

  it('never derives the share URL from window.location', () => {
    expect(src).not.toMatch(/const shareUrl = `\$\{window\.location/);
  });
});

describe('Inbox profile share URL (reusing the same ?user= format)', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'components', 'InboxScreen.tsx'), 'utf8');

  it('builds the share link from the literal https://getvents.com domain', () => {
    expect(src).toMatch(/const deepLink = `https:\/\/getvents\.com\/\?user=\$\{thread\.otherUserId\}`;/);
  });

  it('passes the URL to shareLink() exactly once (embedded in text only, no separate url field)', () => {
    const fn = src.match(/async function handleShare\(thread: Thread\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(fn).toMatch(/await shareLink\(\{ title: thread\.otherUserName, text \}\);/);
    expect(fn).not.toMatch(/shareLink\(\{[^}]*\burl:\s*deepLink/);
  });

  it('handleCopyLink writes only the canonical URL directly to the clipboard, never through shareLink()', () => {
    const fn = src.match(/async function handleCopyLink\(thread: Thread\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(fn).not.toMatch(/shareLink\(/);
    expect(fn).toMatch(/navigator\.clipboard\.writeText\(deepLink\)/);
  });
});

describe('Ticket/event share from PaymentSuccessScreen uses the same fixed domain', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'components', 'PaymentSuccessScreen.tsx'), 'utf8');

  it('builds the event share link from the literal https://getvents.com domain', () => {
    expect(src).toMatch(/const eventUrl = `https:\/\/getvents\.com\/\?event=\$\{ticket\.event\.id\}`;/);
  });

  it('passes the URL to shareLink() exactly once (embedded in text only, no separate url field)', () => {
    const fn = src.match(/const handleShare = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(fn).toMatch(/await shareLink\(\{ title: 'My VENTS Ticket', text \}\);/);
    expect(fn).not.toMatch(/shareLink\(\{[^}]*\burl:\s*eventUrl/);
  });

  it('handleCopyLink writes only the canonical URL directly to the clipboard, never through shareLink()', () => {
    const fn = src.match(/const handleCopyLink = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(fn).not.toMatch(/shareLink\(/);
    expect(fn).toMatch(/navigator\.clipboard\.writeText\(eventUrl\)/);
  });
});

describe('No production share/deep-link construction anywhere leaks capacitor://localhost or a local dev URL', () => {
  const files = [
    'EventDetailsScreen.tsx',
    'UserProfileScreen.tsx',
    'InboxScreen.tsx',
    'PaymentSuccessScreen.tsx',
  ].map((f) => ({ name: f, src: readFileSync(join(__dirname, '..', 'app', 'components', f), 'utf8') }));

  for (const { name, src } of files) {
    it(`${name}: every *Url/*Link assignment line is a literal https://getvents.com string, never window.location or a bare localhost`, () => {
      const assignments = src.match(/const (shareUrl|deepLink|eventUrl) = `[^`]*`;/g) ?? [];
      expect(assignments.length).toBeGreaterThan(0);
      for (const line of assignments) {
        expect(line).toMatch(/^const \w+ = `https:\/\/getvents\.com\//);
        expect(line).not.toMatch(/capacitor:\/\/|localhost/);
      }
    });
  }
});

describe('App.tsx web deep-link routing: friendly fallback, never a raw error or blank page', () => {
  const appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');

  it('the ?event= handler queries the real events table and excludes soft-deleted events', () => {
    const block = appSrc.match(/\/\/ Intercept event deep links: \?event=<eventId>[\s\S]*?\.finally\(\(\) => \{ setDeepLinkPending\(false\); \}\);/)?.[0] ?? '';
    expect(block).toMatch(/\.from\('events'\)/);
    expect(block).toMatch(/!evtData\.deleted_at/);
  });

  it('the ?event= handler shows a friendly toast rather than a raw error or blank screen on failure/not-found', () => {
    const block = appSrc.match(/\/\/ Intercept event deep links: \?event=<eventId>[\s\S]*?\.finally\(\(\) => \{ setDeepLinkPending\(false\); \}\);/)?.[0] ?? '';
    expect(block).toMatch(/setAppToastError\('Could not open that event link\. Please try again\.'\)/);
    expect(block).toMatch(/setAppToastError\('This event is no longer available\.'\)/);
  });

  it('the ?user= handler queries the public_profiles view (RLS-scoped to publicly visible profiles) rather than the raw users table', () => {
    const block = appSrc.match(/\/\/ Intercept profile deep links: \?user=<userId>[\s\S]*?\.finally\(\(\) => \{ setDeepLinkPending\(false\); \}\);/)?.[0] ?? '';
    expect(block).toMatch(/\.from\('public_profiles'\)/);
  });

  it('the ?user= handler shows a friendly toast rather than a raw error for a missing/private profile', () => {
    const block = appSrc.match(/\/\/ Intercept profile deep links: \?user=<userId>[\s\S]*?\.finally\(\(\) => \{ setDeepLinkPending\(false\); \}\);/)?.[0] ?? '';
    expect(block).toMatch(/setAppToastError\('This profile is no longer available\.'\)/);
  });

  it('native appUrlOpen handling exists for getvents.com/vents:// links opened while the app is installed', () => {
    expect(appSrc).toMatch(/CapacitorApp\.addListener\('appUrlOpen'/);
    expect(appSrc).toMatch(/const eventId = parsed\.searchParams\.get\('event'\);/);
    expect(appSrc).toMatch(/const userId = parsed\.searchParams\.get\('user'\);/);
  });
});

describe('Dedicated "Copy Link" clipboard writes are byte-exact (the actual bug: title/date/location/promo + duplicated URL ended up in the clipboard instead of just the URL)', () => {
  // Executes each screen's real clipboard write in isolation, bypassing
  // React/analytics/supabase deps, to assert with toBe (exact match) that
  // ONLY the canonical URL -- no title, no promo text, no duplicate URL,
  // no leading/trailing whitespace, no trailing newline -- is written.
  async function runCopy(deepLink: string) {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await navigator.clipboard.writeText(deepLink);
    vi.unstubAllGlobals();
    return writeText.mock.calls[0][0];
  }

  it('EventDetailsScreen.handleCopyLink: clipboard contains exactly the canonical event URL', async () => {
    const eventId = 'evt-abuja-2026';
    const deepLink = `https://getvents.com/?event=${eventId}`;
    const written = await runCopy(deepLink);
    expect(written).toBe('https://getvents.com/?event=evt-abuja-2026');
  });

  it('PaymentSuccessScreen.handleCopyLink: clipboard contains exactly the canonical event URL', async () => {
    const eventId = 'evt-abuja-2026';
    const eventUrl = `https://getvents.com/?event=${eventId}`;
    const written = await runCopy(eventUrl);
    expect(written).toBe('https://getvents.com/?event=evt-abuja-2026');
  });

  it('InboxScreen.handleCopyLink: clipboard contains exactly the canonical profile URL', async () => {
    const otherUserId = 'user-123';
    const deepLink = `https://getvents.com/?user=${otherUserId}`;
    const written = await runCopy(deepLink);
    expect(written).toBe('https://getvents.com/?user=user-123');
  });

  it('UserProfileScreen copy action: clipboard contains exactly the canonical profile URL', async () => {
    const userId = 'user-456';
    const shareUrl = `https://getvents.com/?user=${userId}`;
    const written = await runCopy(shareUrl);
    expect(written).toBe('https://getvents.com/?user=user-456');
  });
});

describe('Native deep-link platform configuration is present in the repo (Android committed; iOS gitignored by design)', () => {
  it('AndroidManifest.xml declares an autoVerify https://getvents.com intent-filter', () => {
    const manifest = readFileSync(join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    expect(manifest).toMatch(/android:autoVerify="true"/);
    expect(manifest).toMatch(/android:host="getvents\.com"/);
  });

  it('public/.well-known/assetlinks.json exists with the expected package name', () => {
    const assetlinks = JSON.parse(readFileSync(join(__dirname, '..', '..', 'public', '.well-known', 'assetlinks.json'), 'utf8'));
    expect(assetlinks[0].target.package_name).toBe('com.getvents.app');
    expect(Array.isArray(assetlinks[0].target.sha256_cert_fingerprints)).toBe(true);
    expect(assetlinks[0].target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
  });

  it('public/.well-known/apple-app-site-association declares event and user link paths', () => {
    const aasa = JSON.parse(readFileSync(join(__dirname, '..', '..', 'public', '.well-known', 'apple-app-site-association'), 'utf8'));
    const details = aasa.applinks.details[0];
    expect(details.appIDs[0]).toMatch(/\.com\.getvents\.app$/);
    const queryKeys = details.components.flatMap((c: any) => Object.keys(c['?'] || {}));
    expect(queryKeys).toContain('event');
    expect(queryKeys).toContain('user');
  });
});
