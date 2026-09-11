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
});
