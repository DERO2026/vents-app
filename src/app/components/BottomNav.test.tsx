import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { BottomNav } from './BottomNav';

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

function clickLabel(label: string) {
  const el = container!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  if (!el) throw new Error(`button[aria-label="${label}"] not found`);
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('BottomNav', () => {
  it('shows the six approved destinations: Home, Tix, Services, Chat, You, VENTS AI', () => {
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} />);
    });
    expect(container!.textContent).toContain('Home');
    expect(container!.textContent).toContain('Tix');
    expect(container!.textContent).toContain('Services');
    expect(container!.textContent).toContain('Chat');
    expect(container!.textContent).toContain('You');
    expect(container!.textContent).toContain('VENTS AI');
    // The old labels must be gone, not just supplemented.
    expect(container!.textContent).not.toContain('Passes');
    expect(container!.textContent).not.toContain('Profile');
  });

  it('calls onTabChange with the right TabId for Tix/Services/Chat/You', () => {
    const onTabChange = vi.fn();
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={onTabChange} />);
    });
    clickLabel('Tix');
    expect(onTabChange).toHaveBeenCalledWith('my-tickets');
    clickLabel('Services');
    expect(onTabChange).toHaveBeenCalledWith('services');
    clickLabel('Chat');
    expect(onTabChange).toHaveBeenCalledWith('explore');
    clickLabel('You');
    expect(onTabChange).toHaveBeenCalledWith('profile');
  });

  it('tapping VENTS AI calls onOpenSi when enabled', () => {
    const onOpenSi = vi.fn();
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siEnabled onOpenSi={onOpenSi} />);
    });
    clickLabel('VENTS AI');
    expect(onOpenSi).toHaveBeenCalledTimes(1);
  });

  it('tapping VENTS AI does nothing when disabled (Settings toggle off) -- never a broken destination', () => {
    const onOpenSi = vi.fn();
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siEnabled={false} onOpenSi={onOpenSi} />);
    });
    clickLabel('VENTS AI');
    expect(onOpenSi).not.toHaveBeenCalled();

    const aiButton = container!.querySelector('button[aria-label="VENTS AI"]') as HTMLButtonElement;
    expect(aiButton.getAttribute('aria-disabled')).toBe('true');
  });

  it('marks VENTS AI as the current page via aria-current when siActive, and no regular tab as active at the same time', () => {
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siActive siEnabled onOpenSi={() => {}} />);
    });
    const aiButton = container!.querySelector('button[aria-label="VENTS AI"]') as HTMLButtonElement;
    const homeButton = container!.querySelector('button[aria-label="Home"]') as HTMLButtonElement;
    expect(aiButton.getAttribute('aria-current')).toBe('page');
    expect(homeButton.getAttribute('aria-current')).toBeNull();
  });

  it('marks the active regular tab via aria-current, e.g. Services', () => {
    act(() => {
      root!.render(<BottomNav activeTab="services" onTabChange={() => {}} />);
    });
    const servicesButton = container!.querySelector('button[aria-label="Services"]') as HTMLButtonElement;
    const homeButton = container!.querySelector('button[aria-label="Home"]') as HTMLButtonElement;
    expect(servicesButton.getAttribute('aria-current')).toBe('page');
    expect(homeButton.getAttribute('aria-current')).toBeNull();
  });

  it('shows an unread-chats indicator only on Chat', () => {
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} hasUnreadChats />);
    });
    // The dot renders as a sibling span inside the Chat button's icon well.
    const chatButton = container!.querySelector('button[aria-label="Chat"]') as HTMLButtonElement;
    const homeButton = container!.querySelector('button[aria-label="Home"]') as HTMLButtonElement;
    expect(chatButton.querySelectorAll('span').length).toBeGreaterThan(1);
    expect(homeButton.querySelectorAll('span').length).toBe(1);
  });
});

describe('BottomNav compact dock (size, touch targets, clearance)', () => {
  it('is 60px tall, 10px above the safe area, and every button stays >= 44px tall with readable labels', async () => {
    const { BOTTOM_NAV_HEIGHT, BOTTOM_NAV_OFFSET } = await import('./BottomNav');
    act(() => { root!.render(<BottomNav activeTab="home" onTabChange={() => {}} />); });
    const dock = container!.firstElementChild as HTMLElement;
    expect(dock.style.height).toBe('60px');
    expect(BOTTOM_NAV_HEIGHT).toBe(60);
    expect(BOTTOM_NAV_OFFSET).toBe(10);
    const pad = parseInt(dock.style.padding);
    expect(BOTTOM_NAV_HEIGHT - 2 * pad).toBeGreaterThanOrEqual(44);   // button height
    for (const b of container!.querySelectorAll('button')) {
      const label = b.querySelector('span:last-child') as HTMLElement;
      expect(label.style.font).toMatch(/9\.5px/);
      expect(b.querySelector('svg')!.getAttribute('width')).toBe('20');
    }
  });
  it('the bottom keeps the iPhone safe area (source check: jsdom drops env())', async () => {
    const src = (await import('./BottomNav.tsx?raw')).default;
    expect(src).toMatch(/bottom: `calc\(\$\{BOTTOM_NAV_OFFSET\}px \+ env\(safe-area-inset-bottom, 0px\)\)`/);
  });
  it('nav screens clear the dock: their bottom padding is the shared clearance (dock + offset + 14px gap)', async () => {
    const { BOTTOM_NAV_CLEARANCE } = await import('./BottomNav');
    expect(BOTTOM_NAV_CLEARANCE).toBe('calc(84px + env(safe-area-inset-bottom))');
    for (const f of ['./HomeScreen.tsx?raw', './ExploreScreen.tsx?raw', './ServicesHomeScreen.tsx?raw']) {
      const src = (await import(/* @vite-ignore */ f)).default as string;
      expect(src).toMatch(/BOTTOM_NAV_CLEARANCE/);
    }
  });
});
