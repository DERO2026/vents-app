import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WelcomeScreen } from './WelcomeScreen';

// Reported bug: on a short Safari viewport (address/tab-bar chrome eating
// into 100dvh, which .phone-frame already correctly uses), WelcomeScreen's
// fixed vertical paddings/margins (48px header, 34px headline, 24px stack
// margin + 236px min-height, 24px action padding, 16px gaps) summed to more
// than the available height, pushing "Already have an account?", "Browse
// as guest", and the App Store/Google Play badges out of comfortable view
// under .phone-frame's overflow:hidden.
//
// Fix: every one of those fixed values is now a dvh-scaled clamp() instead
// of a fixed px number, so the WHOLE composition compresses together on a
// short viewport (not one element moved/reordered) while settling at
// (approximately) its original fixed value on a tall viewport, leaving
// desktop/tablet visually unchanged. This is a CSS responsiveness property,
// not something jsdom can verify by rendering at a given pixel height (it
// doesn't compute real layout) -- and jsdom's CSSOM/style-attribute
// serialization outright drops a padding/margin SHORTHAND when any one of
// its space-separated values nests calc(clamp()+env()) (confirmed: it kept
// standalone min-height/max-height/gap declarations using the same
// clamp()/dvh functions just fine). So padding/margin are verified by
// reading the actual source text below; min-height/max-height/gap (which
// jsdom does preserve) are verified via the real rendered DOM. Multi-
// viewport pixel-level verification needs an actual browser, unavailable
// in this session.

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let src: string;

beforeAll(() => {
  src = readFileSync(join(__dirname, 'WelcomeScreen.tsx'), 'utf8');
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} onBrowseGuest={() => {}} />);
  });
}

function divs() { return Array.from(container!.querySelectorAll('div')); }

describe('WelcomeScreen source: fixed-px vertical paddings/margins replaced with dvh-scaled clamp()', () => {
  it('header top padding is a dvh-scaled clamp(), not the old fixed 48px', () => {
    expect(src).toContain("padding: 'calc(clamp(16px, 5dvh, 40px) + env(safe-area-inset-top)) 24px 0'");
    expect(src).not.toContain("'calc(48px + env(safe-area-inset-top)) 24px 0'");
  });

  it('headline block top padding is a dvh-scaled clamp(), not the old fixed 34px', () => {
    expect(src).toContain("padding: 'clamp(16px, 3dvh, 28px) 24px 0'");
    expect(src).not.toContain("padding: '34px 24px 0'");
  });

  it('image-stack top margin is a dvh-scaled clamp(), not the old fixed 24px', () => {
    expect(src).toContain("margin: 'clamp(10px, 2.5dvh, 20px) 0 0'");
    expect(src).not.toContain("margin: '24px 0 0'");
  });

  it('bottom actions padding is a dvh-scaled clamp() on both top and bottom, not the old fixed 24px', () => {
    expect(src).toContain("padding: 'clamp(12px, 2.5dvh, 24px) 24px calc(clamp(12px, 2.5dvh, 24px) + env(safe-area-inset-bottom))'");
  });
});

describe('WelcomeScreen rendered DOM: the clamp()/dvh values jsdom does preserve', () => {
  it('image-stack min-height/max-height resolve to the intended clamp and preserved upper bound', async () => {
    await render();
    const stack = divs().find(d => (d.getAttribute('style') || '').includes('min-height: clamp'));
    expect(stack).toBeTruthy();
    expect(stack!.getAttribute('style')).toContain('min-height: clamp(160px, 24dvh, 236px)');
    // Upper bound preserved exactly -- tall-viewport/desktop behavior unchanged
    expect(stack!.getAttribute('style')).toContain('max-height: 260px');
  });

  it('bottom actions gap resolves to the intended clamp', async () => {
    await render();
    const getStartedBtn = Array.from(container!.querySelectorAll('button')).find(b => b.textContent === 'Get Started');
    const actions = getStartedBtn?.parentElement;
    expect(actions?.getAttribute('style')).toContain('gap: clamp(10px, 2dvh, 16px)');
  });

  it('visual order is unchanged: logo, headline, cards, Get Started, login, guest, get-the-app', async () => {
    await render();
    const text = container!.textContent || '';
    const order = [
      'More Than Events.',
      'Tickets, services',
      'Get Started',
      'Already have an account?',
      'Browse as guest',
      'Get the app',
    ];
    let lastIndex = -1;
    for (const needle of order) {
      const idx = text.indexOf(needle);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('no element was removed: store badges and all action links still render', async () => {
    await render();
    expect(container!.textContent).toContain('App Store');
    expect(container!.textContent).toContain('Google Play');
    expect(container!.textContent).toContain('Log in');
  });
});
