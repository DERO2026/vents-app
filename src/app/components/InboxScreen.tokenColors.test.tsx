import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ventsColors } from '../../lib/ventsDesignTokens';

// jsdom normalizes inline hex colors to rgb() in computed style -- compare
// against the same normalized form rather than the raw hex literal.
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// WCAG 2.x contrast ratio between two computed `rgb(r, g, b)` strings.
function contrast(a: string, b: string): number {
  const lum = (rgb: string) => {
    const [r, g, bl] = rgb.match(/\d+/g)!.slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Stage 10 of the VENTS UI refurbishment -- InboxScreen had never consumed
// ventsColors at all (every color was a hardcoded hex literal). These
// assertions check the actual COMPUTED style, not just text presence --
// the exact gap that let the Representatives black-on-black regression
// (six investigation rounds) hide through passing text-presence tests.
// No Supabase query, RPC, or realtime logic is touched by this stage --
// only `.from(...).select(...)` read calls below are MOCK setup, not a
// change to the component's own query shape.

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('../../lib/supabase', () => ({
  supabase: { from: (...args: any[]) => mockFrom(...args), rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) },
}));
vi.mock('../../lib/haptics', () => ({ haptics: { light: vi.fn() } }));
vi.mock('../../lib/shareLink', () => ({ shareLink: vi.fn() }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { InboxScreen } from './InboxScreen';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const currentUser = { id: 'user-me' };

function makeChain(rows: any[], error: any = null) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.or = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.in = vi.fn(() => Promise.resolve({ data: rows, error }));
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve({ data: rows, error }));
  // conversation_clears / conversation_requests resolve directly off .eq()/.or()
  chain.then = (resolve: any) => Promise.resolve({ data: rows, error }).then(resolve);
  return chain;
}

function setupSupabase({
  messages = [] as any[],
  clears = [] as any[],
  requests = [] as any[],
  profiles = [] as any[],
}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'direct_messages') return makeChain(messages);
    if (table === 'conversation_clears') return makeChain(clears);
    if (table === 'conversation_requests') return makeChain(requests);
    if (table === 'public_profiles') return makeChain(profiles);
    return makeChain([]);
  });
}

async function renderInbox() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <InboxScreen currentUser={currentUser} onBack={() => {}} onOpenConversation={() => {}} />
    );
  });
  // let the Promise.all-based load() resolve
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return container;
}

beforeEach(() => {
  mockFrom.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

describe('InboxScreen token colors (Stage 10)', () => {
  it('renders the header title in ventsColors.ink1, not a hardcoded hex', async () => {
    setupSupabase({});
    const el = await renderInbox();
    const title = Array.from(el!.querySelectorAll('h1')).find(h => h.textContent === 'Messages');
    expect(title).toBeTruthy();
    expect(getComputedStyle(title as HTMLElement).color).toBe(hexToRgb(ventsColors.ink1));
  });

  it('renders the unread badge background in ventsColors.accentStrong and text in ventsColors.white, at AA contrast', async () => {
    setupSupabase({
      messages: [
        { id: 'm1', sender_id: 'other-1', recipient_id: 'user-me', body: 'hi', created_at: new Date().toISOString(), read_at: null },
      ],
      profiles: [{ id: 'other-1', full_name: 'Ada', username: 'ada', avatar_url: null, last_active_at: null }],
    });
    const el = await renderInbox();
    const badge = Array.from(el!.querySelectorAll('div')).find(d => d.textContent === '1' && (d as HTMLElement).style.borderRadius === '50%');
    expect(badge).toBeTruthy();
    const { backgroundColor, color } = getComputedStyle(badge as HTMLElement);
    expect(backgroundColor).toBe(hexToRgb(ventsColors.accentStrong));
    expect(color).toBe(hexToRgb(ventsColors.white));
    expect(contrast(backgroundColor, color)).toBeGreaterThanOrEqual(4.5);
  });

  it('renders the empty-state message in ventsColors.ink1', async () => {
    setupSupabase({});
    const el = await renderInbox();
    const empty = Array.from(el!.querySelectorAll('p')).find(p => p.textContent === 'No messages yet');
    expect(empty).toBeTruthy();
    expect(getComputedStyle(empty as HTMLElement).color).toBe(hexToRgb(ventsColors.ink1));
  });

  it('renders the load-error state copy in ventsColors.error, distinct from ink1 text', async () => {
    mockFrom.mockImplementation((table: string) => {
      const chain: any = {};
      chain.select = vi.fn(() => chain);
      chain.or = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve({ data: null, error: new Error('boom') }));
      chain.then = (resolve: any) => Promise.resolve({ data: null, error: table === 'direct_messages' ? new Error('boom') : null }).then(resolve);
      return chain;
    });
    const el = await renderInbox();
    const heading = Array.from(el!.querySelectorAll('p')).find(p => p.textContent === "Couldn't load your messages");
    expect(heading).toBeTruthy();
    expect(getComputedStyle(heading as HTMLElement).color).toBe(hexToRgb(ventsColors.ink1));
    const retryBtn = Array.from(el!.querySelectorAll('button')).find(b => b.textContent === 'Retry');
    expect(retryBtn).toBeTruthy();
    expect(getComputedStyle(retryBtn as HTMLElement).color).toBe(hexToRgb(ventsColors.error));
    expect(getComputedStyle(retryBtn as HTMLElement).color).not.toBe(hexToRgb(ventsColors.ink1));
  });
});
