import { useEffect, useState } from 'react';
import { ArrowLeft, Receipt, AlertCircle, CheckCircle2 } from 'lucide-react';
import { formatPrice } from './data';
import { supabase } from '../../lib/supabase';

interface PayerReceipt {
  id: string;
  event_id: string;
  ticket_type: string;
  amount: number;
  holder_name: string | null;
  payment_status: string;
  created_at: string;
  events: { title: string; image_url: string | null } | null;
}

interface PaymentRequestsScreenProps {
  currentUser: { id: string } | null;
  onBack: () => void;
}

// "Someone Else Pays" -- the payer's own receipts: every ticket where this
// user paid but someone else is the ticket holder (tickets.payer_id, read-
// only via the tickets_select_own_as_payer RLS policy from migration 0058).
// Ticket ownership/check-in/transfer are untouched by this view -- it's a
// receipt list, not a ticket list.
export function PaymentRequestsScreen({ currentUser, onBack }: PaymentRequestsScreenProps) {
  const [receipts, setReceipts] = useState<PayerReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from('tickets')
        .select('id, event_id, ticket_type, amount, holder_name, payment_status, created_at, events(title, image_url)')
        .eq('payer_id', currentUser.id)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        setLoadError('Could not load your payment receipts.');
      } else {
        setReceipts((data as any) || []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [currentUser?.id]);

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
          Tickets you paid for on someone else's behalf. They hold the ticket and QR code — these are your receipts.
        </p>

        {loading && <p style={{ color: '#8B8FA8', fontSize: '14px', textAlign: 'center', marginTop: '30px' }}>Loading…</p>}

        {!loading && loadError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px' }}>
            <AlertCircle size={14} color="#EF4444" />
            <span style={{ color: '#EF4444', fontSize: '13px' }}>{loadError}</span>
          </div>
        )}

        {!loading && !loadError && receipts.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', marginTop: '40px' }}>
            <Receipt size={28} color="#4B5563" />
            <p style={{ color: '#8B8FA8', fontSize: '14px', textAlign: 'center' }}>No payment receipts yet.</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {receipts.map((r) => (
            <div key={r.id} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              {r.events?.image_url && (
                <img src={r.events.image_url} alt="" style={{ width: '48px', height: '48px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: '#FFFFFF', fontSize: '14px', fontWeight: 700 }}>{r.events?.title || 'Event'}</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>
                  {r.ticket_type} · For {r.holder_name || 'recipient'}
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ color: '#FFFFFF', fontSize: '14px', fontWeight: 600 }}>{formatPrice(r.amount)}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end', marginTop: '2px' }}>
                  {r.payment_status === 'paid' ? (
                    <>
                      <CheckCircle2 size={11} color="#10B981" />
                      <span style={{ color: '#10B981', fontSize: '11px' }}>Paid</span>
                    </>
                  ) : (
                    <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{r.payment_status}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
