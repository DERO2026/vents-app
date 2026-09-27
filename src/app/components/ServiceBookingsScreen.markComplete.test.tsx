import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceBookingsScreen } from './ServiceBookingsScreen';
import type { ServiceBookingRow } from '../../lib/serviceBookings';

// Regression test for the confirmed product-audit finding: service_bookings
// has a real 'completed' status but nothing anywhere ever transitioned a
// booking into it -- no provider "Mark Complete" action existed at all.
// This proves the new action is wired end to end.

const fetchProviderServiceBookings = vi.fn();
const completeServiceBooking = vi.fn();
vi.mock('../../lib/serviceBookings', () => ({
  fetchMyServiceBookings: vi.fn(async () => []),
  fetchProviderServiceBookings: (...args: any[]) => fetchProviderServiceBookings(...args),
  completeServiceBooking: (...args: any[]) => completeServiceBooking(...args),
}));
vi.mock('../../lib/supabase', () => ({ getAuthToken: vi.fn(async () => 'token') }));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));

const CONFIRMED_BOOKING: ServiceBookingRow = {
  id: 'booking-1',
  providerId: 'provider-1',
  customerId: 'customer-1',
  customerName: 'Jane Doe',
  status: 'confirmed',
  paymentStatus: 'paid',
  scheduledDate: null,
  scheduledTime: null,
  location: null,
  customerNotes: null,
  currency: 'NGN',
  subtotal: 50000,
  fee: 2500,
  total: 52500,
  createdAt: '2026-01-01T00:00:00Z',
  items: [],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchProviderServiceBookings.mockReset();
  completeServiceBooking.mockReset();
});

async function renderScreen() {
  fetchProviderServiceBookings.mockResolvedValueOnce([CONFIRMED_BOOKING]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ServiceBookingsScreen mode="provider" providerId="provider-1" onBack={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ServiceBookingsScreen: Mark Complete', () => {
  it('shows a "Mark Complete" action for a confirmed+paid booking, and confirming it calls completeServiceBooking and updates the badge', async () => {
    await renderScreen();

    const markCompleteButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Mark Complete');
    expect(markCompleteButton).toBeTruthy();

    act(() => { markCompleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // ConfirmDialog is rendered via a portal directly to document.body,
    // outside `container` -- filter those out to reach the dialog's own
    // "Mark Complete" confirm button, not the card's trigger button.
    const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Mark Complete' && !container!.contains(b)
    );
    expect(confirmButton).toBeTruthy();

    completeServiceBooking.mockResolvedValueOnce({ status: 'completed' });
    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(completeServiceBooking).toHaveBeenCalledWith('booking-1');
    expect(container!.textContent).toContain('COMPLETED');
    expect(Array.from(container!.querySelectorAll('button')).some((b) => b.textContent === 'Mark Complete')).toBe(false);
  });

  it('does not show "Mark Complete" for a booking that is not confirmed+paid', async () => {
    fetchProviderServiceBookings.mockResolvedValueOnce([{ ...CONFIRMED_BOOKING, status: 'pending_payment', paymentStatus: 'pending' }]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ServiceBookingsScreen mode="provider" providerId="provider-1" onBack={() => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(Array.from(container!.querySelectorAll('button')).some((b) => b.textContent === 'Mark Complete')).toBe(false);
  });
});
