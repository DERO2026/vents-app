import { describe, it, expect, vi, beforeAll } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { OtpCodeBoxes } from './OtpCodeBoxes';

// jsdom doesn't implement ResizeObserver, which input-otp's internal Input
// component uses to keep track of its container size. Stub it out -- this
// mirrors what every real browser (including every iOS/Android WebView
// this app actually ships to) provides natively.
beforeAll(() => {
  if (typeof (globalThis as any).ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // jsdom doesn't implement elementFromPoint either, which input-otp polls
  // to detect text selection within its hidden input.
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null;
  }
});

// Regression tests for the OTP-entry UX bug: AuthScreen previously used a
// single transparent input overlaid on decorative boxes, so tapping box N
// could never move the caret to position N (the overlay only ever places
// the caret at the end of the current value), and there was no real
// blinking caret (caretColor: 'transparent' hid the native one entirely).
// OtpCodeBoxes wraps the input-otp library, which gives every slot a real,
// independently-focusable input target under the hood.

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

function hiddenInput(el: HTMLDivElement): HTMLInputElement {
  return el.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
}

function typeValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('OtpCodeBoxes', () => {
  it('renders a real input with the correct maxLength for the requested digit count', () => {
    const el = render(<OtpCodeBoxes length={8} value="" onChange={() => {}} hasError={false} />);
    const input = hiddenInput(el);
    expect(input).toBeTruthy();
    expect(input.maxLength).toBe(8);
  });

  it('typing digits calls onChange with the accumulated, digit-only value', () => {
    const onChange = vi.fn();
    const el = render(<OtpCodeBoxes length={8} value="12" onChange={onChange} hasError={false} />);
    typeValue(hiddenInput(el), '123');
    expect(onChange).toHaveBeenCalledWith('123');
  });

  it('strips non-digit characters before calling onChange', () => {
    const onChange = vi.fn();
    const el = render(<OtpCodeBoxes length={8} value="" onChange={onChange} hasError={false} />);
    typeValue(hiddenInput(el), '1a2b3');
    expect(onChange).toHaveBeenCalledWith('123');
  });

  it('a single real input covers the whole group and is directly focusable (unlike the old fixed-position overlay, which only ever placed the caret at the end of the value)', () => {
    const el = render(<OtpCodeBoxes length={8} value="1234" onChange={() => {}} hasError={false} />);
    const input = hiddenInput(el);
    expect(input.disabled).toBe(false);
    act(() => { input.focus(); });
    expect(document.activeElement).toBe(input);
  });

  it('renders one visual slot per digit of the given length', () => {
    const el = render(<OtpCodeBoxes length={6} value="12" onChange={() => {}} hasError={false} />);
    // Each Slot renders a span with the tabular-nums font-variant style.
    const slots = el.querySelectorAll('span');
    expect(slots.length).toBe(6);
  });

  it('actually displays each typed digit in its slot (regression: render-prop path bypassed OTPInputContext.Provider, so every slot silently read the default empty context and never showed a digit or caret, even though the real input kept capturing keystrokes)', () => {
    const el = render(<OtpCodeBoxes length={6} value="482" onChange={() => {}} hasError={false} />);
    const text = el.textContent || '';
    expect(text).toContain('482');
  });

  it('shows a blinking caret in the active slot, not a permanently absent one', () => {
    const el = render(<OtpCodeBoxes length={6} value="48" onChange={() => {}} hasError={false} autoFocus />);
    const input = hiddenInput(el);
    act(() => { input.focus(); });
    const caretEl = Array.from(el.querySelectorAll('div')).find((d) =>
      (d as HTMLElement).style.animation?.includes('vents-otp-caret-blink')
    );
    expect(caretEl).toBeTruthy();
  });

  it('applies the error border color to every slot when hasError is true', () => {
    const el = render(<OtpCodeBoxes length={4} value="12" onChange={() => {}} hasError={true} />);
    const slotDivs = Array.from(el.querySelectorAll('div')).filter((d) => (d as HTMLElement).style.height === '64px');
    expect(slotDivs.length).toBe(4);
    for (const div of slotDivs) {
      expect((div as HTMLElement).style.border).toContain('248, 113, 113');
    }
  });
});
