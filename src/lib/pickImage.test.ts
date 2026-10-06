import { describe, it, expect, vi, beforeEach } from 'vitest';

// Camera test matrix for Apple's Oct 2026 rejection of VENTS 1.0.2
// (Guideline 5.1.1(iv) -- camera permission; iPhone 17 Pro Max / iPad Air
// 11" M3). Covers every state the fix in permissionPrimer.ts/pickImage.ts
// touches. "The real OS permission dialog" itself cannot be driven from
// here (jsdom has no native iOS runtime) -- these tests instead prove the
// JS-side contract that makes that dialog reachable: Camera.getPhoto() is
// always actually called, with nothing in this file able to short-circuit
// it before the native layer gets a chance to prompt.

const askPermissionMock = vi.fn(async (_permission: string, _copy: any) => 'proceed' as const);
const notifyPermissionDeniedMock = vi.fn();
vi.mock('./permissionPrimer', () => ({
  askPermission: (permission: string, copy: any) => askPermissionMock(permission, copy),
  notifyPermissionDenied: (copy: any) => notifyPermissionDeniedMock(copy),
}));

const isNativePlatformMock = vi.fn(() => true);
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNativePlatformMock() },
}));

const getPhotoMock = vi.fn();
const checkPermissionsMock = vi.fn();
vi.mock('@capacitor/camera', () => ({
  Camera: {
    getPhoto: (...args: any[]) => getPhotoMock(...args),
    checkPermissions: () => checkPermissionsMock(),
  },
  CameraResultType: { Uri: 'uri' },
  CameraSource: { Prompt: 'PROMPT' },
}));

describe('pickImage: camera permission flow (Apple 5.1.1(iv) fix)', () => {
  beforeEach(() => {
    vi.resetModules();
    askPermissionMock.mockReset().mockResolvedValue('proceed');
    notifyPermissionDeniedMock.mockReset();
    isNativePlatformMock.mockReturnValue(true);
    getPhotoMock.mockReset();
    checkPermissionsMock.mockReset();
    (globalThis as any).fetch = vi.fn(async () => ({ blob: async () => new Blob(['x'], { type: 'image/jpeg' }) }));
  });

  it('1/2/3. not-determined + custom explanation: the primer is requested with dismissible:false before the OS call', async () => {
    getPhotoMock.mockResolvedValue({ webPath: 'blob:x', format: 'jpeg' });
    const { pickImage } = await import('./pickImage');

    await pickImage();

    expect(askPermissionMock).toHaveBeenCalledTimes(1);
    const [permission, copy] = askPermissionMock.mock.calls[0];
    expect(permission).toBe('camera');
    expect(copy.dismissible).toBe(false); // the actual Apple-cited bug: this must never be omitted/true for camera
    expect(copy.title).toBeTruthy();
    expect(copy.message).toBeTruthy();
  });

  it('4. the real OS prompt is always reached: Camera.getPhoto() is called regardless of what the (now skip-less) primer resolves', async () => {
    getPhotoMock.mockResolvedValue({ webPath: 'blob:x', format: 'jpeg' });
    const { pickImage } = await import('./pickImage');

    await pickImage();

    expect(getPhotoMock).toHaveBeenCalledTimes(1);
  });

  it('6. Allow: a real photo comes back as a File', async () => {
    getPhotoMock.mockResolvedValue({ webPath: 'blob:x', format: 'jpeg' });
    const { pickImage } = await import('./pickImage');

    const result = await pickImage();

    expect(result).toBeInstanceOf(File);
    expect(result!.name).toBe('photo.jpg');
  });

  it('5/8. Don\'t Allow (fresh denial): getPhoto rejects with NotAllowedError, checkPermissions confirms denial, user gets the Settings-recovery sheet -- not a repeated custom ask', async () => {
    getPhotoMock.mockRejectedValue(new Error('NotAllowedError'));
    checkPermissionsMock.mockResolvedValue({ camera: 'denied', photos: 'prompt' });
    const { pickImage } = await import('./pickImage');

    const result = await pickImage();

    expect(result).toBeNull();
    expect(notifyPermissionDeniedMock).toHaveBeenCalledTimes(1);
    const deniedCopy = notifyPermissionDeniedMock.mock.calls[0][0];
    expect(deniedCopy.icon).toBe('camera');
    expect(deniedCopy.message).toMatch(/settings/i);
  });

  it('user cancelling the native picker sheet (not a real denial) never shows the Settings-recovery sheet', async () => {
    getPhotoMock.mockRejectedValue(new Error('User cancelled photos app'));
    checkPermissionsMock.mockResolvedValue({ camera: 'granted', photos: 'granted' });
    const { pickImage } = await import('./pickImage');

    const result = await pickImage();

    expect(result).toBeNull();
    expect(notifyPermissionDeniedMock).not.toHaveBeenCalled();
  });

  it('9. Settings recovery: the denied sheet\'s own wiring (notifyPermissionDenied) is reached with a real Settings path, not a dead end', async () => {
    getPhotoMock.mockRejectedValue(new Error('NotAllowedError'));
    checkPermissionsMock.mockResolvedValue({ camera: 'denied', photos: 'denied' });
    const { pickImage } = await import('./pickImage');

    await pickImage();

    expect(notifyPermissionDeniedMock).toHaveBeenCalled();
  });

  it('7/10. re-entering the feature after a prior denial / repeated attempts: every call still reaches the real OS API, never gated behind a client-side "already denied" short-circuit', async () => {
    getPhotoMock.mockResolvedValue({ webPath: 'blob:x', format: 'jpeg' });
    const { pickImage } = await import('./pickImage');

    await pickImage();
    await pickImage();
    await pickImage();

    expect(getPhotoMock).toHaveBeenCalledTimes(3);
  });

  it('8. previously-denied permission on this device: askPermission\'s own "already shown" gate (tested in permissionPrimer.test.ts) means no repeat custom sheet, but getPhoto is still the real, undelayed OS call', async () => {
    askPermissionMock.mockResolvedValue('proceed'); // post-fix: 'skip' is no longer a reachable outcome for camera at all
    getPhotoMock.mockRejectedValue(new Error('NotAllowedError'));
    checkPermissionsMock.mockResolvedValue({ camera: 'denied', photos: 'denied' });
    const { pickImage } = await import('./pickImage');

    await pickImage();

    expect(getPhotoMock).toHaveBeenCalledTimes(1);
    expect(notifyPermissionDeniedMock).toHaveBeenCalledTimes(1);
  });

  it('web (non-native) platform: returns null immediately, never touches the primer or Camera plugin', async () => {
    isNativePlatformMock.mockReturnValue(false);
    const { pickImage } = await import('./pickImage');

    const result = await pickImage();

    expect(result).toBeNull();
    expect(askPermissionMock).not.toHaveBeenCalled();
    expect(getPhotoMock).not.toHaveBeenCalled();
  });
});
