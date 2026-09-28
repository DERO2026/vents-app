import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiOrb } from './VentsAiOrb';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

describe('VentsAiOrb', () => {
  it('shows the one-time "Ask VENTS AI anything" tooltip on first launch, then never again after tap', () => {
    const onOpen = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<VentsAiOrb onOpen={onOpen} userId="u1" />);
    });

    expect(container.textContent).toContain('Ask VENTS AI anything');

    const button = container.querySelector('button[aria-label="Open VENTS AI"]') as HTMLButtonElement;
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('vents_ai_orb_seen_u1')).toBe('1');

    // Remount (simulates reopening the app / navigating back to a tab
    // showing the orb) -- the tooltip must not reappear once seen.
    act(() => root!.unmount());
    root = createRoot(container);
    act(() => {
      root!.render(<VentsAiOrb onOpen={onOpen} userId="u1" />);
    });
    expect(container.textContent).not.toContain('Ask VENTS AI anything');
  });

  it('marks the tooltip "seen" as soon as it is shown, so remounting before any tap does not resurrect it', () => {
    // This is the actual reported "keeps appearing" defect: navigating away
    // from an orb-bearing screen and back unmounts/remounts VentsAiOrb. The
    // old implementation only wrote the "seen" flag on tap, so a user who
    // hadn't tapped yet would see the full tooltip every single remount.
    const onOpen = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<VentsAiOrb onOpen={onOpen} userId="u2" />);
    });

    expect(container.textContent).toContain('Ask VENTS AI anything');
    expect(localStorage.getItem('vents_ai_orb_seen_u2')).toBe('1');

    // Remount WITHOUT tapping the orb -- simulates navigating away and back.
    act(() => root!.unmount());
    root = createRoot(container);
    act(() => {
      root!.render(<VentsAiOrb onOpen={onOpen} userId="u2" />);
    });
    expect(container.textContent).not.toContain('Ask VENTS AI anything');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('auto-hides the tooltip after a few seconds even if the user never taps the orb', () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root!.render(<VentsAiOrb onOpen={onOpen} userId="u3" />);
      });

      expect(container.textContent).toContain('Ask VENTS AI anything');

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(container.textContent).not.toContain('Ask VENTS AI anything');

      // The orb button itself must still be present and functional --
      // this is a nudge disappearing, not the launcher itself.
      const button = container.querySelector('button[aria-label="Open VENTS AI"]') as HTMLButtonElement;
      expect(button).toBeTruthy();
      act(() => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has a dedicated X button that dismisses the tooltip without opening VENTS AI', () => {
    const onOpen = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<VentsAiOrb onOpen={onOpen} userId="u4" />);
    });

    expect(container.textContent).toContain('Ask VENTS AI anything');
    const dismissButton = container.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement;
    expect(dismissButton).toBeTruthy();

    act(() => {
      dismissButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Dismissed, not opened -- and the orb itself remains usable afterward.
    expect(onOpen).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Ask VENTS AI anything');
    const openButton = container.querySelector('button[aria-label="Open VENTS AI"]') as HTMLButtonElement;
    act(() => {
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
