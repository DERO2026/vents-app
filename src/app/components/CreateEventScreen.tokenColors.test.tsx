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

  it('draws the completed-step check at >= 3:1 against its success-green circle', async () => {
    act(() => {
      root!.render(
        <CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} />
      );
    });
    await flush();

    // Complete step 1 (title + one category) and advance, so step 1 renders as done.
    const titleInput = container!.querySelector('input[placeholder="e.g. Afrobeats Night 2026"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(titleInput, 'Test Night');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const music = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Music')!;
    act(() => { music.click(); });
    const next = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'))!;
    await act(async () => { next.click(); });
    await flush();

    const check = container!.querySelector('[data-testid="create-event-step-done-1"]') as SVGElement;
    expect(check).toBeTruthy();
    const circle = check.parentElement as HTMLElement;
    const toRgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    expect(getComputedStyle(circle).backgroundColor).toBe(toRgb(ventsColors.success));
    const iconColor = check.getAttribute('stroke')!;
    expect(iconColor).toBe(ventsColors.bg);

    const lum = (rgb: string) => {
      const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map((v) => {
        const c = Number(v) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(getComputedStyle(circle).backgroundColor), lum(toRgb(iconColor))].sort((x, y) => y - x);
    expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThanOrEqual(3);
  });
});
