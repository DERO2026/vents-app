// Service Bookings — ported from the legacy AdminDashboardScreen.tsx
// 'service-bookings' tab as part of its full retirement. View-only by
// design (no mutation actions exist for booking state) — this is where an
// admin investigates a booking's payment reference/status (gap #1: payment
// investigation), not where they act on it.
import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { adminTheme } from './adminConsoleTheme';
import { fetchAdminServiceBookings, AdminServiceBookingRow } from '../../../lib/serviceBookings';
import { Sentry } from '../../../lib/sentry';

const PAGE_SIZE = 50;
const STATUS_LABELS: Record<string, string> = { all: 'All statuses', pending_payment: 'Pending payment', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled' };

export function AdminServiceBookingsScreen() {
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending_payment' | 'confirmed' | 'completed' | 'cancelled'>('all');
  const [bookings, setBookings] = useState<AdminServiceBookingRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<AdminServiceBookingRow | null>(null);

  const load = useCallback(async (off: number) => {
    setLoading(true); setError(null);
    try {
      const rows = await fetchAdminServiceBookings({ status: statusFilter === 'all' ? undefined : statusFilter, limit: PAGE_SIZE, offset: off });
      setBookings((prev) => (off === 0 ? rows : [...(prev || []), ...rows]));
      setHasMore(rows.length === PAGE_SIZE);
      setOffset(off);
    } catch (err: any) {
      Sentry.captureException(err);
      setError(err?.message || 'Failed to load service bookings.');
      if (off === 0) setBookings([]);
    } finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { load(0); }, [load]);

  if (selected) {
    const b = selected;
    return (
      <div data-testid="admin-service-booking-detail">
        <div onClick={() => setSelected(null)} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: adminTheme.accentText, fontSize: 12.5, marginBottom: 16 }}>
          <ArrowLeft size={14} /> Back to Bookings
        </div>
        <div style={{ background: adminTheme.panel, borderRadius: 16, padding: 18, border: `1px solid ${adminTheme.border}`, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Booking ID</p>
            <p style={{ color: adminTheme.textStrong, fontSize: 13, fontFamily: 'monospace', margin: 0, wordBreak: 'break-all' }}>{b.bookingId}</p>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div>
              <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Status</p>
              <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 700, margin: 0, textTransform: 'capitalize' }}>{b.status.replace('_', ' ')}</p>
            </div>
            <div>
              <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Payment Status</p>
              <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 700, margin: 0, textTransform: 'capitalize' }}>{b.paymentStatus.replace('_', ' ')}</p>
            </div>
          </div>
          <div>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Provider</p>
            <p style={{ color: adminTheme.textStrong, fontSize: 14, margin: 0 }}>{b.providerBusinessName || '—'}</p>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0', fontFamily: 'monospace' }}>{b.providerId}</p>
          </div>
          <div>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Customer</p>
            <p style={{ color: adminTheme.textStrong, fontSize: 14, margin: 0 }}>{b.customerName || '—'}</p>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>{b.customerEmail || '—'}</p>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0', fontFamily: 'monospace' }}>{b.customerId}</p>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div>
              <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Subtotal</p>
              <p style={{ color: adminTheme.textStrong, fontSize: 14, margin: 0 }}>{b.currency} {(b.subtotalKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</p>
            </div>
            <div>
              <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Fee</p>
              <p style={{ color: adminTheme.textStrong, fontSize: 14, margin: 0 }}>{b.currency} {(b.feeKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</p>
            </div>
            <div>
              <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Total</p>
              <p style={{ color: adminTheme.accentFrom, fontSize: 16, fontWeight: 800, margin: 0 }}>{b.currency} {(b.totalKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</p>
            </div>
          </div>
          {b.paymentRef && (
            <div>
              <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Payment Reference</p>
              <p style={{ color: adminTheme.textStrong, fontSize: 13, fontFamily: 'monospace', margin: 0, wordBreak: 'break-all' }}>{b.paymentRef}</p>
            </div>
          )}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {b.scheduledDate && (
              <div>
                <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Scheduled</p>
                <p style={{ color: adminTheme.textStrong, fontSize: 13, margin: 0 }}>{new Date(b.scheduledDate).toLocaleDateString('en-NG')}</p>
              </div>
            )}
            <div>
              <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 2px', textTransform: 'uppercase' }}>Created</p>
              <p style={{ color: adminTheme.textStrong, fontSize: 13, margin: 0 }}>{new Date(b.createdAt).toLocaleString('en-NG')}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const statusColors: Record<string, { text: string; bg: string }> = {
    pending_payment: { text: adminTheme.textMuted, bg: adminTheme.borderChip },
    confirmed: { text: adminTheme.blue, bg: 'rgba(96,165,250,.15)' },
    completed: { text: adminTheme.green, bg: 'rgba(52,211,153,.15)' },
    cancelled: { text: adminTheme.red, bg: 'rgba(248,113,113,.15)' },
  };
  const paymentColors: Record<string, { text: string; bg: string }> = {
    pending: { text: adminTheme.amber, bg: 'rgba(251,191,36,.15)' },
    paid: { text: adminTheme.green, bg: 'rgba(52,211,153,.15)' },
    failed: { text: adminTheme.red, bg: 'rgba(248,113,113,.15)' },
    refund_pending: { text: adminTheme.amber, bg: 'rgba(251,191,36,.15)' },
    refunded: { text: adminTheme.textMuted, bg: adminTheme.borderChip },
  };

  return (
    <div data-testid="admin-service-bookings">
      <p style={{ color: adminTheme.textFaint, fontSize: 12, marginBottom: 12 }}>
        Service Bookings — view-only (no mutation actions exist for booking state; investigate here, act via the customer/provider flows)
      </p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {(Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map((s) => (
          <div key={s} onClick={() => setStatusFilter(s as any)} style={{
            fontSize: 11.5, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
            background: statusFilter === s ? adminTheme.accentSoftBg : adminTheme.panel,
            color: statusFilter === s ? adminTheme.accentText : adminTheme.textMuted,
            border: `1px solid ${statusFilter === s ? adminTheme.accentSoftBorder : adminTheme.border}`,
          }}>{STATUS_LABELS[s]}</div>
        ))}
      </div>

      {error && <div style={{ color: adminTheme.red, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}

      {loading && (!bookings || bookings.length === 0) ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 32 }}>Loading…</div>
      ) : !bookings || bookings.length === 0 ? (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No service bookings match this filter.</div>
      ) : (
        <>
          {bookings.map((b) => {
            const sc = statusColors[b.status] || { text: adminTheme.textMuted, bg: adminTheme.borderChip };
            const pc = paymentColors[b.paymentStatus] || { text: adminTheme.textMuted, bg: adminTheme.borderChip };
            return (
              <div key={b.bookingId} onClick={() => setSelected(b)} style={{ cursor: 'pointer', background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: 14, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.providerBusinessName || b.providerId.slice(0, 8)}</span>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: sc.bg, color: sc.text, textTransform: 'uppercase' }}>{b.status.replace('_', ' ')}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: pc.bg, color: pc.text, textTransform: 'uppercase' }}>{b.paymentStatus.replace('_', ' ')}</span>
                  </div>
                </div>
                <p style={{ color: adminTheme.textMuted, fontSize: 12, margin: '0 0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.customerName || b.customerEmail || b.customerId.slice(0, 8)}</p>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: 0 }}>{b.scheduledDate ? new Date(b.scheduledDate).toLocaleDateString('en-NG') : new Date(b.createdAt).toLocaleDateString('en-NG')}</p>
                  <p style={{ color: adminTheme.accentFrom, fontSize: 13, fontWeight: 700, margin: 0 }}>{b.currency} {(b.totalKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</p>
                </div>
              </div>
            );
          })}
          {hasMore && (
            <button onClick={() => load(offset + PAGE_SIZE)} disabled={loading} style={{ width: '100%', height: 40, borderRadius: 10, background: adminTheme.accentSoftBg, border: `1px solid ${adminTheme.accentSoftBorder}`, color: adminTheme.accentText, fontSize: 13, fontWeight: 600, cursor: loading ? 'wait' : 'pointer', marginTop: 4 }}>
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
