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
  it('shows the five renamed destinations: Home, Passes, Chats, Profile, SI', () => {
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} />);
    });
    expect(container!.textContent).toContain('Home');
    expect(container!.textContent).toContain('Passes');
    expect(container!.textContent).toContain('Chats');
    expect(container!.textContent).toContain('Profile');
    expect(container!.textContent).toContain('SI');
    // The old labels must be gone, not just supplemented.
    expect(container!.textContent).not.toContain('Tix');
    expect(container!.textContent).not.toMatch(/\bYou\b/);
  });

  it('calls onTabChange with the right TabId for Passes/Chats/Profile (not renamed internally)', () => {
    const onTabChange = vi.fn();
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={onTabChange} />);
    });
    clickLabel('Passes');
    expect(onTabChange).toHaveBeenCalledWith('my-tickets');
    clickLabel('Chats');
    expect(onTabChange).toHaveBeenCalledWith('explore');
    clickLabel('Profile');
    expect(onTabChange).toHaveBeenCalledWith('profile');
  });

  it('tapping SI calls onOpenSi when SI is enabled', () => {
    const onOpenSi = vi.fn();
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siEnabled onOpenSi={onOpenSi} />);
    });
    clickLabel('SI');
    expect(onOpenSi).toHaveBeenCalledTimes(1);
  });

  it('tapping SI does nothing when SI is disabled (Settings toggle off) -- never a broken destination', () => {
    const onOpenSi = vi.fn();
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siEnabled={false} onOpenSi={onOpenSi} />);
    });
    clickLabel('SI');
    expect(onOpenSi).not.toHaveBeenCalled();

    const siButton = container!.querySelector('button[aria-label="SI"]') as HTMLButtonElement;
    expect(siButton.getAttribute('aria-disabled')).toBe('true');
  });

  it('marks SI as the current page via aria-current when siActive, and no regular tab as active at the same time', () => {
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} siActive siEnabled onOpenSi={() => {}} />);
    });
    const siButton = container!.querySelector('button[aria-label="SI"]') as HTMLButtonElement;
    const homeButton = container!.querySelector('button[aria-label="Home"]') as HTMLButtonElement;
    expect(siButton.getAttribute('aria-current')).toBe('page');
    expect(homeButton.getAttribute('aria-current')).toBeNull();
  });

  it('shows an unread-chats indicator only on Chats', () => {
    act(() => {
      root!.render(<BottomNav activeTab="home" onTabChange={() => {}} hasUnreadChats />);
    });
    // The dot renders as a sibling span inside the Chats button's icon well.
    const chatsButton = container!.querySelector('button[aria-label="Chats"]') as HTMLButtonElement;
    const homeButton = container!.querySelector('button[aria-label="Home"]') as HTMLButtonElement;
    expect(chatsButton.querySelectorAll('span').length).toBeGreaterThan(1);
    expect(homeButton.querySelectorAll('span').length).toBe(1);
  });
});
