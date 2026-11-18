import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeClient } from '@supabase/realtime-js';
import { FakeRealtimeServer, settle } from './fakeRealtimeServer.testutil';

// The shared user:<uid> subscription, exercised against the REAL realtime-js
// RealtimeClient (installed version) with an in-process fake server as its
// socket. channel() reuse, join/leave, removeChannel() and teardown are the
// library's own code, so these tests cover the actual lifecycle that broke
// the unread badge, not a mock of it.

const h = vi.hoisted(() => ({ client: null as any }));
vi.mock('./supabase', () => ({
  supabase: {
    // supabase-js's own channel()/removeChannel() delegate to its RealtimeClient exactly like this.
    channel: (topic: string, opts?: any) => h.client.channel(topic, opts),
    removeChannel: (ch: any) => h.client.removeChannel(ch),
  },
}));

import { onUserRealtime, closeAllUserRealtime, userRealtimeState } from './userRealtime';
import { PRIVATE_CHANNEL_OPTIONS, userTopic } from './realtimeTopics';

const A = '0000000A-0000-0000-0000-00000000000a';
const B = '0000000b-0000-0000-0000-00000000000b';
const TOPIC_A = `realtime:${userTopic(A)}`;
const TOPIC_B = `realtime:${userTopic(B)}`;

let server: FakeRealtimeServer;

beforeEach(() => {
  server = new FakeRealtimeServer();
  h.client = new RealtimeClient('ws://realtime.test/realtime/v1', {
    transport: server.transport(),
    params: { apikey: 'anon' },
    timeout: 1000,
    heartbeatIntervalMs: 60_000,
  });
});
afterEach(async () => {
  await closeAllUserRealtime();
  await settle();
  h.client.disconnect();
});

describe('the bug, reproduced with the real client and the old per-screen pattern', () => {
  it('a screen removing "its" user channel kills the app-level listener on the same topic', async () => {
    const badge = vi.fn();
    const appChannel = h.client.channel(userTopic(A), PRIVATE_CHANNEL_OPTIONS);
    appChannel.on('broadcast', { event: 'new_notification' }, badge);
    appChannel.subscribe();
    const screenChannel = h.client.channel(userTopic(A), PRIVATE_CHANNEL_OPTIONS);
    expect(screenChannel).toBe(appChannel);                  // the library hands back the same object
    screenChannel.on('broadcast', { event: 'new_notification' }, () => {});
    screenChannel.subscribe();
    await settle();
    await h.client.removeChannel(screenChannel);              // the screen unmounts
    await settle();
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(badge).not.toHaveBeenCalled();                      // the badge is dead
    expect(server.joinedTopics()).toEqual([]);
  });
});

