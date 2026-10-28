import { supabase } from './supabase';

// One shared Realtime subscription per signed-in user's personal topic
// (user:<uid>). realtime-js's supabase.channel(topic) hands back the SAME
// channel object to every caller for a topic, so when App.tsx (unread
// badge), NotificationsScreen and ConversationScreen each opened their own
// "channel" and removed it on unmount, the first screen to unmount tore the
// shared channel down for everyone -- App's badge went dead until its own
// effect happened to re-run.
//
// This module owns that channel: callers register a handler for one
// broadcast event and get back an unregister function. The channel is
// opened on the first handler for a topic and removed only when the last
// one unregisters, or on sign-out (closeAllUserRealtime).

export type UserRealtimeMessage = { type: string; event: string; payload?: any };
export type UserRealtimeHandler = (message: UserRealtimeMessage) => void;

type RealtimeChannel = ReturnType<typeof supabase.channel>;

type Entry = {
  topic: string;
  handlers: Map<string, Set<UserRealtimeHandler>>;
  channel: RealtimeChannel | null;
  closed: boolean;
};

const CHANNEL_OPTIONS = { config: { broadcast: { self: false } } };

const entries = new Map<string, Entry>();
// supabase.removeChannel() is async and the client keeps returning the
// leaving channel for its topic until the server acks, so a topic that is
// re-acquired mid-removal (leave a screen, come straight back) must wait
// for the old channel to be gone before opening a fresh one.
const pendingRemovals = new Map<string, Promise<unknown>>();

function topicFor(userId: string): string {
  return `user:${userId}`;
}

function dispatch(entry: Entry, message: UserRealtimeMessage) {
  const handlers = entry.handlers.get(message?.event);
  if (!handlers) return;
  // Copy: a handler may unregister itself (or another) while running.
  for (const handler of [...handlers]) {
    try {
      handler(message);
    } catch (err) {
      console.error(`userRealtime handler for ${entry.topic}/${message.event} failed:`, err);
    }
  }
}

function openChannel(entry: Entry) {
  if (entry.closed || entry.channel) return;
  const channel = supabase.channel(entry.topic, CHANNEL_OPTIONS);
  // One wildcard binding, routed by event name above, so handlers can come
  // and go without touching the channel's own bindings.
  channel.on('broadcast', { event: '*' }, (message: UserRealtimeMessage) => dispatch(entry, message));
  channel.subscribe();
  entry.channel = channel;
}

function closeEntry(entry: Entry) {
  entry.closed = true;
  entry.handlers.clear();
  if (entries.get(entry.topic) === entry) entries.delete(entry.topic);
  const channel = entry.channel;
  entry.channel = null;
  if (!channel) return;
  const removal: Promise<unknown> = supabase
    .removeChannel(channel)
    .catch((err: unknown) => console.error(`Failed to remove Realtime channel ${entry.topic}:`, err))
    .finally(() => {
      if (pendingRemovals.get(entry.topic) === removal) pendingRemovals.delete(entry.topic);
    });
  pendingRemovals.set(entry.topic, removal);
}

/**
 * Listen for one broadcast event on the signed-in user's personal topic.
 * Returns an unregister function; safe to call more than once, and a no-op
 * after closeAllUserRealtime() already closed the channel.
 */
export function onUserRealtime(userId: string, event: string, handler: UserRealtimeHandler): () => void {
  const topic = topicFor(userId);
  let entry = entries.get(topic);
  if (!entry) {
    const created: Entry = { topic, handlers: new Map(), channel: null, closed: false };
    entries.set(topic, created);
    const pending = pendingRemovals.get(topic);
    if (pending) pending.then(() => openChannel(created));
    else openChannel(created);
    entry = created;
  }

  let handlers = entry.handlers.get(event);
  if (!handlers) {
    handlers = new Set();
    entry.handlers.set(event, handlers);
  }
  // Wrap so the same function registered twice is counted twice.
  const registration: UserRealtimeHandler = (message) => handler(message);
  handlers.add(registration);

  const owner = entry;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (owner.closed) return;
    const set = owner.handlers.get(event);
    set?.delete(registration);
    if (set && set.size === 0) owner.handlers.delete(event);
    if (owner.handlers.size === 0) closeEntry(owner);
  };
}

/** Sign-out: drop every user channel and handler regardless of listeners. */
export function closeAllUserRealtime(): void {
  for (const entry of [...entries.values()]) closeEntry(entry);
}

