import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AttendeeListScreen } from './AttendeeListScreen';

// Regression test for the confirmed product-audit finding: the "Export"
// button had no onClick handler at all -- it was a dead stub that did
// nothing when clicked. This proves a click now actually triggers a real
// CSV download built from the already-fetched attendee data.

const rpcMock = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: { rpc: (...args: any[]) => rpcMock(...args) },
  getAuthToken: vi.fn(async () => 'token'),
}));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const downloadBlobMock = vi.fn(async (_blob: Blob, _filename: string) => 'shared');
vi.mock('../../lib/ticketImage', () => ({
  downloadBlob: (blob: Blob, filename: string) => downloadBlobMock(blob, filename),
}));

const ATTENDEE_ROW = {
  ticket_id: 'ticket-aaaaaaaa-1111',
  holder_name: 'Jane Doe',
  holder_email: 'jane@example.com',
  ticket_type: 'VIP',
  status: 'active',
  checked_in: true,
  checked_in_at: '2026-01-01T10:00:00Z',
  payment_status: 'paid',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  rpcMock.mockReset();
  downloadBlobMock.mockClear();
});

async function renderScreen() {
  rpcMock.mockResolvedValueOnce({ data: [ATTENDEE_ROW], error: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AttendeeListScreen onBack={() => {}} eventId="event-1" eventTitle="Test Event" />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AttendeeListScreen: Export button', () => {
  it('clicking Export triggers a real CSV download containing the attendee data', async () => {
    await renderScreen();

    const exportButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Export');
    expect(exportButton).toBeTruthy();
    expect(exportButton!.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlobMock.mock.calls[0];
    expect(filename).toBe('test-event-attendees.csv');
    expect(blob.type).toBe('text/csv');
    const csvText = await blob.text();
    expect(csvText).toContain('Jane Doe');
    expect(csvText).toContain('jane@example.com');
    expect(csvText).toContain('VIP');
    expect(csvText).toContain('Checked In');
  });

  it('the Export button is disabled when there are no attendees to export', async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AttendeeListScreen onBack={() => {}} eventId="event-1" eventTitle="Test Event" />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const exportButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Export');
    expect(exportButton!.hasAttribute('disabled')).toBe(true);

    act(() => { exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });
});
