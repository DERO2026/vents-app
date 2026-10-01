import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { WelcomeScreen } from './WelcomeScreen';

// Website/landing-page audit: VENTS had no download CTA anywhere in the
// SPA (getvents.com serves this same app directly, per vercel.json's
// catch-all rewrite to /index.html -- there is no separate marketing
// site). This adds a web-only "Get the app" section to the existing
// entry screen using the real, live store URLs, without touching the
// existing Get Started / Already have an account / Browse as guest flows.

let isNativePlatform = false;
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  isNativePlatform = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

describe('WelcomeScreen download CTA', () => {
  it('shows App Store and Google Play badges pointing to the real, live store listings on web', async () => {
    await act(async () => {
      root!.render(<WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} onBrowseGuest={() => {}} />);
    });
    const links = Array.from(container!.querySelectorAll('a'));
    const appStoreLink = links.find((a) => a.getAttribute('href') === 'https://apps.apple.com/ng/app/vents-events/id6802584284');
    const playStoreLink = links.find((a) => a.getAttribute('href') === 'https://play.google.com/store/apps/details?id=com.getvents.app');
    expect(appStoreLink).toBeTruthy();
    expect(playStoreLink).toBeTruthy();
    expect(appStoreLink!.getAttribute('target')).toBe('_blank');
    expect(appStoreLink!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(playStoreLink!.getAttribute('target')).toBe('_blank');
    expect(playStoreLink!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('hides the download CTA inside the native app shell -- it is already installed there', async () => {
    isNativePlatform = true;
    await act(async () => {
      root!.render(<WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} onBrowseGuest={() => {}} />);
    });
    const links = Array.from(container!.querySelectorAll('a'));
    expect(links.find((a) => a.getAttribute('href')?.includes('apps.apple.com'))).toBeUndefined();
    expect(links.find((a) => a.getAttribute('href')?.includes('play.google.com'))).toBeUndefined();
  });

  it('keeps the existing Get Started / Log in / Browse as guest actions intact alongside the new CTA', async () => {
    const onGetStarted = vi.fn();
    const onSignIn = vi.fn();
    const onBrowseGuest = vi.fn();
    await act(async () => {
      root!.render(<WelcomeScreen onGetStarted={onGetStarted} onSignIn={onSignIn} onBrowseGuest={onBrowseGuest} />);
    });
    expect(container!.textContent).toContain('Get Started');
    expect(container!.textContent).toContain('Already have an account?');
    expect(container!.textContent).toContain('Browse as guest');

    const getStartedBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Get Started');
    await act(async () => { getStartedBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onGetStarted).toHaveBeenCalled();
  });
});
