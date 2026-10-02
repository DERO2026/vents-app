import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real-flow bug, found only by tracing actual login/navigation behavior:
// a suspended/deleted account entering the correct password was taken
// back to the landing page instead of staying on the Login screen to see
// the ban message. The previous d6a563b fix proved the status-check DATA
// LAYER works; this fix addresses the actual NAVIGATION bug the data-layer
// proof couldn't have caught.
//
// Root cause: AuthScreen's suspended/deleted branch called
// supabase.auth.signOut() directly right after a successful
// signInWithPassword. That fires Supabase's own SIGNED_OUT event, which
// App.tsx's global onAuthStateChange listener reacts to by unconditionally
// calling setScreen('welcome') UNLESS explicitSignOutRef.current is
// already true -- the exact flag App.tsx's own handleSignOut sets around
// its calls for this reason, which AuthScreen (a separate component) had
// no way to set. Behavioral proof that AuthScreen now stays on the Login
// screen and never navigates away lives in
// AuthScreen.suspendedLoginNavigation.render.test.tsx; this file verifies
// the underlying wiring in App.tsx that makes that possible.

let appSrc: string;

beforeAll(() => {
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
});

describe('App.tsx: silentSignOut suppresses the global SIGNED_OUT auto-navigation', () => {
  it('sets explicitSignOutRef around its own supabase.auth.signOut() call, the same ref the SIGNED_OUT listener checks', () => {
    const fn = appSrc.match(/const silentSignOut = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[\]\);/)?.[0] ?? '';
    expect(fn).toMatch(/explicitSignOutRef\.current = true;/);
    expect(fn).toMatch(/await supabase\.auth\.signOut\(\);/);
    expect(fn).toMatch(/explicitSignOutRef\.current = false;/);
  });

  it('does not itself touch currentUser/screen/screenStack -- it only revokes the session, nothing else', () => {
    const fn = appSrc.match(/const silentSignOut = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[\]\);/)?.[0] ?? '';
    expect(fn).not.toMatch(/setCurrentUser|setScreen\(|setScreenStack/);
  });

  it('is passed to AuthScreen as the silentSignOut prop', () => {
    const authScreenJsx = appSrc.match(/\{screen === 'auth' && \([\s\S]*?<AuthScreen[\s\S]*?\/>/)?.[0] ?? '';
    expect(authScreenJsx).toMatch(/silentSignOut=\{silentSignOut\}/);
  });

  it('the global SIGNED_OUT listener still checks explicitSignOutRef before navigating to welcome (unchanged, still the suppression mechanism silentSignOut relies on)', () => {
    const listener = appSrc.match(/supabase\.auth\.onAuthStateChange\(\(event\) => \{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(listener).toMatch(/if \(explicitSignOutRef\.current\) return;/);
    expect(listener).toMatch(/setScreen\('welcome'\);/);
  });
});
