import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { useCamera } from './useCamera';

// This is a second, previously-unaudited camera entry point found while
// verifying the fix for Apple's Oct 2026 rejection of VENTS 1.0.2
// (Guideline 5.1.1(iv)): the check-in scanner called getUserMedia directly
// the instant it mounted, with no pre-permission explanation at all --
// unlike pickImage.ts's photo picker, which already goes through the
// non-dismissible camera primer. These tests lock in the same contract
// here: the primer is requested (dismissible:false, so no skip path)
// before getUserMedia, and getUserMedia is still the real, reached call.

const askPermissionMock = vi.fn(async (_permission: string, _copy: any) => 'proceed' as const);
vi.mock('../../../lib/permissionPrimer', () => ({
  askPermission: (permission: string, copy: any) => askPermissionMock(permission, copy),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function TestHarness({ active }: { active: boolean }) {
  useCamera(active);
  return null;
}

function render(active: boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<TestHarness active={active} />); });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  askPermissionMock.mockReset().mockResolvedValue('proceed');
  delete (navigator as any).mediaDevices;
});

describe('useCamera: pre-permission primer (Apple 5.1.1(iv) audit finding)', () => {
  it('requests the camera primer with dismissible:false before calling getUserMedia', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [], getVideoTracks: () => [] });
    (navigator as any).mediaDevices = { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) };

    await act(async () => { render(true); await Promise.resolve(); await Promise.resolve(); });

    expect(askPermissionMock).toHaveBeenCalledTimes(1);
    const [permission, copy] = askPermissionMock.mock.calls[0];
    expect(permission).toBe('camera');
    expect(copy.dismissible).toBe(false);
    expect(copy.title).toBeTruthy();
    expect(copy.message).toBeTruthy();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('does not call getUserMedia at all while inactive', async () => {
    const getUserMedia = vi.fn();
    (navigator as any).mediaDevices = { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) };

    await act(async () => { render(false); await Promise.resolve(); });

    expect(askPermissionMock).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('a component unmounted while the (non-dismissible) primer is still pending never reaches getUserMedia', async () => {
    let resolvePrimer: (() => void) | null = null;
    askPermissionMock.mockImplementation(() => new Promise((resolve) => { resolvePrimer = () => resolve('proceed'); }));
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [], getVideoTracks: () => [] });
    (navigator as any).mediaDevices = { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) };

    render(true);
    await act(async () => { await Promise.resolve(); });
    expect(askPermissionMock).toHaveBeenCalledTimes(1);

    act(() => { root!.unmount(); root = null; });
    resolvePrimer!();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
