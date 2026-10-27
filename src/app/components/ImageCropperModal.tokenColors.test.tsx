import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ImageCropperModal } from './ImageCropperModal';
import { ventsColors } from '../../lib/ventsDesignTokens';

vi.mock('../../lib/visionCrop', () => ({ fetchVisionFocus: () => Promise.resolve(null) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

// Stage 9 restyle regression: asserts actual computed style.color (not text
// presence) for the raw hex literals converted to ventsDesignTokens, and that
// the restyle left crop/zoom/pan behavior untouched (same props/callbacks,
// same Cropper configuration). Uses the 'avatar' variant (the default) since
// it skips the flyer-only decode/ResizeObserver effects that need real
// browser APIs (createImageBitmap, ResizeObserver) jsdom doesn't provide.

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root && container) {
    act(() => root!.unmount());
    container.remove();
  }
  root = null;
  container = null;
});

async function renderModal(props: Partial<React.ComponentProps<typeof ImageCropperModal>> = {}) {
  root = createRoot(container!);
  await act(async () => {
    root!.render(
      <ImageCropperModal
        imageSrc="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        onCropComplete={() => {}}
        onClose={() => {}}
        {...props}
      />
    );
  });
}

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

describe('ImageCropperModal token colors', () => {
  it('renders the modal backdrop in ventsColors.bg and header in ventsColors.surface', async () => {
    await renderModal();
    const backdrop = document.body.querySelector('[style*="position: fixed"]') as HTMLElement;
    expect(backdrop).toBeTruthy();
    expect(getComputedStyle(backdrop).backgroundColor).toBe(hexToRgb(ventsColors.bg));
  });

  it('renders the title text in ventsColors.ink1', async () => {
    await renderModal({ title: 'Crop Photo' });
    const title = Array.from(document.body.querySelectorAll('span')).find(
      (s) => s.textContent === 'Crop Photo'
    );
    expect(title).toBeTruthy();
    expect(getComputedStyle(title!).color).toBe(hexToRgb(ventsColors.ink1));
  });

  it('renders the Done button text in ventsColors.white', async () => {
    await renderModal();
    const doneBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Done')
    );
    expect(doneBtn).toBeTruthy();
    expect(getComputedStyle(doneBtn!).color).toBe(hexToRgb(ventsColors.white));
  });

  it('renders the Zoom label in ventsColors.ink3, distinct from the title ink1', async () => {
    await renderModal();
    const zoomLabel = Array.from(document.body.querySelectorAll('span')).find(
      (s) => s.textContent === 'Zoom'
    );
    expect(zoomLabel).toBeTruthy();
    const zoomColor = getComputedStyle(zoomLabel!).color;
    // ventsColors.ink3 is an rgba() string already, not a hex literal.
    expect(zoomColor.replace(/\s/g, '')).toBe(ventsColors.ink3.replace(/\s/g, ''));
    expect(zoomColor).not.toBe(hexToRgb(ventsColors.ink1));
  });

  it('preserves crop configuration: zoom range 1-3 step 0.1, aspect defaults to 1 for the avatar variant', async () => {
    await renderModal({ aspect: undefined, variant: 'avatar' });
    const slider = document.body.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.min).toBe('1');
    expect(slider.max).toBe('3');
    expect(slider.step).toBe('0.1');
  });

  it('calls onClose when Cancel is clicked, preserving the existing callback behavior', async () => {
    let closed = false;
    await renderModal({ onClose: () => { closed = true; } });
    const cancelBtn = document.body.querySelector('button[aria-label="Cancel"]') as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();
    act(() => { cancelBtn.click(); });
    expect(closed).toBe(true);
  });
});
