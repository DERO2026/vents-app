import { vi } from 'vitest';

// Test double for the bits of supabase-js these Realtime tests touch. It
// copies realtime-js's behaviour that caused the shared-channel bug:
// channel(topic) returns the EXISTING channel for a topic, and
// removeChannel() kills that channel for every holder at once, while the
// client keeps handing it out until the async leave completes.

export type FakeBinding = { type: string; event: string; cb: (message: any) => void };

export class FakeChannel {
  bindings: FakeBinding[] = [];
  subscribed = false;
  removed = false;
  send = vi.fn(async () => 'ok');
  constructor(public topic: string, public opts: any) {}
  on(type: string, filter: { event: string }, cb: (message: any) => void) {
    this.bindings.push({ type, event: filter.event, cb });
    return this;
  }
  subscribe() {
    this.subscribed = true;
    return this;
  }
}

export function createFakeSupabase() {
  const channels: FakeChannel[] = [];
  const created: FakeChannel[] = [];
  const pendingLeaves: (() => void)[] = [];
  let holdRemovals = false;

  // Any query chain resolves to an empty, successful result.
  const chain = (): any =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve({ data: [], error: null, count: 0 }) : chain()),
      apply: () => chain(),
    });

  const supabase = {
    from: vi.fn((_table: string) => chain()),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    storage: { from: () => chain() },
    channel: vi.fn((topic: string, opts?: any) => {
      const existing = channels.find((c) => c.topic === topic);
      if (existing) return existing;
      const ch = new FakeChannel(topic, opts);
      channels.push(ch);
      created.push(ch);
      return ch;
    }),
    removeChannel: vi.fn((ch: FakeChannel) => {
      ch.removed = true; // stops delivering to every holder immediately
      return new Promise<string>((resolve) => {
        const leave = () => {
          const i = channels.indexOf(ch);
          if (i >= 0) channels.splice(i, 1);
          resolve('ok');
        };
        if (holdRemovals) pendingLeaves.push(leave);
        else leave();
      });
    }),
  };

  return {
    supabase,
    /** Every channel object ever created, in order. */
    created,
    /** Channels the client currently holds (what channel(topic) can return). */
    live: () => [...channels],
    /** Server-side broadcast to whatever channel currently holds the topic. */
    broadcast(topic: string, event: string, payload: any = {}) {
      const ch = channels.find((c) => c.topic === topic);
      if (!ch || ch.removed || !ch.subscribed) return;
      for (const b of ch.bindings) {
        if (b.type === 'broadcast' && (b.event === '*' || b.event === event)) b.cb({ type: 'broadcast', event, payload });
      }
    },
    /** Keep removeChannel() promises pending until releaseRemovals(). */
    holdRemovals() {
      holdRemovals = true;
    },
    releaseRemovals() {
      holdRemovals = false;
      pendingLeaves.splice(0).forEach((leave) => leave());
    },
    reset() {
      channels.length = 0;
      created.length = 0;
      pendingLeaves.length = 0;
      holdRemovals = false;
      supabase.channel.mockClear();
      supabase.removeChannel.mockClear();
      supabase.from.mockClear();
    },
  };
}
