import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Homepage Coming Soon section (0224): renders Coming Soon events with the
// Featured Events visual system, a COMING SOON label, the sales opening time
// and a Notify me action -- never a purchase CTA. FeaturedCarousel itself is
// not changed.

vi.mock('../../lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {} } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

import { ComingSoonCarousel } from './HomeScreen';

const src = readFileSync(join(__dirname, 'HomeScreen.tsx'), 'utf8');
const featured = src.slice(src.indexOf('export function FeaturedCarousel('), src.indexOf('function FilterChip('));
const comingSoon = src.slice(src.indexOf('export function ComingSoonCarousel('), src.indexOf('export function HomeScreen('));

const ev = (id: string, title: string, over: any = {}) => ({
  id, title, category: 'Music', categoryIcon: '🎵', date: 'Sat, Dec 20', time: '8:00 PM', venue: 'Eko Hotel', area: 'Eko Hotel', city: 'Victoria Island',
  state: 'Lagos', country: 'NG', price: 10000, image: `https://cdn.example.test/${id}.jpg`, images: [`https://cdn.example.test/${id}.jpg`],
  description: '', organizer: 'afrohub', organizerVerified: true, isFeatured: false, attendees: 0, capacity: 100, rating: 0, reviewCount: 0,
  ticketTypes: [{ id: 't0', name: 'Regular', price: 10000, description: '', available: 100 }],
  status: 'coming_soon', salesOpenAt: '2026-12-05T09:00:00.000Z', ...over,
});

let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

function mount(events: any[], opts: Partial<{ notifying: Set<string>; onToggleNotify: any; onEventPress: any }> = {}) {
  const notifying = opts.notifying ?? new Set<string>();
  const onToggleNotify = opts.onToggleNotify ?? vi.fn(async (id: string) => { notifying.has(id) ? notifying.delete(id) : notifying.add(id); return { ok: true }; });
  const onEventPress = opts.onEventPress ?? vi.fn();
  const render = () => root.render(
    <ComingSoonCarousel events={events} onEventPress={onEventPress} isSaved={[]} onToggleSave={() => {}}
      isNotifying={(id) => notifying.has(id)} isNotifyPending={() => false} onToggleNotify={onToggleNotify} />,
  );
  act(() => { render(); });
  return { onToggleNotify, onEventPress, rerender: () => act(() => { render(); }) };
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('Coming Soon card content', () => {
  it('shows flyer, title, date, venue, organizer, the COMING SOON label and when sales open', () => {
    mount([ev('e1', 'Afrobeats Live')]);
    expect(q('coming-soon-section')).toBeTruthy();
    expect(container.textContent).toContain('Coming Soon');
    expect(q('coming-soon-badge')!.textContent).toBe('COMING SOON');
    expect(container.textContent).toContain('Afrobeats Live');
    expect(container.textContent).toContain('Sat, Dec 20');
    expect(container.textContent).toContain('Eko Hotel, Victoria Island');
    expect(container.textContent).toContain('@afrohub');
    expect(q('coming-soon-sales-open')!.textContent).toBe('Tickets on sale Sat 5 Dec, 10:00 AM');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.test/e1.jpg');
  });

  it('has no purchase CTA -- only Notify me', () => {
    mount([ev('e1', 'Afrobeats Live')]);
    expect(container.textContent).not.toMatch(/Book Free|Buy|Get Tickets|From ₦|Pay /);
    expect(q('coming-soon-notify')!.textContent).toBe('🔔 Notify me');
  });

  it('Notify me toggles without opening the event; state is reflected', async () => {
    const { onToggleNotify, onEventPress, rerender } = mount([ev('e1', 'Afrobeats Live')]);
    await act(async () => { q('coming-soon-notify')!.click(); });
    expect(onToggleNotify).toHaveBeenCalledWith('e1');
    expect(onEventPress).not.toHaveBeenCalled();
    rerender();
    expect(q('coming-soon-notify')!.textContent).toBe('✓ Notifying you');
    expect(q('coming-soon-notify')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a refused Notify me (e.g. signed out) shows the reason on the card', async () => {
    mount([ev('e1', 'Afrobeats Live')], { onToggleNotify: vi.fn(async () => ({ ok: false, error: 'Sign in to get notified when tickets go on sale.' })) });
    await act(async () => { q('coming-soon-notify')!.click(); });
    expect(container.textContent).toContain('Sign in to get notified');
  });

  it('tapping the card opens the event', () => {
    const { onEventPress } = mount([ev('e1', 'Afrobeats Live')]);
    act(() => { q('coming-soon-card')!.click(); });
    expect(onEventPress).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }));
  });
});

