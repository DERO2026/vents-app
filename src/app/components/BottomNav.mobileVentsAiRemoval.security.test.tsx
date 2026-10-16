import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// VENTS AI is web-only for this release -- not visible on either mobile
// platform at all, not even a disabled tab or "Coming Soon" destination.
// This proves BottomNav's own fix: the sixth "VENTS AI" destination
// doesn't render on iOS OR Android, period -- not dimmed, not disabled,
// simply absent -- while web keeps it exactly as before (dimmed/disabled
// only via the existing siEnabled prop, same mocking convention as
// AiAccessScreen.iosSelfGuard.security.test.tsx).

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

describe('BottomNav: VENTS AI destination removed entirely on mobile', () => {
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

  it('Android: no "VENTS AI" button either, same as iOS', () => {
    getPlatformMock.mockReturnValue('android');
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siEnabled onOpenSi={() => {}} />);
    });
    expect(container!.textContent).not.toContain('VENTS AI');
    expect(container!.querySelector('button[aria-label="VENTS AI"]')).toBeNull();
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
