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

    const button = container.querySelector('button') as HTMLButtonElement;
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
});
