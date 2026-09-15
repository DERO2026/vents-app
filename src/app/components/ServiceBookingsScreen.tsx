import { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Calendar, Clock, MapPin, RefreshCw } from 'lucide-react';
import { servicesColors, servicesRadii, servicesSpacing } from '../../lib/servicesDesignTokens';
import { fetchMyServiceBookings, fetchProviderServiceBookings, ServiceBookingRow } from '../../lib/serviceBookings';
import { getAuthToken } from '../../lib/supabase';
import { apiUrl } from '../../lib/apiBase';

// Booking history/receipt screen for the Services marketplace
// (0054_service_bookings_marketplace.sql). Two real, RLS-scoped data
// sources -- fetchMyServiceBookings (the caller's own bookings as customer)
// and fetchProviderServiceBookings (bookings against the caller's own
// listing) -- rendered through one shared component since the layout need
// (status, items, amounts, schedule) is identical; only the counterpart
// name/label differs. This is the screen the booking-success message on
// ServiceProviderProfileScreen already promised ("Check My Bookings for
// details") but that had no destination until now.

interface ServiceBookingsScreenProps {
  mode: 'customer' | 'provider';
  providerId?: string; // required when mode === 'provider'
  onBack: () => void;
}

function statusBadge(status: string, paymentStatus: string): { label: string; color: string; bg: string } {
  if (paymentStatus === 'pending' && status === 'pending_payment') {
    return { label: 'Awaiting Payment', color: servicesColors.warning, bg: 'rgba(245,158,11,0.14)' };
  }
  if (status === 'confirmed') return { label: 'Confirmed', color: servicesColors.success, bg: 'rgba(16,185,129,0.14)' };
  if (status === 'completed') return { label: 'Completed', color: servicesColors.accentPurple, bg: 'rgba(168,85,247,0.14)' };
  if (status === 'cancelled') return { label: 'Cancelled', color: servicesColors.error, bg: 'rgba(239,68,68,0.14)' };
  return { label: status, color: servicesColors.textSecondary, bg: 'rgba(255,255,255,0.06)' };
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function ServiceBookingsScreen({ mode, providerId, onBack }: ServiceBookingsScreenProps) {
  const [bookings, setBookings] = useState<ServiceBookingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ServiceBookingRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = () => {
    setError(null);
    const promise = mode === 'provider' && providerId
      ? fetchProviderServiceBookings(providerId)
      : fetchMyServiceBookings();
    promise
      .then(setBookings)
      .catch((err: any) => setError(err?.message || 'Failed to load bookings.'));
  };

  useEffect(() => { load(); }, [mode, providerId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { load(); } finally { setTimeout(() => setRefreshing(false), 400); }
  };

  const openCancelDialog = (booking: ServiceBookingRow) => {
    setCancelTarget(booking);
    setCancelReason('');
    setCancelError(null);
  };

  // Provider/admin-triggered service-booking refund. cancel_service_booking
  // (SECURITY DEFINER) does all authorization, locking, and amount
  // derivation server-side -- this only calls the shared refund endpoint
  // (api/wallet/refund-ticket.ts, which also handles booking_id) and
  // reflects the result. Mirrors AttendeeListScreen's ticket-refund dialog.
  const confirmCancel = async () => {
    const booking = cancelTarget;
    if (!booking) return;
    if (!cancelReason.trim()) { setCancelError('A reason is required — this is shown to the customer.'); return; }

    setCancellingId(booking.id);
    setCancelError(null);
    try {
      const token = await getAuthToken();
      const res = await fetch(apiUrl('/api/wallet/refund-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ booking_id: booking.id, reason: cancelReason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Refund failed');

      setBookings((prev) =>
        (prev || []).map((b) =>
          b.id === booking.id
            ? { ...b, status: 'cancelled', paymentStatus: json.status === 'refunded' ? 'refunded' : 'refund_pending' }
            : b
        )
      );
      setCancelTarget(null);
    } catch (err: any) {
      setCancelError(err.message || 'Refund failed');
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div style={{ background: servicesColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 12px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={onBack} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <ArrowLeft size={16} color="#C4C9E0" />
          </button>
          <h1 style={{ color: servicesColors.textPrimary, fontSize: '19px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            {mode === 'provider' ? 'My Bookings' : 'My Service Bookings'}
          </h1>
        </div>
        <button onClick={handleRefresh} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <RefreshCw size={15} color="#A78BFA" style={{ animation: refreshing ? 'spin 0.8s linear infinite' : 'none' }} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: `0 ${servicesSpacing.lg}px calc(40px + env(safe-area-inset-bottom))` }}>
        {/* Only show the banner-style error once bookings has loaded at least
            once -- a failed REFRESH keeps the existing list visible with this
            banner on top. A failed INITIAL load falls through to the
            dedicated error state below instead (previously this banner and
            "Loading…" rendered at the same time forever, since `bookings`
            never leaves null on a caught fetch error). */}
        {error && bookings !== null && <p style={{ color: servicesColors.error, fontSize: '13px', margin: '0 0 12px' }}>{error}</p>}

        {bookings === null && error ? (
          <div style={{ textAlign: 'center', marginTop: '40px' }}>
            <AlertCircle size={32} color={servicesColors.error} style={{ marginBottom: '10px', marginLeft: 'auto', marginRight: 'auto' }} />
            <p style={{ color: servicesColors.textPrimary, fontSize: '15px', fontWeight: 700, margin: '0 0 6px' }}>Couldn't load your bookings</p>
            <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: '0 0 16px' }}>{error}</p>
            <button
              onClick={load}
              style={{ background: 'rgba(239,68,68,0.12)', border: `1px solid ${servicesColors.error}`, borderRadius: servicesRadii.md, padding: '10px 20px', color: servicesColors.error, fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        ) : bookings === null ? (
          <p style={{ color: servicesColors.textSecondary, textAlign: 'center', marginTop: '40px', fontSize: '13px' }}>Loading…</p>
        ) : bookings.length === 0 ? (
          <div style={{ textAlign: 'center', marginTop: '40px' }}>
            <p style={{ color: servicesColors.textPrimary, fontSize: '15px', fontWeight: 700, margin: '0 0 6px' }}>No bookings yet</p>
            <p style={{ color: servicesColors.textSecondary, fontSize: '13px', margin: 0 }}>
              {mode === 'provider' ? 'Paid bookings from customers will show up here.' : 'Book a service from a provider to see it here.'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '4px' }}>
            {bookings.map((b) => {
              const badge = statusBadge(b.status, b.paymentStatus);
              const counterpart = mode === 'provider' ? (b.customerName || 'Customer') : (b.providerBusinessName || 'Provider');
              return (
                <div key={b.id} style={{ background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.lg, padding: '14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ color: servicesColors.textPrimary, fontSize: '14px', fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{counterpart}</p>
                      <p style={{ color: servicesColors.textTertiary, fontSize: '11px', margin: '2px 0 0' }}>Ref: {b.id.slice(0, 8).toUpperCase()}</p>
                    </div>
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: servicesRadii.pill, background: badge.bg, color: badge.color, flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {badge.label.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
                    {b.items.map((item) => (
                      <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px' }}>
                        <span style={{ color: '#C9C9D9' }}>{item.quantity} &times; {item.serviceName}</span>
                        <span style={{ color: servicesColors.textSecondary }}>{b.currency} {item.lineTotal.toLocaleString('en-US')}</span>
                      </div>
                    ))}
                  </div>

                  {(b.scheduledDate || b.location) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '10px' }}>
                      {b.scheduledDate && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <Calendar size={12} color={servicesColors.textTertiary} />
                          <span style={{ color: servicesColors.textSecondary, fontSize: '11.5px' }}>{formatDate(b.scheduledDate)}</span>
                        </div>
                      )}
                      {b.scheduledTime && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <Clock size={12} color={servicesColors.textTertiary} />
                          <span style={{ color: servicesColors.textSecondary, fontSize: '11.5px' }}>{b.scheduledTime}</span>
                        </div>
                      )}
                      {b.location && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
                          <MapPin size={12} color={servicesColors.textTertiary} />
                          <span style={{ color: servicesColors.textSecondary, fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.location}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', paddingTop: '10px', borderTop: `1px dashed ${servicesColors.border}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px' }}>
                      <span style={{ color: servicesColors.textTertiary }}>Subtotal</span>
                      <span style={{ color: servicesColors.textSecondary }}>{b.currency} {b.subtotal.toLocaleString('en-US')}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px' }}>
                      <span style={{ color: servicesColors.textTertiary }}>VENTS fee</span>
                      <span style={{ color: servicesColors.textSecondary }}>{b.currency} {b.fee.toLocaleString('en-US')}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginTop: '2px' }}>
                      <span style={{ color: servicesColors.textPrimary, fontWeight: 700 }}>
                        {mode === 'provider'
                          ? (b.paymentStatus === 'paid' ? 'You earned' : 'You will earn')
                          : (b.paymentStatus === 'paid' ? 'Total paid' : 'Total due')}
                      </span>
                      <span style={{ color: servicesColors.textPrimary, fontWeight: 700 }}>
                        {b.currency} {(mode === 'provider' ? b.subtotal : b.total).toLocaleString('en-US')}
                      </span>
                    </div>
                  </div>

                  {mode === 'provider' && b.paymentStatus === 'paid' && (
                    <button
                      onClick={() => openCancelDialog(b)}
                      style={{ marginTop: '10px', width: '100%', background: 'rgba(239,68,68,0.10)', border: `1px solid ${servicesColors.error}`, borderRadius: servicesRadii.md, padding: '8px', color: servicesColors.error, fontSize: '12.5px', fontWeight: 700, cursor: 'pointer' }}
                    >
                      Cancel & Refund
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {cancelTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,0,5,0.75)', display: 'flex', alignItems: 'flex-end', zIndex: 9300 }}>
          <div style={{ background: servicesColors.bg, width: '100%', borderRadius: '20px 20px 0 0', padding: '20px', border: `1px solid ${servicesColors.border}` }}>
            <p style={{ color: servicesColors.textPrimary, fontSize: '16px', fontWeight: 800, margin: '0 0 6px' }}>Cancel this booking?</p>
            <p style={{ color: servicesColors.textSecondary, fontSize: '12.5px', margin: '0 0 12px' }}>
              The customer gets their full payment back, including the VENTS fee. Your earnings for this booking will be reversed.
            </p>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Reason (shown to the customer)"
              rows={3}
              style={{ width: '100%', boxSizing: 'border-box', background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.md, padding: '10px', color: servicesColors.textPrimary, fontSize: '13px', resize: 'none', marginBottom: '10px' }}
            />
            {cancelError && <p style={{ color: servicesColors.error, fontSize: '12px', margin: '0 0 10px' }}>{cancelError}</p>}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setCancelTarget(null)}
                disabled={cancellingId === cancelTarget.id}
                style={{ flex: 1, background: servicesColors.cardBg, border: `1px solid ${servicesColors.border}`, borderRadius: servicesRadii.md, padding: '11px', color: servicesColors.textPrimary, fontSize: '13.5px', fontWeight: 700, cursor: 'pointer' }}
              >
                Keep booking
              </button>
              <button
                onClick={confirmCancel}
                disabled={cancellingId === cancelTarget.id}
                style={{ flex: 1, background: servicesColors.error, border: 'none', borderRadius: servicesRadii.md, padding: '11px', color: '#fff', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer', opacity: cancellingId === cancelTarget.id ? 0.6 : 1 }}
              >
                {cancellingId === cancelTarget.id ? 'Refunding…' : 'Cancel & Refund'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
