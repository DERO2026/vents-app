import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression test for the actual, PROVEN root cause of "new row violates
// row-level security policy for table service_providers" on Save & Publish
// (confirmed via a live diagnostic against Preview -- not guessed):
//
// uid match=true, is_service_provider=false, role=organizer
//
// ProfileScreen's canAccessProviderSetup treats an 'approved'
// service_provider_requests row as sufficient to reach Setup (added to
// close a UX race right after admin approval -- in the normal flow,
// admin_decide_service_provider_request sets service_provider_requests.
// status AND users.is_service_provider atomically, so they can never
// disagree). A real account was found where they HAD disagreed: request
// status said 'approved' while is_service_provider was still false --
// RLS correctly rejected the write; the bug was letting the client attempt
// it at all on a signal that can drift from the authoritative flag.
//
// Fix: ServiceProviderSetupScreen re-checks users.is_service_provider
// directly, immediately before the write, and refuses with an honest
// message if it's false -- never trusting whatever got the user onto this
// screen. No RLS policy was touched or weakened.

let setupScreenSrc: string;

beforeAll(() => {
  setupScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'ServiceProviderSetupScreen.tsx'), 'utf8');
});

describe('ServiceProviderSetupScreen: authoritative capability re-check before Save & Publish', () => {
  it('handleSave fetches the live is_service_provider flag directly from the users table before attempting the write', () => {
    const fn = setupScreenSrc.match(/const handleSave = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(fn).toMatch(/\.from\('users'\)/);
    expect(fn).toMatch(/\.select\('is_service_provider'\)/);
    expect(fn).toMatch(/\.eq\('id', currentUser\.id\)/);
  });

  it('refuses the write with an honest, actionable message if the authoritative flag is false, instead of attempting an insert RLS would reject', () => {
    const fn = setupScreenSrc.match(/const handleSave = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!capRow\?\.is_service_provider\) \{/);
    expect(fn).toMatch(/Your Service Provider approval isn't active yet/);
    // The guard must come BEFORE the write, not just wrap its error.
    const guardIndex = fn.indexOf('if (!capRow?.is_service_provider)');
    const writeIndex = fn.indexOf('saveAndPublishServiceProvider(currentUser.id, input)');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(writeIndex);
  });

  it('the write itself is unchanged -- still sends the callers own auth id, no new bypass or broadened path introduced', () => {
    expect(setupScreenSrc).toMatch(/saveAndPublishServiceProvider\(currentUser\.id, input\)/);
  });
});
