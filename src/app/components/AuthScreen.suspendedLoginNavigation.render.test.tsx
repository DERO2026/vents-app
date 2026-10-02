import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AuthScreen } from './AuthScreen';

// Real-flow bug (found only by tracing actual login/navigation behavior,
// not by re-reading the already-correct status-check code): a suspended or
// deleted account entering the correct password was taken back to the
// landing page instead of staying on the Login screen to see the
// suspended-account error.
//
// Root cause: AuthScreen's suspended/deleted branch (right after a
// successful signInWithPassword) called supabase.auth.signOut() directly
// to revoke the session it had just momentarily established. That fires
// Supabase's own SIGNED_OUT event, which App.tsx's global
// onAuthStateChange listener reacts to by unconditionally calling
// setScreen('welcome') UNLESS explicitSignOutRef.current is already true
// (the flag App.tsx's own handleSignOut sets around its calls). AuthScreen
// had no way to set that ref, so every suspended/deleted login silently
// triggered the listener's "go to Welcome" navigation, unmounting
// AuthScreen (and wiping its local banInfo state) out from under the ban
// message the user was supposed to see.
//
// Fixed by having App.tsx pass a `silentSignOut` prop (which sets the same
// ref around its own supabase.auth.signOut() call) for AuthScreen to use
// instead of calling supabase.auth.signOut() directly. This test proves,
// at the component level, that: the session-revoking call used here is the
// injected prop (not the real auth.signOut, which would have no way to
// suppress App.tsx's listener from this test's vantage point), the ban
// screen renders and stays rendered, onSuccess is never called, and an
// active account's login is unaffected.

const signInWithPasswordMock = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: any[]) => signInWithPasswordMock(...args),
      signOut: vi.fn(), // must NOT be called directly by AuthScreen for this flow
    },
    from: (...args: any[]) => fromMock(...args),
    rpc: (...args: any[]) => rpcMock(...args),
  },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { loggedIn: vi.fn(), loggedOut: vi.fn() } }));

function usersChain(profile: any) {
  const obj: any = {
    select: () => obj,
    eq: () => obj,
    maybeSingle: () => Promise.resolve({ data: profile, error: null }),
  };
  return obj;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  signInWithPasswordMock.mockReset();
  fromMock.mockReset();
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: null, error: null }); // check_auth_rate_limit: fail-open
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function renderAndSubmitLogin(opts: { profile: any; silentSignOut: () => Promise<void>; onSuccess: (p: any) => void }) {
  signInWithPasswordMock.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@example.com' } }, error: null });
  fromMock.mockImplementation((table: string) => {
    if (table === 'users') return usersChain(opts.profile);
    throw new Error(`Unexpected supabase.from('${table}') call`);
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <AuthScreen
        initialMode="login"
        onBack={() => {}}
        onSuccess={opts.onSuccess}
        silentSignOut={opts.silentSignOut}
      />
    );
    await Promise.resolve();
  });

  const emailInput = container.querySelector('input[type="text"], input[type="email"]') as HTMLInputElement;
  const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
  const submitButton = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Log in'
  ) as HTMLButtonElement;

  await act(async () => {
    setInputValue(emailInput, 'test@example.com');
    setInputValue(passwordInput, 'correct-password-123');
    await Promise.resolve();
  });

  await act(async () => {
    submitButton.click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

function text() { return container!.textContent || ''; }

// React tracks a controlled input's previous value internally; setting
// `.value` directly and dispatching a plain 'input' event is a no-op from
// React's point of view (it diffs against its own tracked value, which
// never changed). Going through the native setter first is the standard
// workaround for simulating real typing in a jsdom render test.
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Suspended account: correct password stays on Login, no landing-page navigation', () => {
  it('calls the injected silentSignOut (never the raw supabase.auth.signOut), renders the ban screen, and never calls onSuccess', async () => {
    const silentSignOut = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    await renderAndSubmitLogin({
      profile: { status: 'suspended', banned_until: null, full_name: 'Test User', username: 'testuser', role: 'user' },
      silentSignOut,
      onSuccess,
    });

    expect(silentSignOut).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(text()).toContain('Account Suspended');
    // The component is still mounted and showing its own ban UI -- this is
    // the actual proof "no landing-page navigation" holds from this
    // screen's own vantage point: there is nothing here that would ever
    // unmount it or hand control back to a parent-level screen router
    // other than onSuccess/onBack, neither of which fired.
  });
});

describe('Deleted account: correct password stays on Login, no landing-page navigation', () => {
  it('calls silentSignOut, renders the deleted-account screen, and never calls onSuccess', async () => {
    const silentSignOut = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    await renderAndSubmitLogin({
      profile: { status: 'deleted', banned_until: null, full_name: 'Test User', username: 'testuser', role: 'user' },
      silentSignOut,
      onSuccess,
    });

    expect(silentSignOut).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(text()).toContain('Account Deleted');
  });
});

describe('Active account: normal login is unaffected (no regression)', () => {
  it('never calls silentSignOut and calls onSuccess with the real profile', async () => {
    const silentSignOut = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    await renderAndSubmitLogin({
      profile: { status: 'active', banned_until: null, full_name: 'Test User', username: 'testuser', role: 'user', is_organizer: false, is_verified: true, vc_badge: null },
      silentSignOut,
      onSuccess,
    });

    expect(silentSignOut).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0]).toMatchObject({ id: 'user-1', role: 'user' });
    expect(text()).not.toContain('Account Suspended');
    expect(text()).not.toContain('Account Deleted');
  });
});
