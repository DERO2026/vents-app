import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiIosComingSoonScreen } from './VentsAiIosComingSoonScreen';

// Interim fix (not real Apple In-App Purchase): VENTS AI is temporarily
// unavailable on iOS. This screen replaces the real paywall/chat flow on
// iOS -- it must never claim a subscription was purchased or activated,
// never show a price/plan, never link out for payment, and must always
// give the user a way back.

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

function mount(onClose: () => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<VentsAiIosComingSoonScreen onClose={onClose} />);
  });
}

describe('VentsAiIosComingSoonScreen', () => {
  it('clearly explains VENTS AI is coming soon to iOS and that the iOS experience is being prepared', () => {
    mount(() => {});
    expect(container!.textContent).toContain('VENTS AI is coming to iOS');
    expect(container!.textContent?.toLowerCase()).toContain('preparing the ios experience');
    expect(container!.querySelector('[data-testid="vents-ai-ios-coming-soon-badge"]')?.textContent).toMatch(/coming soon/i);
  });

  it('never implies a subscription was purchased or activated', () => {
    mount(() => {});
    const text = container!.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('unlocked');
    expect(text).not.toContain('subscribed');
    expect(text).not.toContain('activated');
    expect(text).not.toContain('purchase complete');
  });

  it('shows no plan, price, or purchase button', () => {
    mount(() => {});
    expect(container!.textContent).not.toMatch(/₦/);
    expect(container!.textContent?.toLowerCase()).not.toMatch(/subscribe|choose a plan|upgrade/);
    expect(container!.querySelector('button[data-testid^="ai-plan-"]')).toBeFalsy();
  });

  it('has no external payment link or call-to-action to pay elsewhere', () => {
    mount(() => {});
    expect(container!.querySelector('a[href]')).toBeFalsy();
    const text = container!.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('getvents.com');
    expect(text).not.toContain('website');
  });

  it('provides a clear, working way back to the rest of the app (header close + footer button both call onClose)', () => {
    const onClose = vi.fn();
    mount(onClose);
    (container!.querySelector('[data-testid="vents-ai-ios-coming-soon-close"]') as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    (container!.querySelector('[data-testid="vents-ai-ios-coming-soon-back"]') as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
