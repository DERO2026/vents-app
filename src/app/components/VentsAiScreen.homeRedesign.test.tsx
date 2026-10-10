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

  it('defaults the Area control to the profile country and lets the user pick it', async () => {
    await mount({ currentUserCountryIso: 'NG' } as any);
    const areaChip = container!.querySelector('[data-testid="vents-ai-tune-area"]') as HTMLElement;
    act(() => { areaChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const profileOption = container!.querySelector('[data-testid="vents-ai-tune-area-profile-country"]');
    expect(profileOption).toBeTruthy();
    expect(profileOption!.textContent).toContain('Nigeria');
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
});
