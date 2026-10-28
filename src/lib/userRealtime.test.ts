import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as supabaseModule from './supabase';
import type { createFakeSupabase } from './fakeRealtimeSupabase.testutil';

vi.mock('./supabase', async () => {
  const { createFakeSupabase } = await import('./fakeRealtimeSupabase.testutil');
  const fake = createFakeSupabase();
  return { supabase: fake.supabase, __fake: fake };
});

import { onUserRealtime, closeAllUserRealtime } from './userRealtime';

const fake = (supabaseModule as any).__fake as ReturnType<typeof createFakeSupabase>;
const ME = '0000000b-0000-0000-0000-00000000000b';
const TOPIC = `user:${ME}`;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => fake.reset());
afterEach(async () => {
  closeAllUserRealtime();
  fake.releaseRemovals();
  await flush();
});

describe('userRealtime', () => {
  it('opens one channel per topic no matter how many handlers register', () => {
    const offA = onUserRealtime(ME, 'new_notification', () => {});
    const offB = onUserRealtime(ME, 'new_notification', () => {});
    const offC = onUserRealtime(ME, 'new_message', () => {});
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].topic).toBe(TOPIC);
    expect(fake.created[0].opts).toEqual({ config: { broadcast: { self: false } } });
    expect(fake.created[0].subscribed).toBe(true);
    // One wildcard binding; routing happens in userRealtime.
    expect(fake.created[0].bindings).toHaveLength(1);
    offA(); offB(); offC();
  });

  it('routes each broadcast to the handlers registered for that event only', () => {
    const notif1 = vi.fn();
    const notif2 = vi.fn();
    const message = vi.fn();
    onUserRealtime(ME, 'new_notification', notif1);
    onUserRealtime(ME, 'new_notification', notif2);
    onUserRealtime(ME, 'new_message', message);

    fake.broadcast(TOPIC, 'new_notification', { id: 'n1' });
    expect(notif1).toHaveBeenCalledWith({ type: 'broadcast', event: 'new_notification', payload: { id: 'n1' } });
    expect(notif2).toHaveBeenCalledTimes(1);
    expect(message).not.toHaveBeenCalled();

    fake.broadcast(TOPIC, 'new_message', { id: 'm1' });
    expect(message).toHaveBeenCalledTimes(1);
    expect(notif1).toHaveBeenCalledTimes(1);
  });

  it('removes the channel only after the last listener unregisters', () => {
    const app = vi.fn();
    const offApp = onUserRealtime(ME, 'new_notification', app);
    const offScreen = onUserRealtime(ME, 'new_notification', () => {});
    const offChat = onUserRealtime(ME, 'new_message', () => {});

    offScreen();
    offChat();
    expect(fake.supabase.removeChannel).not.toHaveBeenCalled();
    fake.broadcast(TOPIC, 'new_notification');
    expect(app).toHaveBeenCalledTimes(1);

    offApp();
    expect(fake.supabase.removeChannel).toHaveBeenCalledTimes(1);
    expect(fake.supabase.removeChannel).toHaveBeenCalledWith(fake.created[0]);
  });

  it('treats a repeated unregister as a no-op, even for the same handler function registered twice', () => {
    const handler = vi.fn();
    const off1 = onUserRealtime(ME, 'new_notification', handler);
    const off2 = onUserRealtime(ME, 'new_notification', handler);
    off1();
    off1();
    expect(fake.supabase.removeChannel).not.toHaveBeenCalled();
    fake.broadcast(TOPIC, 'new_notification');
    expect(handler).toHaveBeenCalledTimes(1);
    off2();
    expect(fake.supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight removal before reopening the topic, then delivers on the fresh channel', async () => {
    fake.holdRemovals();
    onUserRealtime(ME, 'new_notification', () => {})();
    expect(fake.supabase.removeChannel).toHaveBeenCalledTimes(1);

    // Re-acquired while the old channel is still leaving: reusing it
    // (which supabase.channel(topic) would hand back) would be dead.
    const handler = vi.fn();
    onUserRealtime(ME, 'new_notification', handler);
    expect(fake.created).toHaveLength(1);

    fake.releaseRemovals();
    await flush();
    expect(fake.created).toHaveLength(2);
    expect(fake.created[1]).not.toBe(fake.created[0]);
    fake.broadcast(TOPIC, 'new_notification');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not reopen a topic whose listeners all left while a removal was in flight', async () => {
    fake.holdRemovals();
    onUserRealtime(ME, 'new_notification', () => {})();
    onUserRealtime(ME, 'new_notification', () => {})();
    fake.releaseRemovals();
    await flush();
    expect(fake.created).toHaveLength(1);
    expect(fake.live()).toHaveLength(0);
  });

  it('closeAllUserRealtime drops the channel; stale unregisters are no-ops and a later register starts fresh', async () => {
    const stale = vi.fn();
    const offStale = onUserRealtime(ME, 'new_notification', stale);
    closeAllUserRealtime();
    expect(fake.supabase.removeChannel).toHaveBeenCalledTimes(1);
    await flush();

    const fresh = vi.fn();
    onUserRealtime(ME, 'new_notification', fresh);
    await flush();
    offStale(); // e.g. App's effect cleanup running after sign-out
    expect(fake.supabase.removeChannel).toHaveBeenCalledTimes(1);

    fake.broadcast(TOPIC, 'new_notification');
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });

  it('keeps delivering to other handlers when one throws', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    onUserRealtime(ME, 'new_notification', () => { throw new Error('boom'); });
    onUserRealtime(ME, 'new_notification', ok);
    fake.broadcast(TOPIC, 'new_notification');
    expect(ok).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('keeps different users on separate channels', () => {
    const other = '0000000a-0000-0000-0000-00000000000a';
    const mine = vi.fn();
    const theirs = vi.fn();
    onUserRealtime(ME, 'new_notification', mine);
    const offTheirs = onUserRealtime(other, 'new_notification', theirs);
    expect(fake.created.map((c) => c.topic)).toEqual([TOPIC, `user:${other}`]);
    offTheirs();
    fake.broadcast(TOPIC, 'new_notification');
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });
});
