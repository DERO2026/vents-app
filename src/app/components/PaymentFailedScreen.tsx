import { AlertTriangle, Home, Copy, Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface PaymentFailedScreenProps {
  eventTitle: string;
  reference: string;
  message: string;
  onGoHome: () => void;
}

// Shown when Paystack has already captured payment but the server-side
// ticket-creation RPC (purchase_ticket_with_tokens) failed — a sold-out
// race, a stale promo code, a dropped connection, or any other server
// rejection. The buyer has been charged with no ticket issued, so this
// screen must never look like a success state, and must give them the
// payment reference to quote to support.
export function PaymentFailedScreen({ eventTitle, reference, message, onGoHome }: PaymentFailedScreenProps) {
  const [copied, setCopied] = useState(false);
  // Guards the setTimeout below — "Back to Home" can navigate away right
  // after a copy, and without this the timeout would call setState on an
  // unmounted component.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const handleCopyRef = async () => {
    try {
      await navigator.clipboard.writeText(reference);
      if (!mountedRef.current) return;
      setCopied(true);
      setTimeout(() => { if (mountedRef.current) setCopied(false); }, 2000);
    } catch { /* clipboard unavailable — reference is still visible on screen */ }
  };

  return (
    <div
      style={{
        background: '#020005',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          padding: 'calc(40px + env(safe-area-inset-top)) 24px 24px',
        }}
      >
        <div
          style={{
            width: '72px',
            height: '72px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(245,158,11,0.2), rgba(245,158,11,0.05))',
            border: '2px solid rgba(245,158,11,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
            boxShadow: '0 0 32px rgba(245,158,11,0.25)',
          }}
        >
          <AlertTriangle size={36} color="#F59E0B" fill="rgba(245,158,11,0.15)" />
        </div>
        <h1
          style={{
            color: '#F0F0FF',
            fontSize: '24px',
            fontWeight: 800,
            fontFamily: 'Space Grotesk, sans-serif',
            marginBottom: '6px',
          }}
        >
          Payment Received, Ticket Pending
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.5, maxWidth: '320px', margin: '0 auto' }}>
          Your payment for <strong style={{ color: '#F0F0FF' }}>{eventTitle}</strong> went through, but we
          couldn't confirm your ticket automatically. This is usually temporary — our team will resolve it
          and email your ticket, or refund you if the tickets have sold out.
        </p>
      </div>

      <div style={{ padding: '0 16px 24px' }}>
        <div
          style={{
            background: '#090514',
            borderRadius: '20px',
            border: '1px solid rgba(245,158,11,0.25)',
            padding: '20px',
          }}
        >
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '4px' }}>What happened</p>
          <p style={{ color: '#F0F0FF', fontSize: '14px', lineHeight: 1.5, marginBottom: '16px' }}>{message}</p>

          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '6px' }}>
            Give this reference to support — save it now:
          </p>
          <button
            onClick={handleCopyRef}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '12px',
              padding: '12px 14px',
              cursor: 'pointer',
            }}
          >
            <span style={{ color: '#F0F0FF', fontSize: '14px', fontFamily: 'monospace', wordBreak: 'break-all', textAlign: 'left' }}>
              {reference}
            </span>
            {copied ? <Check size={18} color="#10B981" style={{ flexShrink: 0, marginLeft: '8px' }} /> : <Copy size={18} color="#8B8FA8" style={{ flexShrink: 0, marginLeft: '8px' }} />}
          </button>
        </div>
      </div>

      <div style={{ padding: '0 16px 24px', marginTop: 'auto' }}>
        <button
          onClick={onGoHome}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
            color: '#fff',
            fontSize: '15px',
            fontWeight: 700,
            padding: '16px',
            borderRadius: '14px',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <Home size={18} />
          Back to Home
        </button>
      </div>
    </div>
  );
}
