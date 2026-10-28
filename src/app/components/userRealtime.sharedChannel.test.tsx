import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as supabaseModule from '../../lib/supabase';
import type { createFakeSupabase } from '../../lib/fakeRealtimeSupabase.testutil';

// App.tsx's unread badge, NotificationsScreen and ConversationScreen all
// listen on the same user:<id> topic, and realtime-js hands every caller
// the same channel object for a topic. Each screen used to removeChannel()
// on unmount, killing App's badge listener with it. They now share the
// channel through src/lib/userRealtime.ts.

vi.mock('../../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../../lib/fakeRealtimeSupabase.testutil');
  const fake = createFakeSupabase();
  return { supabase: fake.supabase, getAuthToken: async () => 'token', __fake: fake };
});
vi.mock('../../lib/haptics', () => ({ haptics: { light: vi.fn(), medium: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));

import { onUserRealtime, closeAllUserRealtime } from '../../lib/userRealtime';
import { NotificationsScreen } from './NotificationsScreen';
import { ConversationScreen } from './ConversationScreen';

const fake = (supabaseModule as any).__fake as ReturnType<typeof createFakeSupabase>;
const ME = '0000000b-0000-0000-0000-00000000000b';
const OTHER = '0000000a-0000-0000-0000-00000000000a';
const MY_TOPIC = `user:${ME}`;
const flush = () => new Promise((r) => setTimeout(r, 0));

let container: HTMLDivElement;
let root: Root | null;
let appBadgeRefresh: Mock<() => void>;
let offAppBadge: () => void;

async function mount(node: React.ReactElement) {
  root = createRoot(container);
  await act(async () => { root!.render(node); });
}
function unmount() {
  act(() => root?.unmount());
  root = null;
}
const myChannelRemoved = () =>
  fake.supabase.removeChannel.mock.calls.some(([ch]) => (ch as any).topic === MY_TOPIC);

beforeEach(() => {
  fake.reset();
  if (!(Element.prototype as any).scrollIntoView) (Element.prototype as any).scrollIntoView = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  // Exactly what App.tsx's badge effect registers (asserted below).
  appBadgeRefresh = vi.fn();
  offAppBadge = onUserRealtime(ME, 'new_notification', () => appBadgeRefresh());
});

afterEach(async () => {
  if (root) unmount();
  offAppBadge();
  closeAllUserRealtime();
  fake.releaseRemovals();
  await flush();
  container.remove();
});

describe('shared user:<id> Realtime channel', () => {
  it("App.tsx registers its badge listener through userRealtime, not its own channel", () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    expect(app).toMatch(/onUserRealtime\(currentUser\.id, 'new_notification', \(\) => fetchUnreadCount\(\)\)/);
    expect(app).not.toMatch(/supabase\.channel\(`user:\$\{currentUser\.id\}`/);
  });

  it("unmounting NotificationsScreen leaves App's new_notification handler working", async () => {
    await mount(<NotificationsScreen onBack={() => {}} currentUser={{ id: ME }} />);
    const fetchesBefore = fake.supabase.from.mock.calls.filter(([t]) => t === 'notifications').length;
    act(() => fake.broadcast(MY_TOPIC, 'new_notification', { id: 'n1' }));
    expect(appBadgeRefresh).toHaveBeenCalledTimes(1);
    // The screen's own handler fired too (it refetches its list).
    expect(fake.supabase.from.mock.calls.filter(([t]) => t === 'notifications').length).toBeGreaterThan(fetchesBefore);

    unmount();
    expect(myChannelRemoved()).toBe(false);
    act(() => fake.broadcast(MY_TOPIC, 'new_notification', { id: 'n2' }));
    expect(appBadgeRefresh).toHaveBeenCalledTimes(2);
    expect(fake.created.filter((c) => c.topic === MY_TOPIC)).toHaveLength(1);
  });

  it("unmounting ConversationScreen leaves App's new_notification handler working", async () => {
    await mount(<ConversationScreen currentUser={{ id: ME }} otherUser={{ id: OTHER, name: 'Ada' }} onBack={() => {}} />);

    // The screen still gets its own events on the shared channel.
    const loadsBefore = fake.supabase.from.mock.calls.filter(([t]) => t === 'direct_messages').length;
    await act(async () => {
      fake.broadcast(MY_TOPIC, 'new_message', { sender_id: OTHER, recipient_id: ME });
      await flush();
    });
    expect(fake.supabase.from.mock.calls.filter(([t]) => t === 'direct_messages').length).toBeGreaterThan(loadsBefore);
    act(() => fake.broadcast(MY_TOPIC, 'typing', { from: OTHER }));
    expect(container.textContent).toContain('typing…');

    unmount();
    expect(myChannelRemoved()).toBe(false);
    // Its separate send-only channel to the other user's topic is still cleaned up.
    expect(fake.supabase.removeChannel.mock.calls.some(([ch]) => (ch as any).topic === `user:${OTHER}`)).toBe(true);

    act(() => fake.broadcast(MY_TOPIC, 'new_notification', { id: 'n1' }));
    expect(appBadgeRefresh).toHaveBeenCalledTimes(1);
  });

  it('removes the channel only after the last listener (App) unregisters', async () => {
    await mount(
      <>
        <NotificationsScreen onBack={() => {}} currentUser={{ id: ME }} />
        <ConversationScreen currentUser={{ id: ME }} otherUser={{ id: OTHER, name: 'Ada' }} onBack={() => {}} />
      </>,
    );
    expect(fake.created.filter((c) => c.topic === MY_TOPIC)).toHaveLength(1);

    unmount();
    expect(myChannelRemoved()).toBe(false);
    act(() => fake.broadcast(MY_TOPIC, 'new_notification'));
    expect(appBadgeRefresh).toHaveBeenCalledTimes(1);

    offAppBadge();
    expect(myChannelRemoved()).toBe(true);
    expect(fake.supabase.removeChannel.mock.calls.filter(([ch]) => (ch as any).topic === MY_TOPIC)).toHaveLength(1);
  });

  it('reopening a conversation right after leaving it keeps every listener live', async () => {
    fake.holdRemovals(); // leaves take a server round trip in real life
    const convo = <ConversationScreen currentUser={{ id: ME }} otherUser={{ id: OTHER, name: 'Ada' }} onBack={() => {}} />;
    await mount(convo);
    unmount();
    await mount(convo);
    fake.releaseRemovals();
    await flush();

    act(() => fake.broadcast(MY_TOPIC, 'typing', { from: OTHER }));
    expect(container.textContent).toContain('typing…');
    act(() => fake.broadcast(MY_TOPIC, 'new_notification'));
    expect(appBadgeRefresh).toHaveBeenCalledTimes(1);
  });
});
