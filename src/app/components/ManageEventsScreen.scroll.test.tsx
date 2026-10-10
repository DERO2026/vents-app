import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ManageEventsScreen } from './ManageEventsScreen';

// Regression test for the "My Events" vertical scrolling bug: organizers
// could not scroll past the first screenful of events. Root cause (traced
// directly, not guessed): the scroll container's own flex:1 only works
// inside a flex-column parent, but .vents-manage-outer/.vents-manage-shell
// were plain block elements outside the >=900px media query -- so flex:1
// was a no-op and the container grew to fit every card instead of being
// height-clamped and scrolling. jsdom has no layout engine, so this can't
// measure real overflow; it asserts the two structural fixes instead: the
// wrapper classes are genuinely display:flex/flex:1/min-height:0 (not an
// empty rule deferred to a desktop-only media query), and the scroll
// container itself has min-height:0.

vi.mock('../../lib/useOrganizerEvents', () => ({
  useOrganizerEvents: () => ({
    events: [], loading: false, error: null, sort: 'newest', setSort: () => {}, live: true, refresh: () => {},
  }),
}));
vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: () => {} }));
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: () => Promise.resolve({ data: null, error: null }) } }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
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

describe('ManageEventsScreen ("My Events") scroll container', () => {
  it('declares .vents-manage-outer and .vents-manage-shell as flex:1/min-height:0 flex columns at the base level (not deferred to the desktop media query)', () => {
    act(() => {
      root!.render(<ManageEventsScreen onBack={() => {}} currentUser={{ id: 'org-1' } as any} onOpenEdit={() => {}} onCreateEvent={() => {}} onViewAttendees={() => {}} onViewAnalytics={() => {}} onOpenDoorManager={() => {}} onOpenScanner={() => {}} />);
    });

    const styleTags = Array.from(container!.querySelectorAll('style'));
    const css = styleTags.map((s) => s.textContent || '').join('\n');
    // The base (non-media-query) rule for each class must set a real
    // bounded flex column -- not an empty `{ }` block that only gets
    // overridden at >=900px, which was the actual bug.
    const outerBase = css.match(/\.vents-manage-outer\s*\{([^}]*)\}/);
    const shellBase = css.match(/\.vents-manage-shell\s*\{([^}]*)\}/);
    expect(outerBase?.[1]).toMatch(/display:\s*flex/);
    expect(outerBase?.[1]).toMatch(/flex:\s*1/);
    expect(outerBase?.[1]).toMatch(/min-height:\s*0/);
    expect(shellBase?.[1]).toMatch(/display:\s*flex/);
    expect(shellBase?.[1]).toMatch(/flex:\s*1/);
    expect(shellBase?.[1]).toMatch(/min-height:\s*0/);
  });

  it('sets min-height:0 on the actual scroll container (flex:1, overflowY:auto)', () => {
    act(() => {
      root!.render(<ManageEventsScreen onBack={() => {}} currentUser={{ id: 'org-1' } as any} onOpenEdit={() => {}} onCreateEvent={() => {}} onViewAttendees={() => {}} onViewAnalytics={() => {}} onOpenDoorManager={() => {}} onOpenScanner={() => {}} />);
    });

    const scrollDiv = Array.from(container!.querySelectorAll('div')).find((d) => d.style.overflowY === 'auto') as HTMLDivElement | undefined;
    expect(scrollDiv).toBeTruthy();
    expect(scrollDiv!.style.minHeight).toBe('0px');
    expect(scrollDiv!.style.flex).toBe('1 1 0%');
  });
});
