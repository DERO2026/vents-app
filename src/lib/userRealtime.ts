// One shared, reference-counted Realtime subscription per signed-in user's
// private personal topic (user:<uid>, migration 0199).
//
// Why this exists: realtime-js's channel(topic) returns the SAME channel
// object to every caller that asks for a topic it already holds
// (RealtimeClient.channel: "If a channel with the same topic already exists
// it will be returned"), and removeChannel() unsubscribes and tears down that
// one object. App.tsx (unread badge), NotificationsScreen and
// ConversationScreen each opened "their own" user:<uid> channel and removed
// it on unmount, so leaving a chat or the notifications screen killed the
// badge's listener too: the badge stopped updating until App's effect
// happened to re-run. Each screen's .on() bindings also stayed attached to
// the shared channel, because realtime-js has no way to remove one binding.
//
// This module is the only place that opens or removes user:<uid> channels:
//   * onUserRealtime(userId, event, handler) registers one handler and
//     returns its unregister function (idempotent);
//   * the channel is opened on the first handler for a topic and removed
//     only when the LAST handler for it unregisters, or on sign-out
//     (closeAllUserRealtime);
//   * it carries a single broadcast binding (event '*') that dispatches by
//     event name to the registered handlers, so handlers come and go without
//     touching the channel's own bindings;
//   * removeChannel() is asynchronous and the client keeps handing out the
//     leaving channel for its topic until the leave completes, so a topic
//     re-acquired mid-removal waits for the old channel to be gone before a
//     fresh one is opened.
// The channel is private (PRIVATE_CHANNEL_OPTIONS): the Realtime server only
// lets <uid> join user:<uid> (realtime.messages RLS, 0199).

import { supabase } from './supabase';
import { PRIVATE_CHANNEL_OPTIONS, userTopic } from './realtimeTopics';

export type UserRealtimeMessage = { type?: string; event: string; payload?: any };
export type UserRealtimeHandler = (message: UserRealtimeMessage) => void;

type RealtimeChannel = ReturnType<typeof supabase.channel>;

type Entry = {
  topic: string;
  /** event name (lower case) -> registered handlers */
  handlers: Map<string, Set<UserRealtimeHandler>>;
  channel: RealtimeChannel | null;
  closed: boolean;
};

const entries = new Map<string, Entry>();
const pendingRemovals = new Map<string, Promise<void>>();

// realtime-js compares broadcast event names case-insensitively; so do we.
const eventKey = (event: string) => (event ?? '').toLowerCase();

function dispatch(entry: Entry, message: UserRealtimeMessage) {
  if (entry.closed) return;
  const handlers = entry.handlers.get(eventKey(message?.event));
  if (!handlers) return;
  // Copy: a handler may unregister itself (or another one) while running.
  for (const handler of [...handlers]) {
    try {
      handler(message);
    } catch (err) {
      console.error(`userRealtime: handler for ${entry.topic}/${message.event} failed`, err);
    }
  }
}

function openChannel(entry: Entry) {
  if (entry.closed || entry.channel) return;
  const channel = supabase.channel(entry.topic, PRIVATE_CHANNEL_OPTIONS);
  channel.on('broadcast', { event: '*' }, (message: UserRealtimeMessage) => dispatch(entry, message));
  channel.subscribe();
  entry.channel = channel;
}

function closeEntry(entry: Entry): Promise<void> {
  entry.closed = true;
  entry.handlers.clear();
  if (entries.get(entry.topic) === entry) entries.delete(entry.topic);
  const channel = entry.channel;
  entry.channel = null;
  if (!channel) return pendingRemovals.get(entry.topic) ?? Promise.resolve();
  const removal: Promise<void> = Promise.resolve()
    .then(() => supabase.removeChannel(channel))
    .then(
      () => undefined,
      (err: unknown) => { console.error(`userRealtime: failed to remove ${entry.topic}`, err); },
    )
    .finally(() => {
      if (pendingRemovals.get(entry.topic) === removal) pendingRemovals.delete(entry.topic);
    });
  pendingRemovals.set(entry.topic, removal);
  return removal;
}

/**
 * Listen for one broadcast event (e.g. 'new_notification', 'new_message')
 * on the signed-in user's private personal topic. Returns an unregister
 * function: safe to call more than once, and a no-op after
 * closeAllUserRealtime() has already closed the channel.
 */
export function onUserRealtime(userId: string, event: string, handler: UserRealtimeHandler): () => void {
  const topic = userTopic(userId);
  let entry = entries.get(topic);
  if (!entry) {
    const created: Entry = { topic, handlers: new Map(), channel: null, closed: false };
    entries.set(topic, created);
    const pending = pendingRemovals.get(topic);
    if (pending) void pending.then(() => openChannel(created));
    else openChannel(created);
    entry = created;
  }

  const key = eventKey(event);
  let handlers = entry.handlers.get(key);
  if (!handlers) {
    handlers = new Set();
    entry.handlers.set(key, handlers);
  }
  // Wrapped, so the same function registered twice counts (and unregisters) twice.
  const registration: UserRealtimeHandler = (message) => handler(message);
  handlers.add(registration);

  const owner = entry;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (owner.closed) return;
    const set = owner.handlers.get(key);
    set?.delete(registration);
    if (set && set.size === 0) owner.handlers.delete(key);
    // Deferred by one microtask: a React effect re-run (cleanup, then the new
    // effect, in the same commit) re-registers before this runs, so the
    // channel is kept instead of leaving and immediately re-joining.
    if (owner.handlers.size === 0) {
      queueMicrotask(() => {
        if (!owner.closed && owner.handlers.size === 0) void closeEntry(owner);
      });
    }
  };
}

/**
 * Sign-out / account switch: drop every user channel and handler, whoever
 * registered them. Resolves once the channels have left.
 */
export function closeAllUserRealtime(): Promise<void> {
  const closing = [...entries.values()].map(closeEntry);
  return Promise.all([...closing, ...pendingRemovals.values()]).then(() => undefined);
}

/** Test/diagnostic view: open topics and their handler counts per event. */
export function userRealtimeState(): { topic: string; open: boolean; handlers: Record<string, number> }[] {
  return [...entries.values()].map((e) => ({
    topic: e.topic,
    open: !!e.channel,
    handlers: Object.fromEntries([...e.handlers].map(([k, s]) => [k, s.size])),
  }));
}
