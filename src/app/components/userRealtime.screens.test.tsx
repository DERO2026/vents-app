import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import React, { useEffect } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RealtimeClient } from '@supabase/realtime-js';
import { FakeRealtimeServer, settle } from '../../lib/fakeRealtimeServer.testutil';

// The unread-badge regression at screen level: the REAL NotificationsScreen
// and ConversationScreen mount and unmount against the REAL realtime-js
// client (fake server as its socket). App.tsx is too large to render here, so
// BadgeProbe registers the badge listener with the exact call App makes; a
// source check below pins App to that call.

const h = vi.hoisted(() => ({ client: null as any, fromCalls: [] as string[] }));
vi.mock('../../lib/supabase', () => {
  const chain = (): any =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve({ data: [], error: null, count: 0 }) : chain()),
      apply: () => chain(),
    });
  return {
    supabase: {
      from: (table: string) => { h.fromCalls.push(table); return chain(); },
      rpc: () => Promise.resolve({ data: null, error: null }),
      storage: { from: () => chain() },
      channel: (topic: string, opts?: any) => h.client.channel(topic, opts),
      removeChannel: (ch: any) => h.client.removeChannel(ch),
    },
  };
});
vi.mock('../../lib/haptics', () => ({ haptics: { light: vi.fn(), medium: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));

import { NotificationsScreen } from './NotificationsScreen';
import { ConversationScreen } from './ConversationScreen';
import { onUserRealtime, closeAllUserRealtime, userRealtimeState } from '../../lib/userRealtime';
import { dmTopic, userTopic } from '../../lib/realtimeTopics';

const ME = '0000000b-0000-0000-0000-00000000000b';
const OTHER = '0000000a-0000-0000-0000-00000000000a';
const ME_TOPIC = `realtime:${userTopic(ME)}`;
const DM_TOPIC = `realtime:${dmTopic(ME, OTHER)}`;

const badgeRefreshes = vi.fn();
// Mirrors App.tsx's badge effect (pinned by the source test at the bottom).
function BadgeProbe({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (!userId) return;
    return onUserRealtime(userId, 'new_notification', () => badgeRefreshes(userId));
  }, [userId]);
  return null;
}

let server: FakeRealtimeServer;
let appRoot: Root; let screenRoot: Root;
let appEl: HTMLDivElement; let screenEl: HTMLDivElement;

const mountScreen = async (node: React.ReactNode) => {
  await act(async () => { screenRoot.render(node); });
  await act(async () => { await settle(); });
};
const unmountScreen = async () => {
  await act(async () => { screenRoot.render(null); });
  await act(async () => { await settle(); });
};
const serverSends = async (topic: string, event: string, payload: any = {}) => {
  await act(async () => { server.broadcast(topic, event, payload); await settle(); });
};
const count = (table: string) => h.fromCalls.filter((t) => t === table).length;

beforeEach(async () => {
  server = new FakeRealtimeServer();
  h.client = new RealtimeClient('ws://realtime.test/realtime/v1', {
    transport: server.transport(), params: { apikey: 'anon' }, timeout: 1000, heartbeatIntervalMs: 60_000,
  });
  h.fromCalls.length = 0;
  badgeRefreshes.mockClear();
  if (!(Element.prototype as any).scrollIntoView) (Element.prototype as any).scrollIntoView = () => {};
  appEl = document.createElement('div'); screenEl = document.createElement('div');
  document.body.append(appEl, screenEl);
  appRoot = createRoot(appEl); screenRoot = createRoot(screenEl);
  await act(async () => { appRoot.render(<BadgeProbe userId={ME} />); });
  await act(async () => { await settle(); });
});
afterEach(async () => {
  act(() => { screenRoot.unmount(); appRoot.unmount(); });
  await closeAllUserRealtime();
  await settle();
  appEl.remove(); screenEl.remove();
  h.client.disconnect();
});

describe('unread badge keeps updating across screen lifecycles (real client)', () => {
  it('navigating into and out of Notifications', async () => {
    await mountScreen(<NotificationsScreen currentUser={{ id: ME }} onBack={() => {}} />);
    expect(server.log).toEqual([`join ${ME_TOPIC}`]);          // one shared join
    const before = count('notifications');
    await serverSends(ME_TOPIC, 'new_notification');
    expect(badgeRefreshes).toHaveBeenCalledTimes(1);
    expect(count('notifications')).toBeGreaterThan(before);     // the open screen refreshed too

    await unmountScreen();                                       // back out of Notifications
    expect(server.joinedTopics()).toEqual([ME_TOPIC]);
    await serverSends(ME_TOPIC, 'new_notification');
    expect(badgeRefreshes).toHaveBeenCalledTimes(2);             // the badge is still live
    expect(server.log).toEqual([`join ${ME_TOPIC}`]);
  });

  it('opening and closing a conversation', async () => {
    await mountScreen(<ConversationScreen currentUser={{ id: ME }} otherUser={{ id: OTHER, name: 'Ada' }} onBack={() => {}} />);
    expect(server.joinedTopics()).toEqual([DM_TOPIC, ME_TOPIC].sort());
    expect(server.log.filter((l) => l === `join ${ME_TOPIC}`)).toHaveLength(1);   // no second user join
    const before = count('direct_messages');
    await serverSends(ME_TOPIC, 'new_message', { sender_id: OTHER, recipient_id: ME });
    expect(count('direct_messages')).toBeGreaterThan(before);   // the thread reloaded

    await unmountScreen();                                       // close the chat
    expect(server.joinedTopics()).toEqual([ME_TOPIC]);           // only its own dm channel left
    expect(server.log).toContain(`leave ${DM_TOPIC}`);
    expect(server.log).not.toContain(`leave ${ME_TOPIC}`);
    await serverSends(ME_TOPIC, 'new_notification');
    expect(badgeRefreshes).toHaveBeenCalledTimes(1);
  });

  it('many visits to both screens: still one user join, no leaked handlers, badge live', async () => {
    for (let i = 0; i < 4; i++) {
      await mountScreen(<NotificationsScreen currentUser={{ id: ME }} onBack={() => {}} />);
      await unmountScreen();
      await mountScreen(<ConversationScreen currentUser={{ id: ME }} otherUser={{ id: OTHER, name: 'Ada' }} onBack={() => {}} />);
      await unmountScreen();
    }
    expect(server.log.filter((l) => l === `join ${ME_TOPIC}`)).toHaveLength(1);
    expect(server.log).not.toContain(`leave ${ME_TOPIC}`);
    expect(userRealtimeState()).toEqual([{ topic: userTopic(ME), open: true, handlers: { new_notification: 1 } }]);
    expect(h.client.getChannels().map((c: any) => c.topic)).toEqual([ME_TOPIC]);
    await serverSends(ME_TOPIC, 'new_notification');
    expect(badgeRefreshes).toHaveBeenCalledTimes(1);
  });

  it('both screens open at once, then closed in either order', async () => {
    const second = document.createElement('div'); document.body.append(second);
    const secondRoot = createRoot(second);
    await mountScreen(<NotificationsScreen currentUser={{ id: ME }} onBack={() => {}} />);
    await act(async () => { secondRoot.render(<ConversationScreen currentUser={{ id: ME }} otherUser={{ id: OTHER, name: 'Ada' }} onBack={() => {}} />); await settle(); });
    expect(userRealtimeState()[0].handlers).toEqual({ new_notification: 2, new_message: 1 });
    await unmountScreen();
    await act(async () => { secondRoot.unmount(); await settle(); });
    second.remove();
    expect(userRealtimeState()[0].handlers).toEqual({ new_notification: 1 });
    await serverSends(ME_TOPIC, 'new_notification');
    expect(badgeRefreshes).toHaveBeenCalledTimes(1);
  });
});

describe('logout and account switching (real client)', () => {
  it('logout releases the user channel even with a screen still mounted; its later unmount is harmless', async () => {
    await mountScreen(<NotificationsScreen currentUser={{ id: ME }} onBack={() => {}} />);
    await act(async () => { await closeAllUserRealtime(); await settle(); });
    expect(server.joinedTopics()).toEqual([]);
    expect(h.client.getChannels()).toEqual([]);
    await unmountScreen();
    await act(async () => { appRoot.render(<BadgeProbe userId={null} />); await settle(); });
    expect(server.log).toEqual([`join ${ME_TOPIC}`, `leave ${ME_TOPIC}`]);
  });

  it('switching accounts moves the badge to the new user\'s private topic only', async () => {
    await act(async () => { appRoot.render(<BadgeProbe userId={OTHER} />); await settle(); });
    const OTHER_TOPIC = `realtime:${userTopic(OTHER)}`;
    expect(server.joinedTopics()).toEqual([OTHER_TOPIC]);
    expect(server.joinPayloads.get(OTHER_TOPIC).config.private).toBe(true);
    await serverSends(ME_TOPIC, 'new_notification');
    await serverSends(OTHER_TOPIC, 'new_notification');
    expect(badgeRefreshes.mock.calls).toEqual([[OTHER]]);
  });
});

describe('App.tsx uses the same registration as BadgeProbe', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  it('the badge effect registers through onUserRealtime and returns its unregister', () => {
    expect(app).toMatch(/if \(!currentUser\?\.id\) return;\s*return onUserRealtime\(currentUser\.id, 'new_notification', \(\) => fetchUnreadCount\(\)\);/);
    expect(app).not.toMatch(/supabase\.channel\(userTopic/);
  });
  it('both sign-out paths release every user channel', () => {
    expect(app.match(/void closeAllUserRealtime\(\);/g)?.length).toBe(2);
    expect(app).toMatch(/if \(explicitSignOutRef\.current\) return;\s*void closeAllUserRealtime\(\);/);
  });
});
