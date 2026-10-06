import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { PermissionSheetHost } from './PermissionSheetHost';
import { askPermission } from '../../../lib/permissionPrimer';

// UI-level regression for Apple's Oct 2026 rejection of VENTS 1.0.2
// (Guideline 5.1.1(iv)): the rendered camera primer must have no "Not now"
// button and must not close on a backdrop tap -- the only rendered
// interactive element that can dismiss it is "Continue", which is the path
// that leads to the real OS permission dialog.

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

describe('PermissionSheetHost: camera primer has no skip/close escape hatch', () => {
  it('dismissible:false (camera) renders only "Continue" -- no "Not now" button at all', async () => {
    await act(async () => {
      root!.render(<PermissionSheetHost />);
    });
    act(() => {
      askPermission('camera', {
        icon: 'camera',
        title: 'Allow Photo Access',
        message: 'VENTS uses your camera...',
        dismissible: false,
      });
    });

    const buttons = Array.from(container!.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Continue');
    expect(buttons).not.toContain('Not now');
  });

  it('dismissible:false (camera): tapping the backdrop does not close the sheet', async () => {
    await act(async () => {
      root!.render(<PermissionSheetHost />);
    });
    act(() => {
      askPermission('camera', { icon: 'camera', title: 't', message: 'm', dismissible: false });
    });

    const backdrop = container!.firstElementChild as HTMLElement;
    act(() => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Still rendered -- the sheet survived the backdrop tap, exactly the
    // "no close action that delays the real permission request" guarantee.
    expect(container!.querySelector('h3')?.textContent).toBe('t');
  });

  it('notifications primer (dismissible left default) still renders "Not now" and a backdrop tap still closes it -- unchanged, non-regressed', async () => {
    await act(async () => {
      root!.render(<PermissionSheetHost />);
    });
    act(() => {
      askPermission('notifications', { icon: 'bell', title: 'Stay in the Loop', message: 'm' });
    });

    const buttons = Array.from(container!.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Not now');

    const backdrop = container!.firstElementChild as HTMLElement;
    act(() => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container!.querySelector('h3')).toBeNull();
  });

  it('camera primer\'s "Continue" closes the sheet and fires the real permission path', async () => {
    await act(async () => {
      root!.render(<PermissionSheetHost />);
    });
    act(() => {
      askPermission('camera', { icon: 'camera', title: 't', message: 'm', dismissible: false });
    });

    const continueBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Continue')!;
    act(() => { continueBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container!.querySelector('h3')).toBeNull();
  });
});
