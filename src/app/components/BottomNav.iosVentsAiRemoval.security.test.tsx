import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Apple re-rejected VENTS over VENTS AI being visible on iOS at all --
// even a disabled tab or "Coming Soon" destination is no longer
// acceptable. This proves BottomNav's own fix: the sixth "VENTS AI"
// destination doesn't render on iOS, period -- not dimmed, not disabled,
// simply absent -- while Android and web keep it exactly as before
// (dimmed/disabled only via the existing siEnabled prop, same mocking
// convention as AiAccessScreen.iosSelfGuard.security.test.tsx).

const getPlatformMock = vi.fn<() => string>(() => 'web');
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => getPlatformMock(),
    isNativePlatform: () => getPlatformMock() !== 'web',
  },
}));

import { BottomNav } from './BottomNav';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getPlatformMock.mockReturnValue('web');
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

describe('BottomNav: VENTS AI destination removed entirely on iOS', () => {
  it('iOS: no "VENTS AI" button at all, enabled or disabled', () => {
    getPlatformMock.mockReturnValue('ios');
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siEnabled onOpenSi={() => {}} />);
    });
    expect(container!.textContent).not.toContain('VENTS AI');
    expect(container!.querySelector('button[aria-label="VENTS AI"]')).toBeNull();
  });

  it('iOS: the five remaining destinations still render normally', () => {
    getPlatformMock.mockReturnValue('ios');
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} />);
    });
    expect(container!.textContent).toContain('Home');
    expect(container!.textContent).toContain('Tix');
    expect(container!.textContent).toContain('Services');
    expect(container!.textContent).toContain('Chat');
    expect(container!.textContent).toContain('You');
  });

  it('Android: "VENTS AI" button still renders, unchanged from before this fix', () => {
    getPlatformMock.mockReturnValue('android');
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siEnabled onOpenSi={() => {}} />);
    });
    expect(container!.textContent).toContain('VENTS AI');
    expect(container!.querySelector('button[aria-label="VENTS AI"]')).not.toBeNull();
  });

  it('Web: "VENTS AI" button still renders, unchanged from before this fix', () => {
    getPlatformMock.mockReturnValue('web');
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siEnabled onOpenSi={() => {}} />);
    });
    expect(container!.textContent).toContain('VENTS AI');
    expect(container!.querySelector('button[aria-label="VENTS AI"]')).not.toBeNull();
  });
});
