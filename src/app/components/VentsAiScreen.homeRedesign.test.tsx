import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiScreen } from './VentsAiScreen';

// Regression coverage for the VENTS AI Home redesign: the dimensional 3D
// orb (never the old flat star/glyph), the rotating headline (respecting
// prefers-reduced-motion), the compact anchored Mood/Budget/Area popovers
// (never a fullscreen PickerSheet), custom budget entry, and the Area
// control's profile-country default.

const sendVentsAiMessage = vi.fn();
vi.mock('../../lib/ventsAi', () => ({
  sendVentsAiMessage: (...args: any[]) => sendVentsAiMessage(...args),
}));

vi.mock('../../lib/googleMaps', () => ({
  loadGoogleMaps: () => Promise.resolve(),
}));

const rpc = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
    rpc: (...args: any[]) => rpc(...args),
  },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  sendVentsAiMessage.mockReset();
  rpc.mockReset();
});

async function mount(props: Partial<React.ComponentProps<typeof VentsAiScreen>> = {}) {
  rpc.mockImplementation((name: string) => {
    if (name === 'get_plans_overview') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<VentsAiScreen onClose={() => {}} {...(props as any)} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('VentsAiScreen Home: dimensional 3D orb', () => {
  it('renders a layered gradient orb, never the old flat star glyph', async () => {
    await mount();
    expect(container!.textContent).not.toContain('★');
    expect(container!.textContent).not.toContain('✦');
    const radialLayers = Array.from(container!.querySelectorAll('div')).filter(
      (el) => (el as HTMLElement).style.background?.includes('radial-gradient'),
    );
    expect(radialLayers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('VentsAiScreen Home: rotating headline', () => {
  it('renders one of the approved rotating headlines', async () => {
    await mount();
    const headline = container!.querySelector('[data-testid="vents-ai-headline"]');
    expect(headline).toBeTruthy();
    expect(headline!.textContent?.length).toBeGreaterThan(0);
  });

  it('does not rotate when prefers-reduced-motion is set', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as any;
    await mount();
    const headline = container!.querySelector('[data-testid="vents-ai-headline"]');
    const first = headline!.textContent;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3000));
    });
    expect(headline!.textContent).toBe(first);
    window.matchMedia = originalMatchMedia;
  });

  it('reserves a fixed-height wrapper around the headline so rotation never reflows the rest of the screen', async () => {
    // jsdom has no real layout engine (getBoundingClientRect is always
    // zero), so this can't measure actual pixel movement -- it instead
    // asserts the structural guarantee: the headline's wrapper declares
    // an explicit minHeight (never 'auto'), which is what makes a
    // longer/shorter rotated phrase incapable of reflowing the orb,
    // toggle or composer below it.
    await mount();
    const headline = container!.querySelector('[data-testid="vents-ai-headline"]') as HTMLElement;
    const wrapper = headline.parentElement as HTMLElement;
    expect(wrapper.style.minHeight).not.toBe('');
    expect(wrapper.style.minHeight).not.toBe('auto');
  });

  it('every rotating headline is a short, single-line phrase (no long sentence that would wrap and grow the wrapper)', async () => {
    // Advance through all 4 rotation slots and check each phrase actually
    // rendered is short -- a long phrase defeats the fixed-height wrapper
    // by wrapping to two lines within it. Uses real timers, so this test
    // is given a longer-than-default timeout to cover all 4 ~2.5s ticks.
    await mount();
    for (let i = 0; i < 4; i++) {
      const headline = container!.querySelector('[data-testid="vents-ai-headline"]') as HTMLElement;
      expect(headline.textContent!.length).toBeLessThanOrEqual(28);
      await act(async () => { await new Promise((r) => setTimeout(r, 2600)); });
    }
  }, 20000);
});

describe('VentsAiScreen Home: compact anchored popovers (never fullscreen)', () => {
  it('opening the Area popover does not add a new fullscreen (position:fixed, inset:0) overlay', async () => {
    await mount();
    const countFullscreenOverlays = () =>
      Array.from(container!.querySelectorAll('div')).filter((el) => {
        const s = (el as HTMLElement).style;
        return s.position === 'fixed' && s.inset === '0px';
      }).length;
    const before = countFullscreenOverlays();

    const areaChip = container!.querySelector('[data-testid="vents-ai-tune-area"]') as HTMLElement;
    act(() => { areaChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(countFullscreenOverlays()).toBe(before);

    const popover = container!.querySelector('[aria-label="area options"]') as HTMLElement;
    expect(popover).toBeTruthy();
    expect(popover.style.position).toBe('absolute');
  });

  it('uses the profile country as internal default context, without a country list to pick from', async () => {
    await mount({ currentUserCountryIso: 'NG' } as any);
    const areaChip = container!.querySelector('[data-testid="vents-ai-tune-area"]') as HTMLElement;
    // The chip itself starts labeled with the profile country -- real
    // default context the user never had to choose.
    expect(areaChip.textContent).toContain('Nigeria');

    act(() => { areaChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const popover = container!.querySelector('[aria-label="area options"]') as HTMLElement;
    // No country list inside the popover -- only the typed search field
    // (and the profile country shows up as placeholder context, not a
    // row the user must tap).
    expect(popover.textContent).not.toContain('Ghana');
    expect(popover.querySelector('[data-testid="vents-ai-tune-area-input"]')).toBeTruthy();
    expect(popover.querySelector('[data-testid="vents-ai-tune-area-profile-country"]')).toBeFalsy();
  });

  it('supports a user-entered custom budget amount', async () => {
    await mount();
    const budgetChip = container!.querySelector('[data-testid="vents-ai-tune-budget"]') as HTMLElement;
    act(() => { budgetChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const customInput = container!.querySelector('[data-testid="vents-ai-tune-budget-custom"]') as HTMLInputElement;
    expect(customInput).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(customInput, '75000');
      customInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const applyButton = container!.querySelector('[data-testid="vents-ai-tune-budget-custom-apply"]') as HTMLButtonElement;
    expect(applyButton.disabled).toBe(false);
    act(() => { applyButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const input = container!.querySelector('input[placeholder="Ask about events or plans"]') as HTMLInputElement;
    expect(input.value).toContain('75,000');
  });

  it('rejects a negative or zero custom budget amount (Apply stays disabled, no composer text added)', async () => {
    await mount();
    const budgetChip = container!.querySelector('[data-testid="vents-ai-tune-budget"]') as HTMLElement;
    act(() => { budgetChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const customInput = container!.querySelector('[data-testid="vents-ai-tune-budget-custom"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;

    act(() => { setter.call(customInput, '-50'); customInput.dispatchEvent(new Event('input', { bubbles: true })); });
    let applyButton = container!.querySelector('[data-testid="vents-ai-tune-budget-custom-apply"]') as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);

    act(() => { setter.call(customInput, '0'); customInput.dispatchEvent(new Event('input', { bubbles: true })); });
    applyButton = container!.querySelector('[data-testid="vents-ai-tune-budget-custom-apply"]') as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);

    act(() => { applyButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = container!.querySelector('input[placeholder="Ask about events or plans"]') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('leaves the custom budget amount empty as a no-op (Apply disabled, no error shown yet)', async () => {
    await mount();
    const budgetChip = container!.querySelector('[data-testid="vents-ai-tune-budget"]') as HTMLElement;
    act(() => { budgetChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const applyButton = container!.querySelector('[data-testid="vents-ai-tune-budget-custom-apply"]') as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
  });
});

describe('VentsAiScreen Home: clearly rounded premium controls', () => {
  it('the Chat/Plan toggle and the composer input both use a clear pill radius (roughly half their own height), not a barely-rounded rectangle', async () => {
    await mount();
    const toggle = container!.querySelector('[data-testid="si-room-chat"]')!.parentElement as HTMLElement;
    expect(parseInt(toggle.style.borderRadius, 10)).toBeGreaterThanOrEqual(parseInt(toggle.style.height, 10) / 2 - 1);

    const composer = container!.querySelector('input[placeholder="Ask about events or plans"]') as HTMLInputElement;
    // 26px radius on a padding-driven ~54px-tall field reads as a clear
    // rounded pill; the previous 14px on the same field did not.
    expect(parseInt(composer.style.borderRadius, 10)).toBeGreaterThanOrEqual(20);
  });
});

describe('VentsAiScreen Home: Area popover stays on-screen (never extends past the viewport)', () => {
  it('anchors the Area popover to the right edge of its chip, not the left -- Area is the rightmost of the three chips, so left-anchoring pushed it off the right side of a narrow phone', async () => {
    await mount();
    const areaChip = container!.querySelector('[data-testid="vents-ai-tune-area"]') as HTMLElement;
    act(() => { areaChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const popover = container!.querySelector('[aria-label="area options"]') as HTMLElement;
    expect(popover.style.right).toBe('0px');
    expect(popover.style.left).toBe('');
    // Also clamped against the viewport directly, so it can never exceed
    // the screen width even on a phone narrower than its own fixed width.
    expect(popover.style.maxWidth).toBe('calc(100vw - 32px)');
  });

  it('still anchors Mood/Budget popovers to the left edge of their own chip (unaffected by the Area fix)', async () => {
    await mount();
    const moodChip = container!.querySelector('[data-testid="vents-ai-tune-mood"]') as HTMLElement;
    act(() => { moodChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const popover = container!.querySelector('[aria-label="mood options"]') as HTMLElement;
    expect(popover.style.left).toBe('0px');
  });
});

describe('VentsAiScreen Home: header reads "VENTS AI - BY DERO"', () => {
  it('renders the updated header text', async () => {
    await mount();
    expect(container!.textContent).toContain('VENTS AI - BY DERO');
  });
});
