import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { Event } from './types';

// This screen's only Supabase call is a live-availability RPC -- mocked to
// resolve with no rows, so it falls back to the static `available` counts
// passed in via `event.ticketTypes` (see the component's own comment on
// this fallback). This is a pure styling regression suite; it does not
// exercise the RPC's real behavior.
vi.mock('../../lib/supabase', () => ({
  supabase: { rpc: () => Promise.resolve({ data: [], error: null }) },
}));

import { TicketSelectScreen } from './TicketSelectScreen';
import { ventsColors } from '../../lib/ventsDesignTokens';

const EVENT: Event = {
  id: 'event-1', title: 'Test Event', category: 'Music', categoryIcon: '🎵',
  date: '2099-01-01', time: '20:00', endTime: '23:00', venue: 'Venue', area: 'Area',
  city: 'Lagos', state: 'Lagos', country: 'NG', price: 5000, image: '',
  description: '', organizer: 'Org', isFeatured: false, isTrending: false,
  attendees: 0, capacity: 100, rating: 0, reviewCount: 0,
  ticketTypes: [
    { id: 'reg', name: 'Regular', description: 'Standard entry', price: 5000, available: 10 },
    { id: 'vip', name: 'VIP', description: 'Front row', price: 20000, available: 0 },
  ],
  organizer_id: 'organizer-1',
} as unknown as Event;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function renderScreen() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TicketSelectScreen event={EVENT} onBack={() => {}} onContinue={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TicketSelectScreen: token-reconciled styling', () => {
  it('renders the ticket type names and prices', async () => {
    await renderScreen();
    expect(container!.textContent).toContain('Regular');
    expect(container!.textContent).toContain('VIP');
    expect(container!.textContent).toContain('Sold Out');
  });

  it('root container background uses ventsColors.bg, not a raw legacy hex', async () => {
    await renderScreen();
    const root = container!.firstElementChild as HTMLElement;
    // jsdom normalizes hex to rgb() on read-back; compare against that form.
    expect(root.style.background).toBe('rgb(8, 7, 12)');
  });

  it('primary ticket-name text uses ventsColors.ink1, not inherited/legacy color', async () => {
    await renderScreen();
    const nameSpan = Array.from(container!.querySelectorAll('span')).find((s) => s.textContent === 'Regular')!;
    expect(nameSpan.style.color).toBe('rgb(237, 234, 245)');
  });

  it('a sold-out ticket stays non-interactive (soldOut gating untouched by the restyle)', async () => {
    await renderScreen();
    const vipRow = Array.from(container!.querySelectorAll('div')).find((d) => d.style.cursor === 'not-allowed')!;
    expect(vipRow).toBeTruthy();
    expect(vipRow.style.opacity).toBe('0.5');
    expect(vipRow.textContent).toContain('VIP');
  });
});
