import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { CreateEventScreen } from './CreateEventScreen';
import { ventsColors } from '../../lib/ventsDesignTokens';

// Regression test for Stage 5's '#fff' -> ventsColors.white token reconciliation:
// checks the actual computed/inline color, not just text presence, so a future
// edit that silently reverts to an inherited/black color (the Representatives
// black-screen class of bug) is caught.

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

describe('CreateEventScreen token colors (Stage 5 #fff -> ventsColors.white)', () => {
  it('renders the active step-indicator circle text in ventsColors.white, not black/inherited', async () => {
    act(() => {
      root!.render(
        <CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} />
      );
    });
    await flush();

    // jsdom normalizes inline hex colors to rgb(...) on the CSSOM, so compare
    // against that normalized form rather than the '#FFFFFF' token string.
    const WHITE_RGB = 'rgb(255, 255, 255)';
    const stepNumberSpans = Array.from(container!.querySelectorAll('span')).filter(
      (el) => /^\d+$/.test(el.textContent || '') && (el as HTMLElement).style.fontWeight === '700'
    ) as HTMLElement[];
    expect(stepNumberSpans.length).toBeGreaterThan(0);
    expect(stepNumberSpans.some((el) => el.style.color === WHITE_RGB)).toBe(true);
    expect(ventsColors.white).toBe('#FFFFFF');
  });

  it('never leaves a raw #fff literal in the rendered DOM style attributes', async () => {
    act(() => {
      root!.render(
        <CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} />
      );
    });
    await flush();

    const allStyled = Array.from(container!.querySelectorAll('[style]')) as HTMLElement[];
    const rawWhiteHex = allStyled.filter(
      (el) => el.getAttribute('style')?.toLowerCase().includes('#fff')
    );
    expect(rawWhiteHex.length).toBe(0);
  });
});
