import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Pre-release UX polish pass: four genuine release-relevant issues found by
// a code-only audit (no device/browser rendering available this session),
// each fixed with the smallest targeted change.

let authScreenSrc: string;
let organizerDashboardSrc: string;
let privacyScreenSrc: string;
let conversationScreenSrc: string;

beforeAll(() => {
  const componentsDir = join(__dirname, '..', 'app', 'components');
  authScreenSrc = readFileSync(join(componentsDir, 'AuthScreen.tsx'), 'utf8');
  organizerDashboardSrc = readFileSync(join(componentsDir, 'OrganizerDashboard.tsx'), 'utf8');
  privacyScreenSrc = readFileSync(join(componentsDir, 'PrivacyScreen.tsx'), 'utf8');
  conversationScreenSrc = readFileSync(join(componentsDir, 'ConversationScreen.tsx'), 'utf8');
});

describe('AuthScreen.tsx: signup disabled-button now explains itself', () => {
  it('computes a missing-field hint that excludes conditions with their own existing error message', () => {
    expect(authScreenSrc).toMatch(/signupMissingFieldHint/);
    // Must not duplicate the email/password-mismatch/dobError/signupsDisabled messages
    const hintBlock = authScreenSrc.match(/const signupMissingFieldHint = [\s\S]*?: null\);/)?.[0] ?? '';
    expect(hintBlock).toMatch(/email\.length === 0 \? null/);
    expect(hintBlock).toMatch(/password !== confirmPassword \? null/);
    expect(hintBlock).toMatch(/dobError \? null/);
  });

  it('covers every unexplained canSubmit condition: name, username, phone, state, role, dob, tos', () => {
    const hintBlock = authScreenSrc.match(/const signupMissingFieldHint = [\s\S]*?: null\);/)?.[0] ?? '';
    for (const field of ['name.trim', 'username.trim', 'phone.trim', 'signupState', 'role', '!dob', 'tosAccepted']) {
      expect(hintBlock).toContain(field);
    }
  });

  it('renders the hint near the submit button, not hidden elsewhere', () => {
    expect(authScreenSrc).toMatch(/\{signupMissingFieldHint && \(/);
  });
});

describe('OrganizerDashboard.tsx: Publish no longer lies about success on a failed write', () => {
  it('checks the update() call error before updating local state to "live"', () => {
    const publishBlock = organizerDashboardSrc.match(/onClick=\{async \(e\) => \{\s*e\.stopPropagation\(\);\s*setPublishingId[\s\S]*?✓ Publish/)?.[0] ?? '';
    expect(publishBlock).toMatch(/if \(error\) throw error;/);
    // setOrgEvents (optimistic "live" flip) must come AFTER the throw, i.e. inside the try before any catch
    const errorCheckIdx = publishBlock.indexOf('if (error) throw error;');
    const setOrgEventsIdx = publishBlock.indexOf('setOrgEvents(prev =>');
    expect(errorCheckIdx).toBeGreaterThan(-1);
    expect(setOrgEventsIdx).toBeGreaterThan(errorCheckIdx);
  });

  it('shows a busy state on the button and a distinct error message on failure, scoped per-event', () => {
    expect(organizerDashboardSrc).toMatch(/publishingId === event\.id \? 'Publishing\.\.\.' : '✓ Publish'/);
    expect(organizerDashboardSrc).toMatch(/publishErrorId === event\.id && \(/);
  });

  it('disables the button while a publish is in flight for that event', () => {
    expect(organizerDashboardSrc).toMatch(/disabled=\{publishingId === event\.id\}/);
  });
});

describe('PrivacyScreen.tsx: no stale InsForge reference in live legal copy', () => {
  it('names the current backend provider (Supabase), not the retired one', () => {
    expect(privacyScreenSrc).not.toMatch(/InsForge/);
    expect(privacyScreenSrc).toMatch(/cloud hosting\/database provider \(Supabase\)/);
  });
});

describe('ConversationScreen.tsx: a failed message load is distinguishable from an empty thread', () => {
  it('checks the direct_messages query error instead of destructuring { data } only', () => {
    expect(conversationScreenSrc).toMatch(/const \{ data, error \} = await query\.order\('created_at', \{ ascending: true \}\)\.limit\(100\);/);
    expect(conversationScreenSrc).toMatch(/if \(error\) throw error;/);
  });

  it('renders a distinct error+retry state rather than falling into the empty-thread message', () => {
    expect(conversationScreenSrc).toMatch(/loadError \? \(/);
    expect(conversationScreenSrc).toMatch(/Couldn't load your messages\./);
    expect(conversationScreenSrc).toMatch(/onClick=\{\(\) => \{ setLoading\(true\); load\(\); \}\}/);
  });

  it('clears the error flag at the start of each load attempt, so Retry can recover', () => {
    const loadFn = conversationScreenSrc.match(/async function load\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(loadFn).toMatch(/setLoadError\(false\);/);
    expect(loadFn).toMatch(/setLoadError\(true\);/);
  });
});
