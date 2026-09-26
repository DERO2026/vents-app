import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression tests for audit item #5: push-registration/token-persistence
// failures used to be console.warn-only, with nothing reported to Sentry --
// unlike every other caught error in the push-notification flow
// (NotificationsScreen.tsx), so a real regression (e.g. an RLS/signature
// change breaking register_push_token) could leave every user's push
// silently broken with zero telemetry to catch it. These prove the two
// failure paths now report to Sentry, without changing anything about the
// successful path or surfacing new UI to the user.

const rpcMock = vi.fn();
vi.mock('./supabase', () => ({
  supabase: { rpc: (...args: any[]) => rpcMock(...args) },
}));

const captureExceptionMock = vi.fn();
vi.mock('./sentry', () => ({
  Sentry: { captureException: (...args: any[]) => captureExceptionMock(...args) },
}));

vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./permissionPrimer', () => ({
  askPermission: vi.fn(async () => 'proceed'),
  notifyPermissionDenied: vi.fn(),
}));

const isNativePlatformMock = vi.fn(() => true);
const getPlatformMock = vi.fn(() => 'android');
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatformMock(),
    getPlatform: () => getPlatformMock(),
  },
}));

const checkPermissionsMock = vi.fn(async () => ({ receive: 'granted' }));
const getTokenMock = vi.fn(async () => ({ token: 'fcm-test-token' }));
const addListenerMock = vi.fn();
vi.mock('@capacitor-firebase/messaging', () => ({
  FirebaseMessaging: {
    checkPermissions: () => checkPermissionsMock(),
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    getToken: () => getTokenMock(),
    addListener: (...args: any[]) => addListenerMock(...args),
    removeAllListeners: vi.fn(),
    deleteToken: vi.fn(),
  },
}));

describe('pushNotifications: failures are reported to Sentry', () => {
  beforeEach(() => {
    vi.resetModules();
    rpcMock.mockReset();
    captureExceptionMock.mockReset();
    checkPermissionsMock.mockClear();
    getTokenMock.mockClear();
    isNativePlatformMock.mockReturnValue(true);
  });

  it('reports to Sentry when register_push_token RPC returns an error (but still only console.warns, no thrown error)', async () => {
    const rpcError = { message: 'permission denied for function register_push_token' };
    rpcMock.mockResolvedValue({ error: rpcError });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { registerPushNotifications } = await import('./pushNotifications');
    await expect(registerPushNotifications('user-1')).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledWith(rpcError);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('reports to Sentry when persisting the token throws', async () => {
    const thrown = new Error('network error');
    rpcMock.mockRejectedValue(thrown);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { registerPushNotifications } = await import('./pushNotifications');
    await expect(registerPushNotifications('user-2')).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledWith(thrown);
    warnSpy.mockRestore();
  });

  it('does NOT report to Sentry on a successful registration', async () => {
    rpcMock.mockResolvedValue({ error: null });

    const { registerPushNotifications } = await import('./pushNotifications');
    await registerPushNotifications('user-3');

    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith('register_push_token', expect.objectContaining({ p_user_id: 'user-3', p_token: 'fcm-test-token' }));
  });

  it('reports to Sentry when the outer setup (e.g. getToken()) throws, without surfacing it to the user', async () => {
    getTokenMock.mockRejectedValueOnce(new Error('FCM getToken failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { registerPushNotifications } = await import('./pushNotifications');
    await expect(registerPushNotifications('user-4')).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((captureExceptionMock.mock.calls[0][0] as Error).message).toBe('FCM getToken failed');
    warnSpy.mockRestore();
  });

  it('is a no-op on web (not native) -- no Sentry noise, no RPC call, unrelated to this fix', async () => {
    isNativePlatformMock.mockReturnValue(false);
    const { registerPushNotifications } = await import('./pushNotifications');
    await registerPushNotifications('user-5');

    expect(rpcMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
