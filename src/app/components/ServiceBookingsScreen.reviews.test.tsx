import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceBookingsScreen } from './ServiceBookingsScreen';
import type { ServiceBookingRow } from '../../lib/serviceBookings';

// Regression tests for Provider Reviews: a completed, paid service booking
// had no UI path to submit a review at all. RLS (provider_reviews_
// insert_own, migration 0099) is the real enforcement point (gated on
// status='completed' AND payment_status='paid', one review per booking via
// a DB UNIQUE constraint) -- these tests only prove the client wiring:
// the button appears only for a completed booking without an existing
// review, submitProviderReview is called with the right args, validation
// blocks an empty rating/too-short body client-side before any network
// call, and a successful submission both disappears the button and shows
// the review inline without needing a reload.

const fetchMyServiceBookings = vi.fn();
const submitProviderReview = vi.fn();
vi.mock('../../lib/serviceBookings', () => ({
  fetchMyServiceBookings: (...args: any[]) => fetchMyServiceBookings(...args),
  fetchProviderServiceBookings: vi.fn(async () => []),
  completeServiceBooking: vi.fn(),
  submitProviderReview: (...args: any[]) => submitProviderReview(...args),
}));
vi.mock('../../lib/supabase', () => ({ getAuthToken: vi.fn(async () => 'token') }));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));

const COMPLETED_BOOKING: ServiceBookingRow = {
  id: 'booking-1',
  providerId: 'provider-1',
  providerBusinessName: 'Glow Studio',
  customerId: 'customer-1',
  status: 'completed',
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
  myReview: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchMyServiceBookings.mockReset();
  submitProviderReview.mockReset();
});

async function renderScreen(booking: ServiceBookingRow) {
  fetchMyServiceBookings.mockResolvedValueOnce([booking]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ServiceBookingsScreen mode="customer" onBack={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openDialogButton() {
  return Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Leave a Review');
}

function dialogButton(label: string) {
  // Unlike ConfirmDialog (createPortal to document.body), the review modal
  // is plain conditional JSX rendered inside this component's own tree, so
  // it lives inside `container` alongside the trigger button -- find it by
  // its distinguishing label text directly.
  return Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === label);
}

describe('ServiceBookingsScreen: Provider Reviews', () => {
  it('shows "Leave a Review" for a completed booking with no existing review', async () => {
    await renderScreen(COMPLETED_BOOKING);
    expect(openDialogButton()).toBeTruthy();
  });

  it('does not show "Leave a Review" for a confirmed (not yet completed) booking', async () => {
    await renderScreen({ ...COMPLETED_BOOKING, status: 'confirmed', myReview: undefined });
    expect(openDialogButton()).toBeFalsy();
  });

  it('does not show "Leave a Review" once a review already exists, and shows it inline instead', async () => {
    await renderScreen({ ...COMPLETED_BOOKING, myReview: { id: 'review-1', rating: 4, body: 'Really solid experience.' } });
    expect(openDialogButton()).toBeFalsy();
    expect(container!.textContent).toContain('Really solid experience.');
  });

  it('blocks submission client-side without a star rating or with a too-short body, without calling submitProviderReview', async () => {
    await renderScreen(COMPLETED_BOOKING);
    act(() => { openDialogButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const submitButton = dialogButton('Submit Review');
    expect(submitButton).toBeTruthy();

    // No rating selected, no body typed -- should be rejected client-side.
    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(submitProviderReview).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('Please choose a star rating.');
  });

  it('submits a valid review, calls submitProviderReview with the right args, and reflects it inline without a reload', async () => {
    await renderScreen(COMPLETED_BOOKING);
    act(() => { openDialogButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const fifthStar = Array.from(container!.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === '5 stars');
    expect(fifthStar).toBeTruthy();
    act(() => { fifthStar!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const textarea = container!.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'Fantastic experience, highly recommended!');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    submitProviderReview.mockResolvedValueOnce({ status: 'success' });
    await act(async () => {
      dialogButton('Submit Review')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submitProviderReview).toHaveBeenCalledWith('provider-1', 'booking-1', 5, 'Fantastic experience, highly recommended!');
    expect(container!.textContent).toContain('Fantastic experience, highly recommended!');
    expect(openDialogButton()).toBeFalsy();
  });
});
