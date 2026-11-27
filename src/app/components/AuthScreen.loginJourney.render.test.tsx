import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AuthScreen } from './AuthScreen';

// P0 2026-11-27 regression: the real login screen, end to end, against a
// mocked Supabase that answers exactly as production does. Production lacks
// migration 0227, so resolve_login_email answers 404 (PGRST202); before the
// fix every username login showed "We couldn't verify your login right now".

const signInWithPasswordMock = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { signInWithPassword: (...a: any[]) => signInWithPasswordMock(...a), signOut: vi.fn() },
    from: (...a: any[]) => fromMock(...a),
    rpc: (...a: any[]) => rpcMock(...a),
  },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { loggedIn: vi.fn(), loggedOut: vi.fn() } }));

const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.resolve_login_email(p_password, p_username) in the schema cache' }, status: 404 };
const PROFILE = { status: 'active', banned_until: null, full_name: 'Ada', username: 'ada', role: 'user', is_organizer: false };
const usersChain = (profile: any) => { const o: any = { select: () => o, eq: () => o, maybeSingle: () => Promise.resolve({ data: profile, error: null }) }; return o; };

let container: HTMLDivElement | null = null;
let root: Root | null = null;
beforeEach(() => {
  signInWithPasswordMock.mockReset(); fromMock.mockReset(); rpcMock.mockReset();
  fromMock.mockImplementation((t: string) => { if (t === 'users') return usersChain(PROFILE); throw new Error(`unexpected from(${t})`); });
  localStorage.clear();
});
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); container = null; root = null; });

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function login(identifier: string, password: string) {
  const onSuccess = vi.fn();
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<AuthScreen initialMode="login" onBack={() => {}} onSuccess={onSuccess} silentSignOut={vi.fn()} />); await Promise.resolve(); });
  const idInput = container.querySelector('input[type="text"], input[type="email"]') as HTMLInputElement;
  const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => { setInputValue(idInput, identifier); setInputValue(pwInput, password); await Promise.resolve(); });
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Log in') as HTMLButtonElement;
  await act(async () => { button.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { onSuccess, text: () => container!.textContent || '' };
}
const rpcAnswers = (answers: Record<string, any>) => rpcMock.mockImplementation(async (fn: string) => answers[fn] ?? { data: null, error: null, status: 204 });
const rpcNames = () => rpcMock.mock.calls.map(([fn]) => fn);

describe('login journey (production shape: 0227 not deployed)', () => {
  it('email login: signs in with the email, never touches the username lookups, succeeds', async () => {
    rpcAnswers({});
    signInWithPasswordMock.mockResolvedValue({ data: { user: { id: 'u1', email: 'ada@example.com' } }, error: null });
    const { onSuccess } = await login('ada@example.com', 'right-password');
    expect(signInWithPasswordMock).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'right-password' });
    expect(rpcNames()).not.toContain('resolve_login_email');
    expect(rpcNames()).not.toContain('resolve_username_to_email');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('THE BUG: username login with 0227 missing now resolves through the old lookup and succeeds', async () => {
    rpcAnswers({ resolve_login_email: MISSING, resolve_username_to_email: { data: 'ada@example.com', error: null, status: 200 } });
    signInWithPasswordMock.mockResolvedValue({ data: { user: { id: 'u1', email: 'ada@example.com' } }, error: null });
    const { onSuccess, text } = await login('Ada', 'right-password');
    expect(signInWithPasswordMock).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'right-password' });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(text()).not.toMatch(/couldn.t verify your login/i);
  });

  it('username login with 0227 deployed: one lookup with the password, then sign-in', async () => {
    rpcAnswers({ resolve_login_email: { data: 'ada@example.com', error: null, status: 200 } });
    signInWithPasswordMock.mockResolvedValue({ data: { user: { id: 'u1', email: 'ada@example.com' } }, error: null });
    const { onSuccess } = await login('ada', 'right-password');
    expect(rpcNames()).not.toContain('resolve_username_to_email');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('wrong password (email): the generic "Incorrect email or password."', async () => {
    rpcAnswers({ get_login_account_status: MISSING, get_account_status: { data: [{ status: 'active', banned_until: null }], error: null, status: 200 } });
    signInWithPasswordMock.mockResolvedValue({ data: null, error: { name: 'AuthApiError', message: 'Invalid login credentials', status: 400 } });
    const { onSuccess, text } = await login('ada@example.com', 'wrong');
    expect(text()).toContain('Incorrect email or password.');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('unknown username: the same generic message (no "account not found")', async () => {
    rpcAnswers({ resolve_login_email: MISSING, resolve_username_to_email: { data: null, error: null, status: 200 }, get_login_account_status: MISSING });
    const { text } = await login('nobody', 'whatever');
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
    expect(text()).toContain('Incorrect email or password.');
    expect(text()).not.toMatch(/no account|not found/i);
  });

  it('suspended account with a wrong-password attempt still sees the suspension (pre-0227 status check)', async () => {
    rpcAnswers({ get_login_account_status: MISSING, get_account_status: { data: [{ status: 'suspended', banned_until: null }], error: null, status: 200 } });
    signInWithPasswordMock.mockResolvedValue({ data: null, error: { name: 'AuthApiError', message: 'Invalid login credentials', status: 400 } });
    const { text } = await login('ada@example.com', 'wrong');
    expect(text()).toContain('Account Suspended');
  });

  it('lookup service failing (500, not "missing"): an honest "temporarily unavailable, use your email" message', async () => {
    rpcAnswers({ resolve_login_email: { data: null, error: { code: 'XX000', message: 'internal error' }, status: 500 } });
    const { text } = await login('ada', 'right-password');
    expect(text()).toContain(LOGIN_UNAVAILABLE);
    expect(text()).not.toContain('Incorrect email or password.');
    expect(rpcNames()).not.toContain('resolve_username_to_email');
  });

  it('network failure during the lookup: a connection message, never "wrong password"', async () => {
    rpcAnswers({ resolve_login_email: { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 } });
    const { text } = await login('ada', 'right-password');
    expect(text()).toContain("We couldn't reach the server. Please check your connection and try again.");
  });

  it('auth service down during sign-in (email): a connection/server message, never "wrong password"', async () => {
    rpcAnswers({});
    signInWithPasswordMock.mockResolvedValue({ data: null, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } });
    const { text } = await login('ada@example.com', 'right-password');
    expect(text()).toContain("We couldn't reach the server");
    expect(text()).not.toContain('Incorrect email or password.');
  });
});

const LOGIN_UNAVAILABLE = 'Logging in with a username is temporarily unavailable. Please try again shortly, or log in with your email address.';
