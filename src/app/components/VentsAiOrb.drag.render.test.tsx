import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiOrb } from './VentsAiOrb';

// Draggable orb: the orb can be moved anywhere on screen (request: "make
// the VENTS AI moveable and draggable around the screen"), while a plain
// tap must still open VENTS AI exactly as before. A drag and a tap look
// identical for the first few pixels of a pointer-down, so the component
// only commits to "this was a drag" once movement exceeds a small
// threshold -- below that, release is treated as a tap and opens as usual.
//
// Real browsers fire a 'click' event after pointerup/mouseup regardless of
// whether the gesture was a tap or a drag; jsdom does not synthesize this
// automatically for manually-dispatched PointerEvents, so each scenario
// below dispatches the click explicitly after the pointer sequence, the
// same way a real browser's event sequence would reach the button.

function fireButtonSequence(button: HTMLButtonElement, points: { x: number; y: number }[]) {
  const [down, ...rest] = points;
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: down.x, clientY: down.y, pointerId: 1 }));
  for (const p of rest) {
    button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x, clientY: p.y, pointerId: 1 }));
  }
  const last = points[points.length - 1];
  button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: last.x, clientY: last.y, pointerId: 1 }));
  // The real click a browser fires after pointerup -- the component's own
  // onClick decides whether to swallow it (drag) or act on it (tap).
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

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

function render(onOpen = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<VentsAiOrb onOpen={onOpen} userId="u1" />);
  });
  const button = container.querySelector('button[aria-label="Open VENTS AI"]') as HTMLButtonElement;
  return { button, onOpen };
}

describe('VentsAiOrb: draggable, with a plain tap still opening VENTS AI', () => {
  it('a plain tap (pointerdown + pointerup with no real movement) still opens VENTS AI', () => {
    const { button, onOpen } = render();
    act(() => { fireButtonSequence(button, [{ x: 100, y: 100 }, { x: 100, y: 100 }]); });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a drag past the threshold moves the orb (switches to left/top positioning) and does NOT open VENTS AI', () => {
    const { button, onOpen } = render();
    act(() => { fireButtonSequence(button, [{ x: 100, y: 100 }, { x: 150, y: 160 }]); });
    expect(onOpen).not.toHaveBeenCalled();
    const wrapper = container!.querySelector('[data-testid="vents-ai-orb"]') as HTMLElement;
    const style = wrapper.getAttribute('style') || '';
    expect(style).toContain('left:');
    expect(style).toContain('top:');
    expect(style).not.toContain('bottom:');
  });

  it('a tiny jitter below the drag threshold is still treated as a tap', () => {
    const { button, onOpen } = render();
    // 2px of movement, well under DRAG_THRESHOLD_PX (6) -- a human finger
    // can never land with perfect pixel precision, so this must not be
    // misread as an intentional drag.
    act(() => { fireButtonSequence(button, [{ x: 100, y: 100 }, { x: 101, y: 102 }]); });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a dragged position persists to localStorage, scoped per user id', () => {
    const { button } = render();
    act(() => { fireButtonSequence(button, [{ x: 100, y: 100 }, { x: 180, y: 220 }]); });
    const stored = JSON.parse(localStorage.getItem('vents_ai_orb_pos_u1') || 'null');
    expect(stored).toEqual({ x: 80, y: 120 }); // origin (0,0 from jsdom's zero-rect) + (80,120) delta
  });

  it('a persisted position is restored on next mount instead of the default bottom/right anchor', () => {
    localStorage.setItem('vents_ai_orb_pos_u1', JSON.stringify({ x: 40, y: 60 }));
    const { onOpen } = render();
    const wrapper = container!.querySelector('[data-testid="vents-ai-orb"]') as HTMLElement;
    const style = wrapper.getAttribute('style') || '';
    expect(style).toContain('left: 40px');
    expect(style).toContain('top: 60px');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not throw even though setPointerCapture is unsupported in this test environment (it is supported in every real target browser/WebView)', () => {
    const { button } = render();
    expect(() => {
      act(() => { fireButtonSequence(button, [{ x: 0, y: 0 }, { x: 50, y: 50 }]); });
    }).not.toThrow();
  });
});
