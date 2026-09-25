// Data-layer helpers for the Services marketplace booking/payment flow
// (supabase/migrations/0054_service_bookings_marketplace.sql). Mirrors the
// existing ticket-purchase pattern (CheckoutScreen.tsx/App.tsx): the server
// computes and persists the order (create_service_booking) BEFORE Paystack
// ever opens, then a separate server-side verify call (never the client's
// own Paystack callback) is the only thing that ever marks a booking paid.

import { supabase, getAuthToken } from './supabase';
import { apiUrl } from './apiBase';

export interface ServiceBookingItemInput {
  serviceId: string;
  quantity: number;
}

export interface CreateServiceBookingResult {
  bookingId: string;
  paymentRef: string;
  subtotalKobo: number;
  feeKobo: number;
  totalKobo: number;
  currency: string;
}

// Server-computed order: re-derives every price/currency/ownership fact
// from provider_services itself (see create_service_booking, 0054) --
// nothing here is trusted from the client beyond WHICH services and
// quantities were selected.
export async function createServiceBooking(
  providerId: string,
  items: ServiceBookingItemInput[],
  opts: { scheduledDate?: string | null; scheduledTime?: string | null; location?: string | null; notes?: string | null } = {}
): Promise<CreateServiceBookingResult> {
  const { data, error } = await supabase.rpc('create_service_booking', {
    p_provider_id: providerId,
    p_items: items.map((i) => ({ service_id: i.serviceId, quantity: i.quantity })),
    p_scheduled_date: opts.scheduledDate || null,
    p_scheduled_time: opts.scheduledTime || null,
    p_location: opts.location || null,
    p_notes: opts.notes || null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.payment_ref) throw new Error('Could not prepare this booking.');
  return {
    bookingId: row.booking_id,
    paymentRef: row.payment_ref,
    subtotalKobo: Number(row.subtotal_kobo),
    feeKobo: Number(row.fee_kobo),
    totalKobo: Number(row.total_kobo),
    currency: row.currency,
  };
}

export type VerifyServiceBookingResult = { status: 'success' } | { status: 'error'; error: string };

// The real payment-confirmed check -- calls the SAME server-side verify
// endpoint the ticket-purchase flow uses (api/webhook/paystack.ts,
// ?action=verify), which calls Paystack's own GET /transaction/verify
// before confirm_service_booking_payment (0054) ever marks anything paid.
// Never trusts the Paystack popup's own JS callback as proof on its own.
export async function verifyServiceBookingPayment(reference: string): Promise<VerifyServiceBookingResult> {
  const token = await getAuthToken();
  const res = await fetch(apiUrl('/api/webhook/paystack?action=verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ reference }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.status !== 'success') {
    const reason = json?.status === 'abandoned'
      ? 'Payment was not completed. If you were charged, contact support with your reference.'
      : json?.status === 'failed'
      ? 'Payment failed. You have not been charged.'
      : (json?.error || 'Could not verify this payment. If you were charged, contact support with your reference.');
    return { status: 'error', error: reason };
  }
  return { status: 'success' };
}

export interface ServiceBookingItemRow {
  id: string;
  serviceName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface ServiceBookingRow {
  id: string;
  providerId: string;
  providerBusinessName?: string;
  customerId: string;
  customerName?: string;
  customerAvatarUrl?: string;
  status: string;
  paymentStatus: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  location: string | null;
  customerNotes: string | null;
  currency: string;
  subtotal: number;
  fee: number;
  total: number;
  createdAt: string;
  items: ServiceBookingItemRow[];
}

function mapBookingRow(row: any): ServiceBookingRow {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerBusinessName: row.service_providers?.business_name,
    customerId: row.customer_id,
    status: row.status,
    paymentStatus: row.payment_status,
    scheduledDate: row.scheduled_date,
    scheduledTime: row.scheduled_time,
    location: row.location,
    customerNotes: row.customer_notes,
    currency: row.currency,
    subtotal: Number(row.subtotal_kobo) / 100,
    fee: Number(row.fee_kobo) / 100,
    total: Number(row.total_kobo) / 100,
    createdAt: row.created_at,
    items: (row.service_booking_items || []).map((i: any) => ({
      id: i.id,
      serviceName: i.service_name,
      unitPrice: Number(i.unit_price_kobo) / 100,
      quantity: i.quantity,
      lineTotal: Number(i.line_total_kobo) / 100,
    })),
  };
}

// RLS (service_bookings_select_own_customer, 0054) already restricts this
// to the caller's own bookings.
export async function fetchMyServiceBookings(): Promise<ServiceBookingRow[]> {
  const { data, error } = await supabase
    .from('service_bookings')
    .select('*, service_providers(business_name), service_booking_items(*)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapBookingRow);
}

// RLS (service_bookings_select_own_provider, 0054) already restricts this
// to bookings against the caller's own listing. customer_id has no FK
// PostgREST can embed through (public_profiles is a view), so the
// customer's display name/avatar is resolved with a second, real query
// against public_profiles -- same two-step pattern InboxScreen/ExploreScreen
// already use for a message partner's profile -- never a fabricated name.
export async function fetchProviderServiceBookings(providerId: string): Promise<ServiceBookingRow[]> {
  const { data, error } = await supabase
    .from('service_bookings')
    .select('*, service_booking_items(*)')
    .eq('provider_id', providerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = (data || []).map(mapBookingRow);

  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  if (customerIds.length > 0) {
    const { data: profiles } = await supabase
      .from('public_profiles')
      .select('id, full_name, username, avatar_url')
      .in('id', customerIds);
    const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));
    rows.forEach((r) => {
      const p = profileMap.get(r.customerId);
      r.customerName = p?.full_name || p?.username || undefined;
      r.customerAvatarUrl = p?.avatar_url || undefined;
    });
  }
  return rows;
}

export async function logServiceMarketplaceEvent(
  eventType: string,
  opts: { providerId?: string; serviceId?: string; bookingId?: string; metadata?: Record<string, any> } = {}
): Promise<void> {
  try {
    await supabase.rpc('log_service_marketplace_event', {
      p_event_type: eventType,
      p_provider_id: opts.providerId || null,
      p_service_id: opts.serviceId || null,
      p_booking_id: opts.bookingId || null,
      p_metadata: opts.metadata || {},
    });
  } catch {
    // Analytics-only -- never let a logging failure interrupt the actual
    // booking/payment flow.
  }
}
