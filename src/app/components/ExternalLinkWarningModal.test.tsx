import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { useExternalLinkWarning } from './ExternalLinkWarningModal';

const openExternalUrlMock = vi.fn();
vi.mock('../../lib/externalLink', () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));

function Harness({ url }: { url: string }) {
  const { requestOpen, modal } = useExternalLinkWarning();
  return (
    <div>
      <button onClick={() => requestOpen(url)}>open</button>
      {modal}
    </div>
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  openExternalUrlMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

function clickText(text: string) {
  const el = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!el) throw new Error(`"${text}" button not found`);
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('ExternalLinkWarningModal (third-party link disclaimer)', () => {
  it('shows the VENTS-branded warning before leaving, with the exact required copy', () => {
    act(() => { root!.render(<Harness url="https://discord.gg/abc123" />); });
    clickText('open');

    expect(container!.textContent).toContain("You're leaving VENTS");
    expect(container!.textContent).toContain("isn't operated or controlled by VENTS");
    expect(container!.textContent).toContain("VENTS isn't responsible for the content, security, availability, or actions");
    expect(container!.textContent).toContain('Cancel');
    expect(container!.textContent).toContain('Continue');
    // Showing the warning must never itself open the external URL.
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });

  it('Cancel dismisses the warning without opening the external URL', () => {
    act(() => { root!.render(<Harness url="https://discord.gg/abc123" />); });
    clickText('open');
    clickText('Cancel');

    expect(openExternalUrlMock).not.toHaveBeenCalled();
    expect(container!.textContent).not.toContain("You're leaving VENTS");
  });

  it('Continue opens the external URL and dismisses the warning', () => {
    act(() => { root!.render(<Harness url="https://discord.gg/abc123" />); });
    clickText('open');
    clickText('Continue');

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://discord.gg/abc123');
    expect(container!.textContent).not.toContain("You're leaving VENTS");
  });
});
