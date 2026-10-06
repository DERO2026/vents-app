import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { askPermission, registerPrimerHost } from './permissionPrimer';

// Regression tests for Apple's Oct 2026 rejection of VENTS 1.0.2
// (Guideline 5.1.1(iv)): a custom pre-permission screen must not offer a
// close/"Not now" action that lets the user avoid the real OS permission
// dialog. copy.dismissible === false (used for camera) must remove that
// escape hatch entirely; every other permission (notifications) must keep
// its existing soft-ask-with-skip behavior unchanged.

describe('askPermission: dismissible flag (Apple 5.1.1(iv) camera fix)', () => {
  let unregister: () => void;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    unregister?.();
  });

  it('dismissible:false (camera) never offers an onNotNow callback, so there is no skip path', async () => {
    let captured: any = null;
    unregister = registerPrimerHost({
      showPrimer: (req) => { captured = req; },
      showDenied: vi.fn(),
    });

    const promise = askPermission('camera', {
      icon: 'camera',
      title: 'Allow Photo Access',
      message: 'test',
      dismissible: false,
    });

    expect(captured).toBeTruthy();
    // The host is handed a null onNotNow -- it has nothing to call even if
    // it wanted to render a "Not now"/close affordance.
    expect(captured.onNotNow).toBeNull();

    captured.onContinue();
    await expect(promise).resolves.toBe('proceed');
  });

  it('dismissible left unset (notifications) keeps the existing skip path', async () => {
    let captured: any = null;
    unregister = registerPrimerHost({
      showPrimer: (req) => { captured = req; },
      showDenied: vi.fn(),
    });

    const promise = askPermission('notifications', {
      icon: 'bell',
      title: 'Stay in the Loop',
      message: 'test',
    });

    expect(typeof captured.onNotNow).toBe('function');
    captured.onNotNow();
    await expect(promise).resolves.toBe('skip');
  });

  it('a second camera request on the same device skips the primer entirely (already-shown guard), and still never exposes a skip path', async () => {
    const showPrimer = vi.fn();
    unregister = registerPrimerHost({ showPrimer, showDenied: vi.fn() });

    const firstPromise = askPermission('camera', { icon: 'camera', title: 't', message: 'm', dismissible: false });
    // First call shows the sheet; resolve it via Continue.
    const firstReq = showPrimer.mock.calls[0][0];
    firstReq.onContinue();
    await firstPromise;

    showPrimer.mockClear();
    const second = await askPermission('camera', { icon: 'camera', title: 't', message: 'm', dismissible: false });
    expect(showPrimer).not.toHaveBeenCalled();
    expect(second).toBe('proceed');
  });
});
