import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiUnlockedScreen } from './VentsAiUnlockedScreen';

// The approved prototype's only actual "orb" (ai.ph.unlocked) -- every
// other VENTS AI view uses a plain text header, no orb. Verifies the
// exact copy/button from the prototype render and that the real
// "Start planning" action fires.

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

describe('VentsAiUnlockedScreen', () => {
  it('shows the unlock copy and calls onStartPlanning when tapped', () => {
    const onStartPlanning = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<VentsAiUnlockedScreen onStartPlanning={onStartPlanning} />);
    });

    expect(container.textContent).toContain('VENTS AI is unlocked');
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Start planning')!;
    expect(button).toBeTruthy();
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onStartPlanning).toHaveBeenCalledTimes(1);
  });
});
