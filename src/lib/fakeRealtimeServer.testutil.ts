// Test-only: an in-process stand-in for the Supabase Realtime server, used as
// the WebSocket transport of a REAL realtime-js RealtimeClient. Everything on
// the client side -- channel(topic) reuse, phx_join / phx_leave, rejoin,
// removeChannel(), teardown and removal from the client's channel list -- is
// the installed library's own code; only the socket is fake.
//
// Speaks the protocol the client actually uses by default (vsn 2.0.0): text
// frames are JSON arrays [join_ref, ref, topic, event, payload].

type Frame = [string | null, string | null, string, string, any];

export class FakeRealtimeServer {
  sockets = new Set<FakeSocket>();
  /** Every join/leave the server received, in order: e.g. "join realtime:user:abc". */
  log: string[] = [];
  /** topic -> join payload of the most recent join (config.private etc.) */
  joinPayloads = new Map<string, any>();
  /** Delay before the server processes and replies to phx_leave (ms): a late leave ack. */
  leaveReplyDelayMs = 0;

  /** Topics currently joined on any socket (joined and not yet left). */
  joinedTopics(): string[] {
    const t: string[] = [];
    for (const s of this.sockets) t.push(...s.joined.keys());
    return t.sort();
  }

  /** A server-originated broadcast, as the database trigger's realtime.send() produces. */
  broadcast(topic: string, event: string, payload: any = {}) {
    const full = topic.startsWith('realtime:') ? topic : `realtime:${topic}`;
    for (const s of this.sockets) {
      if (!s.joined.has(full)) continue;
      s.deliver([null, null, full, 'broadcast', { type: 'broadcast', event, payload }]);
    }
  }

  transport(): any {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    return class extends FakeSocket {
      constructor(url: string) { super(url, server); }
    };
  }
}

export class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  /** topic -> join_ref */
  joined = new Map<string, string | null>();

  constructor(public url: string, private server: FakeRealtimeServer) {
    server.sockets.add(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
  }

  deliver(frame: Frame) {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  private reply(frame: Frame, response: any = {}) {
    const [joinRef, ref, topic] = frame;
    this.deliver([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data !== 'string') return; // binary user broadcasts: not used by these topics
    const frame = JSON.parse(data) as Frame;
    const [joinRef, , topic, event, payload] = frame;
    if (topic === 'phoenix' && event === 'heartbeat') return this.reply(frame);
    if (event === 'phx_join') {
      this.server.log.push(`join ${topic}`);
      this.server.joinPayloads.set(topic, payload);
      this.joined.set(topic, joinRef);
      return this.reply(frame, { postgres_changes: [] });
    }
    if (event === 'phx_leave') {
      this.server.log.push(`leave ${topic}`);
      // Like Phoenix: a leave only ends the join it belongs to (same join_ref).
      // A late leave for an old join must not end a newer join of the topic.
      const done = () => { if (this.joined.get(topic) === joinRef) this.joined.delete(topic); this.reply(frame); };
      if (this.server.leaveReplyDelayMs > 0) setTimeout(done, this.server.leaveReplyDelayMs);
      else done();
      return;
    }
    if (event === 'access_token') return this.reply(frame);
  }

  close() {
    this.readyState = 3;
    this.server.sockets.delete(this);
    this.onclose?.({ code: 1000, reason: '' });
  }
}

/** Resolve after pending timers and microtasks have run (the client works through setTimeout(0)). */
export const settle = async (ms = 5) => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, ms));
};