describe('carousel behaviour (same as Featured)', () => {
  it('dot pager for more than one event; tapping a dot switches the card', () => {
    mount([ev('e1', 'First Show'), ev('e2', 'Second Show')]);
    const dots = container.querySelectorAll('button[aria-label^="Show coming soon event"]');
    expect(dots).toHaveLength(2);
    expect(container.textContent).toContain('First Show');
    act(() => { (dots[1] as HTMLButtonElement).click(); });
    expect(container.textContent).toContain('Second Show');
  });

  it('auto-advances every 4 seconds', () => {
    vi.useFakeTimers();
    mount([ev('e1', 'First Show'), ev('e2', 'Second Show')]);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(container.textContent).toContain('Second Show');
    act(() => { vi.advanceTimersByTime(4000); });
    expect(container.textContent).toContain('First Show');
  });

  it('swipe left/right moves between events (mobile)', () => {
    mount([ev('e1', 'First Show'), ev('e2', 'Second Show')]);
    const card = q('coming-soon-card')!;
    const swipe = (dx: number) => act(() => {
      card.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientX: 200 }] }));
      card.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), { changedTouches: [{ clientX: 200 + dx }] }));
    });
    swipe(-80); expect(container.textContent).toContain('Second Show');
    swipe(80); expect(container.textContent).toContain('First Show');
  });

  it('one event: no pager, no timer', () => {
    mount([ev('e1', 'Only Show')]);
    expect(container.querySelectorAll('button[aria-label^="Show coming soon event"]')).toHaveLength(0);
  });

  it('empty list renders nothing (no empty card)', () => {
    mount([]);
    expect(container.innerHTML).toBe('');
  });
});

describe('visual system parity with Featured Events (source-level)', () => {
  // Every token that defines the Featured card's look must appear verbatim in the Coming Soon card.
  const tokens = [
    `fontSize: '15px', fontWeight: 800, fontFamily: 'Manrope, sans-serif', textTransform: 'uppercase', letterSpacing: '1px'`,
    `borderRadius: '28px', overflow: 'hidden', position: 'relative', height: '52vh', minHeight: '280px', maxHeight: '460px', background: ventsColors.surface, border: '1px solid rgba(168,85,247,0.15)', boxShadow: '0 24px 48px rgba(88,28,135,0.22), 0 4px 12px rgba(0,0,0,0.35)'`,
    `imageFit="cover"`,
    `style={flyerScrim(40)}`,
    `background: 'rgba(8,7,12,0.55)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',`,
    `fontFamily: "'JetBrains Mono', monospace", fontSize: '9px', fontWeight: 700,`,
    `padding: '6px 10px', borderRadius: '8px', letterSpacing: '0.14em',`,
    `color: ventsColors.white, fontSize: '20px', fontWeight: 900, margin: '0 0 10px', fontFamily: 'Manrope, sans-serif', lineHeight: 1.2, textShadow: '0 1px 8px rgba(0,0,0,0.6)'`,
    `color: 'rgba(255,255,255,0.92)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', textShadow: '0 1px 6px rgba(0,0,0,0.7)'`,
    `fontSize: '12px', fontWeight: 800, width: 'fit-content',`,
    `borderRadius: '20px', padding: '4px 12px'`,
    `width: i === currentIndex ? '18px' : '6px',`,
    `setInterval(advance, 4000)`,
    `if (Math.abs(dx) < 40) return;`,
    `padding: '20px 16px 18px'`,
  ];
  for (const t of tokens) {
    it(`shares: ${t.slice(0, 60)}…`, () => {
      expect(featured, 'token missing from FeaturedCarousel (test is stale)').toContain(t);
      expect(comingSoon).toContain(t);
    });
  }

  it('FeaturedCarousel is still rendered as before, and Coming Soon sits right after it, default view only', () => {
    const home = src.slice(src.indexOf('{/* Featured Events Carousel */}'), src.indexOf('{/* Trending Events */}'));
    expect(home).toContain('<FeaturedCarousel');
    expect(home.indexOf('<FeaturedCarousel')).toBeLessThan(home.indexOf('<ComingSoonCarousel'));
    expect(home).toContain('{comingSoonEvents.length > 0 && (');
  });

  it('the on-sale feed query still only loads live/published events (Coming Soon never enters Featured/Trending)', () => {
    expect(src).toContain(`.in('status', ['live', 'published'])`);
    expect(src).not.toMatch(/\.in\('status', \[[^\]]*coming_soon/);
  });
});
