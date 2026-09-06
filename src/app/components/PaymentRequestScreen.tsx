import { useEffect, useState } from 'react';
import { ArrowLeft, Lock, AlertCircle, Clock, XCircle, CheckCircle2 } from 'lucide-react';
import { formatPrice } from './data';
import { openPaystackPopup } from '../../lib/paystack';
import { supabase, getAuthToken } from '../../lib/supabase';
import { apiUrl } from '../../lib/apiBase';

interface PaymentRequestDetails {
  event_title: string;
  event_image_url: string | null;
  ticket_type: string;
  attendee_count: number;
  amount_kobo: number;
  recipient_name: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  is_expired: boolean;
}

interface PaymentRequestScreenProps {
  paymentRef: string;
  currentUser: { id: string; email: string; full_name: string | null; username?: string } | null;
  onBack: () => void;
  onPaid: () => void;
}

// "Someone else is paying" -- the payer's own screen, reached via a
// shareable link (?payment_request=<ref>) or an in-app notification. Reuses
// the exact same Paystack popup + server-side verify path ticket checkout
// uses (api/webhook/paystack.ts?action=verify) -- no second payment system.
// The recipient stays the ticket holder; this screen never creates or
// shows a ticket, only the request and, after paying, a receipt.
export function PaymentRequestScreen({ paymentRef, currentUser, onBack, onPaid }: PaymentRequestScreenProps) {
  const [details, setDetails] = useState<PaymentRequestDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // cancel_payment_request is recipient-only, enforced server-side -- there's
  // no client-visible field distinguishing "you're the recipient" from
  // "you're the payer" (both are legitimately allowed to view this same
  // request), so a payer who taps Cancel simply gets the same authorization
  // error the RPC raises, surfaced here rather than guessed at client-side.
  const [notRecipient, setNotRecipient] = useState(false);

  const handleCancel = async () => {
    if (!details || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const { data, error } = await supabase.rpc('cancel_payment_request', { p_payment_ref: paymentRef });
      if (error) {
        if (/not authorized/i.test(error.message || '')) {
          setNotRecipient(true);
        } else {
          setCancelError(error.message || 'Could not cancel this request.');
        }
        return;
      }
      setDetails((prev) => (prev ? { ...prev, status: data as any } : prev));
    } catch (err: any) {
      setCancelError(err?.message || 'Could not cancel this request.');
    } finally {
      setCancelling(false);
    }
  };

  useEffect(() => {
    // get_payment_request_details is scoped to the caller's own auth.uid()
    // (payer or recipient) -- with no session at all it correctly returns
    // no row, which must not be shown as "this request doesn't exist": a
    // logged-out payer following the link needs to log in, not be told the
    // request is missing.
    if (!currentUser) {
      setLoading(false);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await supabase.rpc('get_payment_request_details', { p_payment_ref: paymentRef });
      if (cancelled) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) {
        setLoadError('This payment request could not be found, or you do not have access to it.');
      } else {
        setDetails(row as PaymentRequestDetails);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [paymentRef, currentUser?.id]);

  const handlePay = async () => {
    if (!details || paying) return;
    if (!currentUser) {
      setPayError('Please log in with your VENTS account to pay this request.');
      return;
    }
    if (details.status !== 'pending' || details.is_expired) {
      setPayError('This payment request is no longer active.');
      return;
    }
    if (!window.PaystackPop) {
      setPayError('Payment system not loaded. Please refresh the page and try again.');
      return;
    }

    setPaying(true);
    setPayError(null);

    // Mint a fresh, disposable Paystack reference for this attempt --
    // paymentRef stays the stable request identity (used to fetch these
    // details, and to cancel), but Paystack must never see the same
    // reference twice. This is exactly why revisiting the same persisted
    // request and hitting Pay more than once (a genuinely normal thing to
    // do with a stable, revisitable request) used to fail with "Duplicate
    // Transaction Reference" -- see initiate_ticket_payment_attempt
    // (0060), mirroring the existing ticket-transfer-fee pattern.
    let paystackRef: string;
    let chargeAmountKobo: number;
    try {
      const { data: attemptData, error: attemptError } = await supabase.rpc('initiate_ticket_payment_attempt', {
        p_payment_ref: paymentRef,
      });
      if (attemptError) throw attemptError;
      paystackRef = (attemptData as any)?.reference;
      chargeAmountKobo = Number((attemptData as any)?.amount_kobo);
      if (!paystackRef || !chargeAmountKobo || chargeAmountKobo <= 0) throw new Error('Could not start this payment attempt.');
    } catch (err: any) {
      setPaying(false);
      setPayError(err?.message || 'Could not start payment. Please try again.');
      return;
    }

    try {
      openPaystackPopup({
        email: currentUser.email,
        amountKobo: chargeAmountKobo,
        ref: paystackRef,
        label: currentUser.full_name || currentUser.username || '',
        metadata: {
          payment_request: true,
          event_title: details.event_title,
        },
        onSuccess: async (response) => {
          try {
            const token = await getAuthToken();
            const verifyRes = await fetch(apiUrl('/api/webhook/paystack?action=verify'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ reference: response.reference }),
            });
            const verifyJson = await verifyRes.json().catch(() => null);
            if (!verifyRes.ok || verifyJson?.status !== 'success') {
              throw new Error(verifyJson?.error || 'Could not verify this payment. If you were charged, contact support with your reference.');
            }
            setPaid(true);
            setPaying(false);
            onPaid();
          } catch (err: any) {
            setPaying(false);
            setPayError(err?.message || 'Could not verify this payment. If you were charged, contact support with your reference.');
          }
        },
        onClose: () => setPaying(false),
        onError: (message) => { setPaying(false); setPayError(message); },
      });
    } catch (err: any) {
      setPaying(false);
      setPayError('Payment failed to start: ' + (err?.message || 'Please try again.'));
    }
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
        <h1 style={{ color: '#FFFFFF', fontSize: '18px', fontWeight: 700 }}>Payment Request</h1>
      </div>

      <div style={{ flex: 1, padding: '4px 16px 140px' }}>
        {loading && <p style={{ color: '#8B8FA8', fontSize: '14px', textAlign: 'center', marginTop: '40px' }}>Loading request…</p>}

        {!loading && !currentUser && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', marginTop: '40px', textAlign: 'center' }}>
            <Lock size={28} color="#A78BFA" />
            <p style={{ color: '#FFFFFF', fontSize: '15px', fontWeight: 700 }}>Log in to view this request</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', maxWidth: '260px' }}>
              This payment request is tied to a VENTS account. Log in with the account it was sent to, then reopen this link.
            </p>
          </div>
        )}

        {!loading && currentUser && loadError && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', marginTop: '40px' }}>
            <AlertCircle size={28} color="#EF4444" />
            <p style={{ color: '#EF4444', fontSize: '14px', textAlign: 'center' }}>{loadError}</p>
          </div>
        )}

        {!loading && details && (
          <>
            <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '24px', padding: '14px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              {details.event_image_url && (
                <img src={details.event_image_url} alt="" style={{ width: '56px', height: '56px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: '#FFFFFF', fontSize: '16px', fontWeight: 700 }}>{details.event_title}</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{details.ticket_type} × {details.attendee_count}</p>
              </div>
              <p style={{ color: '#FFFFFF', fontSize: '16px', fontWeight: 600 }}>{formatPrice(Math.round(details.amount_kobo / 100))}</p>
            </div>

            <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '16px' }}>
              <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.6 }}>
                <strong style={{ color: '#FFFFFF' }}>{details.recipient_name}</strong> asked you to pay for this ticket. They'll receive the ticket and QR code once you complete payment — you'll get a receipt, not the ticket.
              </p>
            </div>

            {(paid || details.status === 'completed') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '12px', padding: '14px' }}>
                <CheckCircle2 size={18} color="#10B981" />
                <span style={{ color: '#10B981', fontSize: '14px', fontWeight: 600 }}>Paid — {details.recipient_name} has received their ticket.</span>
              </div>
            )}
            {!paid && details.status === 'cancelled' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '14px' }}>
                <XCircle size={18} color="#8B8FA8" />
                <span style={{ color: '#8B8FA8', fontSize: '14px' }}>This request was cancelled by {details.recipient_name}.</span>
              </div>
            )}
            {!paid && (details.status === 'expired' || (details.status === 'pending' && details.is_expired)) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '14px' }}>
                <Clock size={18} color="#EF4444" />
                <span style={{ color: '#EF4444', fontSize: '14px' }}>This payment request has expired.</span>
              </div>
            )}

            {payError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px' }}>
                <AlertCircle size={14} color="#EF4444" />
                <span style={{ color: '#EF4444', fontSize: '13px' }}>{payError}</span>
              </div>
            )}
            {cancelError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px' }}>
                <AlertCircle size={14} color="#EF4444" />
                <span style={{ color: '#EF4444', fontSize: '13px' }}>{cancelError}</span>
              </div>
            )}
            {notRecipient && (
              <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '10px', textAlign: 'center' }}>
                Only the person who sent this request can cancel it.
              </p>
            )}
          </>
        )}
      </div>

      {!loading && details && !paid && details.status === 'pending' && !details.is_expired && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(6,10,18,0.95)', backdropFilter: 'blur(20px)', borderTop: '1px solid rgba(255,255,255,0.08)', padding: '14px 16px 28px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            onClick={handlePay}
            disabled={paying}
            style={{
              width: '100%', height: '52px', background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none',
              borderRadius: '100px', color: '#fff', fontSize: '16px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif',
              cursor: paying ? 'not-allowed' : 'pointer', opacity: paying ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            }}
          >
            <Lock size={16} color="#fff" />
            {paying ? 'Processing…' : `Pay ${formatPrice(Math.round(details.amount_kobo / 100))}`}
          </button>
          {!notRecipient && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              style={{
                width: '100%', height: '40px', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '100px', color: '#8B8FA8', fontSize: '13px', fontWeight: 600,
                cursor: cancelling ? 'not-allowed' : 'pointer', opacity: cancelling ? 0.6 : 1,
              }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel Request'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
