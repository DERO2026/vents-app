// Private Realtime topics for private Chats and per-user activity
// (migration 0199). Both are PRIVATE channels: the Realtime server checks
// the realtime.messages RLS policies with the signed-in user's JWT
// (supabase-js passes it automatically) before letting a client join.
//
//   user:<uid>        server-to-user only: new_message / new_notification
//                     signals from the database triggers. Only <uid> may
//                     receive; no client may send.
//   dm:<uid>:<uid>    one private conversation, ids in sorted order: typing
//                     indicators. Only the two participants may receive or
//                     send, and neither while either has blocked the other.
//
// Payloads are invalidation signals only (no message bodies); screens
// reload through the tables' own RLS.

export const PRIVATE_CHANNEL_OPTIONS = { config: { private: true, broadcast: { self: false } } };

export function userTopic(userId: string): string {
  return `user:${userId.toLowerCase()}`;
}

export function dmTopic(userA: string, userB: string): string {
  const [first, second] = [userA.toLowerCase(), userB.toLowerCase()].sort();
  return `dm:${first}:${second}`;
}
