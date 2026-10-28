import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AttendeeListScreen } from './AttendeeListScreen';

// White initials on the per-attendee colour must reach WCAG AA (4.5:1) on
// the actual rendered fill, while attendees keep distinct colours (the
// fill is a darker version of each name's colour, not one shared colour).

const rpcMock = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: { rpc: (...args: any[]) => rpcMock(...args) },
  getAuthToken: vi.fn(async () => 'token'),
}));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/ticketImage', () => ({ downloadBlob: vi.fn(async () => 'shared') }));

function contrast(a: string, b: string): number {
  const lum = (rgb: string) => {
    const [r, g, bl] = rgb.match(/\d+/g)!.slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  rpcMock.mockReset();
});

describe('AttendeeListScreen: initials avatar contrast', () => {
  it('renders every attendee avatar at >= 4.5:1 and keeps per-name colour variety', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `Guest ${String.fromCharCode(65 + (i % 26))}${i}`);
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: names.length, checked_in: 0 }, error: null });
      if (fn === 'get_event_attendees') {
        return Promise.resolve({
          data: names.map((n, i) => ({
            ticket_id: `ticket-${i}`, holder_name: n, holder_email: '', ticket_type: 'Regular',
            status: 'active', checked_in: false, checked_in_at: null, payment_status: 'paid',
          })),
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AttendeeListScreen onBack={() => {}} eventId="event-1" eventTitle="Test Event" />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const avatars = Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
      (el) => el.style.width === '40px' && el.style.borderRadius === '50%' && /^[A-Z0-9]{1,2}$/.test(el.textContent ?? ''),
    );
    expect(avatars.length).toBe(names.length);

    const fills = new Set<string>();
    for (const el of avatars) {
      const { backgroundColor, color } = getComputedStyle(el);
      fills.add(backgroundColor);
      expect(contrast(backgroundColor, color), `${el.textContent} on ${backgroundColor}`).toBeGreaterThanOrEqual(4.5);
    }
    // 8 per-name colours in AVATAR_COLORS; 40 names should hit most of them.
    expect(fills.size).toBeGreaterThanOrEqual(6);
  });
});
