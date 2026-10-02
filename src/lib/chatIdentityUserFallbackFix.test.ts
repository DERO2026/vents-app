import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Chats/Inbox identity fix (migration 0153 + ExploreScreen.tsx).
//
// Root cause, confirmed live against project slrtjxtzhowhwhebjprv: the
// reachable "Chats" tab (ExploreScreen.tsx's loadConversations -- the
// unreferenced InboxScreen.tsx is not in this path) selected a
// `is_organizer` column from `public_profiles` that the view never
// exposed. PostgREST returned a 400 on every call; the frontend
// destructured only `{ data: profiles }` without checking `error`, so the
// failure was silent and every partner profile lookup returned null,
// forcing the generic 'User' name and missing-avatar fallback on every
// conversation row -- deterministic, not intermittent.
//
// Fix: migration 0153 adds the missing is_organizer column to
// get_public_profiles()/public_profiles (reproducing a live
// `ERROR: 42703: column "is_organizer" does not exist` before, and a
// clean row with real full_name/avatar_url/is_organizer after -- verified
// directly against the database for this task). ExploreScreen.tsx now also
// checks and logs the query's `error`, matching InboxScreen.tsx's existing
// correct pattern, so a future regression surfaces instead of silently
// falling back to 'User' on every row.

let m0153: string;
let exploreScreenSrc: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0153 = readFileSync(join(migrationsDir, '0153_fix_chat_identity_missing_is_organizer_column.sql'), 'utf8');
  exploreScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'ExploreScreen.tsx'), 'utf8');
});

describe('Migration 0153: adds is_organizer to public_profiles without weakening security', () => {
  it('does not DROP RLS or widen SELECT grants beyond authenticated/anon', () => {
    expect(m0153).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(m0153).toMatch(/GRANT SELECT ON public\.public_profiles TO authenticated, anon/);
    expect(m0153).not.toMatch(/GRANT SELECT ON public\.public_profiles TO (?!authenticated, anon)/);
  });

  it('keeps the view backed by the SECURITY DEFINER get_public_profiles() function, not a direct users table grant', () => {
    expect(m0153).toMatch(/STABLE SECURITY DEFINER/);
    expect(m0153).toMatch(/FROM get_public_profiles\(\)/);
  });

  it('preserves the original WHERE deleted_at IS NULL filter (deleted accounts stay excluded)', () => {
    expect(m0153).toMatch(/WHERE deleted_at IS NULL/);
  });

  it('preserves the admin-to-organizer role remap rather than exposing the raw admin role string', () => {
    expect(m0153).toMatch(/CASE WHEN role = 'admin' THEN 'organizer' ELSE role END/);
  });

  it('adds exactly one new column, is_organizer, to the function and the view', () => {
    const functionMatch = m0153.match(/CREATE OR REPLACE FUNCTION public\.get_public_profiles\(\)[\s\S]*?RETURNS TABLE\(([\s\S]*?)\)/);
    expect(functionMatch).toBeTruthy();
    expect(functionMatch![1]).toContain('is_organizer boolean');
    const viewMatch = m0153.match(/CREATE OR REPLACE VIEW public\.public_profiles AS([\s\S]*?)GRANT SELECT/);
    expect(viewMatch).toBeTruthy();
    expect(viewMatch![1]).toContain('is_organizer');
  });
});

describe('ExploreScreen.tsx: conversation-partner profile query checks its error', () => {
  it('destructures the error field from the public_profiles query used to build the chat list', () => {
    expect(exploreScreenSrc).toMatch(
      /from\('public_profiles'\)\s*\n\s*\.select\('id, full_name, username, avatar_url, vc_badge, role, is_organizer, last_active_at'\)\s*\n\s*\.in\('id', partnerIds\)/
    );
    expect(exploreScreenSrc).toMatch(/const \[\{ data: profiles, error: profilesError \}, spIds\]/);
  });

  it('logs and reports the error rather than silently treating it as zero results', () => {
    expect(exploreScreenSrc).toMatch(/if \(profilesError\) \{\s*\n\s*console\.error\('Failed to load conversation partner profiles:', profilesError\);\s*\n\s*Sentry\.captureException\(profilesError\);/);
  });
});

describe('ExploreScreen.tsx: identity resolution and fallback behavior', () => {
  it('conversation-list name resolution prefers real full_name/username over the generic fallback', () => {
    expect(exploreScreenSrc).toMatch(/const name = profile\?\.full_name \|\| profile\?\.username \|\| 'User';/);
  });

  it('message-requests name resolution uses the same profileMap-derived profile, not a separate query', () => {
    expect(exploreScreenSrc).toMatch(/const name = r\.profile\?\.full_name \|\| r\.profile\?\.username \|\| 'User';/);
    expect(exploreScreenSrc).toMatch(/profile: profileMap\.get\(r\.requester_id\) \|\| null,/);
  });

  it('avatar resolution reads profile.avatar_url, with no hardcoded image URL overriding it', () => {
    expect(exploreScreenSrc).toMatch(/const avatarUrl = profile\?\.avatar_url;/);
  });

  it('the same profileMap feeds both the conversation list and the chat-header identity passed to onOpenConversation, so they cannot diverge', () => {
    expect(exploreScreenSrc).toMatch(/onOpenConversation\?\.\(partnerId, name, avatarUrl, profile\?\.vc_badge\)/);
  });
});

describe('Sender/recipient direction resolves to the correct partner, not the current user', () => {
  it('partnerId is always the other party: recipient when current user sent, sender when current user received', () => {
    expect(exploreScreenSrc).toMatch(
      /const partnerId = msg\.sender_id === currentUserId \? msg\.recipient_id : msg\.sender_id;/
    );
  });
});

describe('Deleted/restricted profiles remain protected, not exposed via a wider query', () => {
  it('the partner profile query is scoped to the resolved public_profiles view (deleted_at-filtered), never the base users table', () => {
    const chatQueryBlock = exploreScreenSrc.match(/const \[\{ data: profiles, error: profilesError \}, spIds\] = await Promise\.all\(\[([\s\S]*?)\]\);/);
    expect(chatQueryBlock).toBeTruthy();
    expect(chatQueryBlock![1]).toContain("from('public_profiles')");
    expect(chatQueryBlock![1]).not.toContain("from('users')");
  });

  it('a partner with no resolvable profile (e.g. deleted) falls back gracefully to the generic identity rather than throwing or exposing restricted data', () => {
    expect(exploreScreenSrc).toMatch(/profile: profileMap\.get\(pid\) \|\| null,/);
    expect(exploreScreenSrc).toMatch(/const name = profile\?\.full_name \|\| profile\?\.username \|\| 'User';/);
  });
});
