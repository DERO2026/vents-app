import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceBookingsScreen } from './ServiceBookingsScreen';
import type { ServiceBookingRow } from '../../lib/serviceBookings';

// 0203: the customer can report a problem with a completed booking for 48
// hours (from the later of completion and the scheduled start). The button
// only appears inside that window; the database re-checks everything.

const fetchMyServiceBookings = vi.fn();
const disputeServiceBooking = vi.fn();
vi.mock('../../lib/serviceBookings', () => ({
  fetchMyServiceBookings: (...a: any[]) => fetchMyServiceBookings(...a),
  fetchProviderServiceBookings: vi.fn(async () => []),
  completeServiceBooking: vi.fn(),
  submitProviderReview: vi.fn(),
  disputeServiceBooking: (...a: any[]) => disputeServiceBooking(...a),
}));
vi.mock('../../lib/supabase', () => ({ getAuthToken: vi.fn(async () => 'token') }));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const BOOKING: ServiceBookingRow = {
  id: 'b-1', providerId: 'p-1', providerBusinessName: 'Glam', customerId: 'c-1', status: 'completed', paymentStatus: 'paid',
  scheduledDate: null, scheduledTime: null, location: null, customerNotes: null, currency: 'NGN',
  subtotal: 1000, fee: 50, total: 1050, createdAt: '2026-01-01T00:00:00Z', items: [], myReview: null,
  completedAt: hoursAgo(2), serviceStartFloorAt: hoursAgo(3),
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove(); container = null; root = null;
  fetchMyServiceBookings.mockReset(); disputeServiceBooking.mockReset(); vi.restoreAllMocks();
});

async function render(b: ServiceBookingRow) {
  fetchMyServiceBookings.mockResolvedValueOnce([b]);
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ServiceBookingsScreen mode="customer" onBack={() => {}} />); await Promise.resolve(); await Promise.resolve(); });
}
const disputeButton = () => container!.querySelector('[data-testid="booking-dispute"]') as HTMLButtonElement | null;

describe('ServiceBookingsScreen: customer dispute window', () => {
  it('inside the 48 hours: the customer can report a problem, which calls dispute_service_booking', async () => {
    await render(BOOKING);
    expect(disputeButton()).toBeTruthy();
    vi.spyOn(window, 'prompt').mockReturnValue('Provider never arrived');
    disputeServiceBooking.mockResolvedValueOnce({ status: 'open' });
    await act(async () => { disputeButton()!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(disputeServiceBooking).toHaveBeenCalledWith('b-1', 'Provider never arrived');
    expect(container!.querySelector('[data-testid="booking-dispute-notice"]')?.textContent).toMatch(/paused the provider's payment/);
  });

  it('after the 48 hours there is no dispute action', async () => {
    await render({ ...BOOKING, completedAt: hoursAgo(49), serviceStartFloorAt: hoursAgo(50) });
    expect(disputeButton()).toBeNull();
  });

  it('a too-short description is not sent', async () => {
    await render(BOOKING);
    vi.spyOn(window, 'prompt').mockReturnValue('bad');
    await act(async () => { disputeButton()!.click(); await Promise.resolve(); });
    expect(disputeServiceBooking).not.toHaveBeenCalled();
  });

  it('a refusal from the database is shown, not swallowed', async () => {
    await render(BOOKING);
    vi.spyOn(window, 'prompt').mockReturnValue('Provider never arrived');
    disputeServiceBooking.mockRejectedValueOnce(new Error('The dispute window for this booking has closed'));
    await act(async () => { disputeButton()!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(container!.textContent).toContain('The dispute window for this booking has closed');
  });
});
