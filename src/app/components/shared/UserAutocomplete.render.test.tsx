import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { UserAutocomplete } from './UserAutocomplete';

// Real render test (not a static/regex check) proving the dropdown fix:
// CheckoutScreen's "Who's Paying" card sits inside that screen's own
// overflow-y: auto scrolling body, which clips a plain position:absolute
// dropdown per the CSS overflow spec. UserAutocomplete now portals the
// dropdown to document.body instead of nesting it inside whatever
// overflow-clipped ancestor it's mounted in -- this test reproduces that
// exact ancestor shape and asserts the dropdown actually lands outside it.
vi.mock('../../../lib/userSearch', () => ({
  searchUsers: vi.fn(async (query: string) => {
    if (query.toLowerCase().startsWith('dan')) {
      return [{ id: 'u1', username: 'daniel', fullName: 'Daniel', avatarUrl: null }];
    }
    return [];
  }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

describe('UserAutocomplete: dropdown survives an overflow-clipping ancestor', () => {
  it('renders the dropdown as a child of document.body, not nested inside an overflow-y:auto ancestor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Reproduces CheckoutScreen.tsx's exact ancestor shape: a scrollable
    // screen body (overflowY: 'auto') wrapping the field in normal flow.
    const scrollAncestor = document.createElement('div');
    scrollAncestor.setAttribute('data-testid', 'scroll-ancestor');
    scrollAncestor.style.overflowY = 'auto';
    document.body.appendChild(scrollAncestor);
    container = document.createElement('div');
    scrollAncestor.appendChild(container);

    let value = '';
    const handleChange = (v: string) => { value = v; };

    root = createRoot(container);
    act(() => {
      root!.render(
        <UserAutocomplete
          label="Payer's VENTS email or username"
          placeholder="name@gmail.com or @username"
          value={value}
          onChange={handleChange}
          onSelect={() => {}}
        />
      );
    });

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'dan');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Re-render with the new value (mirrors what CheckoutScreen's onChange
    // -> setState -> re-render loop does for a real controlled input).
    value = 'dan';
    act(() => {
      root!.render(
        <UserAutocomplete
          label="Payer's VENTS email or username"
          placeholder="name@gmail.com or @username"
          value={value}
          onChange={handleChange}
          onSelect={() => {}}
        />
      );
    });

    // Advance past the 300ms debounce and flush the mocked searchUsers promise.
    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
      await Promise.resolve();
    });

    const dropdownText = document.body.textContent || '';
    expect(dropdownText).toContain('daniel');

    // The key assertion: the dropdown is NOT a descendant of the
    // overflow-clipping ancestor -- it's a sibling, portaled directly to
    // document.body, so the ancestor's overflow can never clip it.
    expect(scrollAncestor.textContent).not.toContain('daniel');

    scrollAncestor.remove();
  });

  it('flips the dropdown above the field and caps its height when there is little room below -- the Ticket Transfer bottom-sheet scenario', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Reproduces MyTicketsScreen.tsx's Transfer Ticket modal: a short
    // bottom sheet where the field sits close to the sheet's own bottom
    // edge (Cancel/Send Request buttons right below it), simulated here by
    // stubbing the field's own getBoundingClientRect() to report almost no
    // space below it in the viewport.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    container = document.createElement('div');
    document.body.appendChild(container);

    let value = '';
    const handleChange = (v: string) => { value = v; };

    root = createRoot(container);
    act(() => {
      root!.render(
        <UserAutocomplete label="Recipient" placeholder="Recipient email or username" value={value} onChange={handleChange} onSelect={() => {}} />
      );
    });

    const input0 = container.querySelector('input') as HTMLInputElement;
    // The field wrapper (the div carrying the ref) is the input's direct
    // parent -- stub its rect to sit 40px from the bottom of an 800px-tall
    // viewport, well under MIN_DROPDOWN_HEIGHT (120px) below it.
    const fieldDiv = input0.parentElement as HTMLDivElement;
    fieldDiv.getBoundingClientRect = () => ({
      top: 700, bottom: 752, left: 20, right: 300, width: 280, height: 52, x: 20, y: 700, toJSON() {},
    });

    act(() => {
      const input = container!.querySelector('input') as HTMLInputElement;
      input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'dan');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    value = 'dan';
    act(() => {
      root!.render(
        <UserAutocomplete label="Recipient" placeholder="Recipient email or username" value={value} onChange={handleChange} onSelect={() => {}} />
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent || '').toContain('daniel');

    const dropdown = document.body.querySelector('[style*="position: fixed"]') as HTMLElement | null;
    expect(dropdown).toBeTruthy();
    // Opened above (top < the field's own top of 700), not below it.
    expect(parseFloat(dropdown!.style.top)).toBeLessThan(700);
    // Height capped to the available space, never the full 260px max.
    expect(parseFloat(dropdown!.style.maxHeight)).toBeLessThanOrEqual(700 - 6);
  });
});
