import { useEffect, useState } from 'react';
import { ArrowLeft, Receipt, AlertCircle, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { formatPrice } from './data';
import { supabase } from '../../lib/supabase';

interface PaymentRequestRow {
  payment_ref: string;
  event_title: string;
  event_image_url: string | null;
  ticket_type: string;
  attendee_count: number;
  amount_kobo: number;
  recipient_name: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  is_expired: boolean;
  created_at: string;
}

interface PaymentRequestsScreenProps {
  currentUser: { id: string } | null;
  onBack: () => void;
  onOpenRequest: (paymentRef: string) => void;
}

// "Someone Else Pays" -- the payer's own list: every request naming this
// user as payer, pending through completed/cancelled/expired, in one place.
// Backed by get_my_payment_requests() (migration 0059) -- a narrow
// SECURITY DEFINER RPC scoped to payer_id = auth.uid(), never a direct
// client query against pending_purchases (which stays project_admin-only
// at the table level) or against tickets (a pending/cancelled/expired
// request has no ticket at all -- that's the bug this screen used to have).
export function PaymentRequestsScreen({ currentUser, onBack, onOpenRequest }: PaymentRequestsScreenProps) {
  const [requests, setRequests] = useState<PaymentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await supabase.rpc('get_my_payment_requests');
      if (cancelled) return;
      if (error) {
        setLoadError('Could not load your payment requests.');
      } else {
        setRequests((data as any) || []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  const statusBadge = (r: PaymentRequestRow) => {
    if (r.status === 'completed') {
      return (
        <>
          <CheckCircle2 size={11} color="#10B981" />
          <span style={{ color: '#10B981', fontSize: '11px' }}>Paid</span>
        </>
      );
    }
    if (r.status === 'cancelled') {
      return (
        <>
          <XCircle size={11} color="#8B8FA8" />
          <span style={{ color: '#8B8FA8', fontSize: '11px' }}>Cancelled</span>
        </>
      );
    }
    if (r.status === 'expired' || r.is_expired) {
      return (
        <>
          <Clock size={11} color="#EF4444" />
          <span style={{ color: '#EF4444', fontSize: '11px' }}>Expired</span>
        </>
      );
    }
    return (
      <>
        <Clock size={11} color="#F59E0B" />
        <span style={{ color: '#F59E0B', fontSize: '11px' }}>Pending — tap to pay</span>
      </>
    );
  };

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button
          onClick={onBack}
          style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#FFFFFF', fontSize: '18px', fontWeight: 700 }}>Payment Requests</h1>
      </div>

      <div style={{ flex: 1, padding: '4px 16px 40px' }}>
        <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '18px', lineHeight: 1.5 }}>
          Tickets other VENTS users asked you to pay for. They hold the ticket and QR code — these are your requests and receipts.
        </p>

        {loading && <p style={{ color: '#8B8FA8', fontSize: '14px', textAlign: 'center', marginTop: '30px' }}>Loading…</p>}

        {!loading && loadError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px' }}>
            <AlertCircle size={14} color="#EF4444" />
            <span style={{ color: '#EF4444', fontSize: '13px' }}>{loadError}</span>
          </div>
        )}

        {!loading && !loadError && requests.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', marginTop: '40px' }}>
            <Receipt size={28} color="#4B5563" />
            <p style={{ color: '#8B8FA8', fontSize: '14px', textAlign: 'center' }}>No payment requests yet.</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {requests.map((r) => (
            <div
              key={r.payment_ref}
              onClick={() => onOpenRequest(r.payment_ref)}
              style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px', display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}
            >
              {r.event_image_url && (
                <img src={r.event_image_url} alt="" style={{ width: '48px', height: '48px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: '#FFFFFF', fontSize: '14px', fontWeight: 700 }}>{r.event_title}</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>
                  {r.ticket_type} · For {r.recipient_name}
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ color: '#FFFFFF', fontSize: '14px', fontWeight: 600 }}>{formatPrice(Math.round(r.amount_kobo / 100))}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end', marginTop: '2px' }}>
                  {statusBadge(r)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
