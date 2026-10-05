import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { CreateEventScreen } from './CreateEventScreen';

// Regression test for the "My Events -> Edit Event" vertical scrolling bug:
// the step-content container (flex:1, overflowY:'auto') had no explicit
// min-height:0, so WebKit/iOS let it grow to its content's intrinsic
// height instead of being clamped by the flex column -- the exact pattern
// every OTHER flex:1/overflowY:'auto' scroll container in this codebase
// (PromoteEventScreen, SettingsScreen, WalletScreen) already guards
// against. This only asserts the real inline style that fixes it, since
// jsdom can't measure actual scroll/overflow behavior.

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
          order: () => Promise.resolve({ data: [], error: null }),
          single: () => Promise.resolve({ data: null, error: { message: 'not found' } }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));
vi.mock('../../lib/permissions', () => ({ hasCapability: () => true }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {}, captureMessage: () => {} } }));
vi.mock('canvas-confetti', () => ({ default: () => {} }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  // jsdom doesn't implement Element.scrollTo -- the component calls it on
  // its own scroll-reset effect, unrelated to what this test checks.
  if (!(Element.prototype as any).scrollTo) (Element.prototype as any).scrollTo = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const CURRENT_USER = { id: 'user-1', email: 'org@vents.test', full_name: 'Org User', role: 'organizer', isOrganizer: true, country: 'NG' };

describe('CreateEventScreen scroll container (My Events -> Edit Event / Create Event)', () => {
  it('sets min-height:0 on the flex:1 scroll container, the real fix for the broken-scroll bug', async () => {
    act(() => {
      root!.render(
        <CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} />
      );
    });
    await flush();

    const scrollDiv = Array.from(container!.querySelectorAll('div')).find(
      (d) => d.style.overflowY === 'auto'
    ) as HTMLDivElement | undefined;
    expect(scrollDiv).toBeTruthy();
    expect(scrollDiv!.style.minHeight).toBe('0px');
    expect(scrollDiv!.style.flex).toBe('1 1 0%');
  });

  it('keeps the same min-height:0 scroll container in edit mode (editEventId set)', async () => {
    act(() => {
      root!.render(
        <CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} editEventId="event-1" />
      );
    });
    await flush();

    const scrollDiv = Array.from(container!.querySelectorAll('div')).find(
      (d) => d.style.overflowY === 'auto'
    ) as HTMLDivElement | undefined;
    expect(scrollDiv).toBeTruthy();
    expect(scrollDiv!.style.minHeight).toBe('0px');
  });
});