describe('onUserRealtime: one shared, reference-counted channel', () => {
  it('app + notifications + conversation share ONE private join of the user topic', async () => {
    const offs = [
      onUserRealtime(A, 'new_notification', () => {}),
      onUserRealtime(A, 'new_notification', () => {}),
      onUserRealtime(A, 'new_message', () => {}),
    ];
    await settle();
    expect(server.log).toEqual([`join ${TOPIC_A}`]);
    expect(server.joinPayloads.get(TOPIC_A).config.private).toBe(true);   // 0199: private topic
    expect(h.client.getChannels().map((c: any) => c.topic)).toEqual([TOPIC_A]);
    expect(userRealtimeState()).toEqual([{ topic: userTopic(A), open: true, handlers: { new_notification: 2, new_message: 1 } }]);
    offs.forEach((off) => off());
  });

  it('leaving Notifications keeps the badge listener receiving', async () => {
    const badge = vi.fn();
    const offBadge = onUserRealtime(A, 'new_notification', badge);
    const notifications = vi.fn();
    const offNotifications = onUserRealtime(A, 'new_notification', notifications);
    await settle();
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(badge).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveBeenCalledTimes(1);

    offNotifications();                                       // navigate out of Notifications
    await settle();
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(badge).toHaveBeenCalledTimes(2);
    expect(notifications).toHaveBeenCalledTimes(1);           // the screen's handler is gone
    expect(server.log).toEqual([`join ${TOPIC_A}`]);          // never left, never re-joined
    offBadge();
  });

  it('opening and closing a conversation keeps the badge listener receiving', async () => {
    const badge = vi.fn();
    const offBadge = onUserRealtime(A, 'new_notification', badge);
    for (let i = 0; i < 3; i++) {                             // open/close the chat three times
      const chat = vi.fn();
      const offChat = onUserRealtime(A, 'new_message', chat);
      await settle();
      server.broadcast(TOPIC_A, 'new_message', { sender_id: B, recipient_id: A });
      await settle();
      expect(chat).toHaveBeenCalledTimes(1);
      expect(chat.mock.calls[0][0].payload).toEqual({ sender_id: B, recipient_id: A });
      offChat();
      await settle();
    }
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(badge).toHaveBeenCalledTimes(1);
    expect(server.log).toEqual([`join ${TOPIC_A}`]);
    offBadge();
  });

  it('events go only to their own handlers (and match case-insensitively, like realtime-js)', async () => {
    const notif = vi.fn(); const msg = vi.fn();
    const offs = [onUserRealtime(A, 'new_notification', notif), onUserRealtime(A, 'NEW_MESSAGE', msg)];
    await settle();
    server.broadcast(TOPIC_A, 'new_message');
    server.broadcast(TOPIC_A, 'vc_updated');                  // nobody listens: ignored
    await settle();
    expect(notif).not.toHaveBeenCalled();
    expect(msg).toHaveBeenCalledTimes(1);
    offs.forEach((off) => off());
  });

  it('the last handler leaving removes the channel (no leak); unregister is idempotent', async () => {
    const off1 = onUserRealtime(A, 'new_notification', () => {});
    const off2 = onUserRealtime(A, 'new_message', () => {});
    await settle();
    off1(); off1();                                           // double call: counted once
    await settle();
    expect(server.joinedTopics()).toEqual([TOPIC_A]);
    off2();
    await settle();
    expect(server.log).toEqual([`join ${TOPIC_A}`, `leave ${TOPIC_A}`]);
    expect(server.joinedTopics()).toEqual([]);
    expect(h.client.getChannels()).toEqual([]);
    expect(userRealtimeState()).toEqual([]);
  });

  it('an effect re-run (unregister, then register in the same tick) keeps the channel: no leave/join churn', async () => {
    const first = vi.fn();
    const off = onUserRealtime(A, 'new_notification', first);
    await settle();
    const channel = h.client.getChannels()[0];
    off();                                                    // React: old effect's cleanup...
    const second = vi.fn();
    const offSecond = onUserRealtime(A, 'new_notification', second);   // ...then the new effect
    await settle();
    expect(server.log).toEqual([`join ${TOPIC_A}`]);
    expect(h.client.getChannels()).toEqual([channel]);
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    offSecond();
  });

  it('the same function registered twice counts twice', async () => {
    const fn = vi.fn();
    const offA = onUserRealtime(A, 'new_notification', fn);
    const offB = onUserRealtime(A, 'new_notification', fn);
    await settle();
    offA();
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(server.joinedTopics()).toEqual([TOPIC_A]);
    offB();
  });

  it('leave and come straight back (late server ack): a fresh channel, never the leaving one, and it receives', async () => {
    // realtime-js (phoenix leave(): state=leaving, then !canPush() -> local "ok") drops the
    // channel from its list without waiting for the server, and sends phx_leave. The server's
    // ack for the OLD join arrives after the NEW join here; it must not end the new one.
    server.leaveReplyDelayMs = 30;
    const off = onUserRealtime(A, 'new_notification', () => {});
    await settle();
    const leaving = h.client.getChannels()[0];
    off();
    // Come back only once the leave has really gone out (the close is deferred one microtask,
    // so a same-tick re-register would simply keep the channel -- covered separately).
    for (let i = 0; i < 50 && !server.log.includes(`leave ${TOPIC_A}`); i++) await Promise.resolve();
    expect(server.log).toEqual([`join ${TOPIC_A}`, `leave ${TOPIC_A}`]);
    const fresh = vi.fn();
    const offFresh = onUserRealtime(A, 'new_notification', fresh);
    await settle(1);
    const now = h.client.getChannels();
    expect(now.length).toBe(1);
    expect(now[0]).not.toBe(leaving);                         // the dying channel was not reused
    expect(leaving.state).toBe('closed');
    await settle(30);                                         // the late leave ack arrives
    expect(server.log).toEqual([`join ${TOPIC_A}`, `leave ${TOPIC_A}`, `join ${TOPIC_A}`]);
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(fresh).toHaveBeenCalledTimes(1);
    offFresh();
  });

  it('a handler that throws does not stop the others', async () => {
    const after = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offs = [onUserRealtime(A, 'new_notification', () => { throw new Error('boom'); }), onUserRealtime(A, 'new_notification', after)];
    await settle();
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(after).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    offs.forEach((off) => off());
  });
});

describe('logout and account switching', () => {
  it('logout closes every user channel, whoever registered it; late unregisters are harmless', async () => {
    const badge = vi.fn();
    const offBadge = onUserRealtime(A, 'new_notification', badge);
    const offChat = onUserRealtime(A, 'new_message', () => {});
    await settle();
    await closeAllUserRealtime();
    await settle();
    expect(server.joinedTopics()).toEqual([]);
    expect(h.client.getChannels()).toEqual([]);
    expect(userRealtimeState()).toEqual([]);
    offBadge(); offChat();                                    // screens unmount after sign-out
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(badge).not.toHaveBeenCalled();
    expect(server.log.filter((l) => l.startsWith('leave'))).toEqual([`leave ${TOPIC_A}`]);
  });

  it('switching accounts: user A is fully released, user B gets its own private channel and only B\'s events', async () => {
    const aBadge = vi.fn();
    const offA = onUserRealtime(A, 'new_notification', aBadge);
    await settle();
    offA();                                                   // App's effect cleanup for A
    await closeAllUserRealtime();
    const bBadge = vi.fn();
    const offB = onUserRealtime(B, 'new_notification', bBadge);
    await settle();
    expect(server.joinedTopics()).toEqual([TOPIC_B]);
    expect(server.joinPayloads.get(TOPIC_B).config.private).toBe(true);
    server.broadcast(TOPIC_A, 'new_notification');
    server.broadcast(TOPIC_B, 'new_notification');
    await settle();
    expect(aBadge).not.toHaveBeenCalled();
    expect(bBadge).toHaveBeenCalledTimes(1);
    offB();
  });

  it('a handler registered while logout is still leaving is not attached to the dying channel', async () => {
    server.leaveReplyDelayMs = 30;
    onUserRealtime(A, 'new_notification', () => {});
    await settle();
    const closing = closeAllUserRealtime();
    const again = vi.fn();
    const off = onUserRealtime(A, 'new_notification', again); // e.g. signing straight back in
    await closing;
    await settle(30);
    server.broadcast(TOPIC_A, 'new_notification');
    await settle();
    expect(again).toHaveBeenCalledTimes(1);
    expect(server.joinedTopics()).toEqual([TOPIC_A]);
    off();
  });
});
