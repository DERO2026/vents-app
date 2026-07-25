import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Download, Share2, CheckCircle, MapPin, Clock, Zap } from 'lucide-react';
import QRCode from 'qrcode';
import { PurchasedTicket } from './types';
import { formatPrice } from './data';
import { useSignedTicketToken } from '../../lib/ticketToken';
import { analytics } from '../../lib/analyticsEvents';

interface QRTicketProps {
  ticket: PurchasedTicket;
  onBack: () => void;
  onGoHome: () => void;
}

// ─── Real scannable QR canvas renderer ───────────────────────────────────────
// v2 signed tokens are much longer than the old bare UUID, which pushes the
// QR to a denser module grid. Low error correction ('L') avoids adding
// redundant blocks on top of that density — fine here since this is shown on
// a clean, backlit phone screen, not printed on paper that could get
// scuffed. A larger render size and a wide quiet zone (margin, in modules)
// keep the individual modules large and cleanly separated from the app's
// dark-mode background so a phone camera can actually focus and lock on.
function QRCodeDisplay({ value, size = 280 }: { value: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Remember the last value drawn so a parent re-render (unrelated state) never
  // re-encodes an identical QR — the encode + canvas paint only runs when the
  // token actually changes.
  const drawnRef = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || drawnRef.current === value) return;
    QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 4,
      errorCorrectionLevel: 'L',
      color: { dark: '#0A0B14', light: '#ffffff' },
    })
      .then(() => { drawnRef.current = value; })
      .catch(console.error);
  }, [value, size]);

  return (
    <div
      style={{
        width: size,
        height: size,
        background: '#fff',
        borderRadius: '12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}


export function QRTicket({ ticket, onBack, onGoHome }: QRTicketProps) {
  const [showConfetti] = useState(true);
  const ticketCardRef = useRef<HTMLDivElement>(null);
  const signedToken = useSignedTicketToken(ticket.ticketId, ticket.token);
  const timestamp = `${ticket.event.date} · ${ticket.event.time}`;

  // Track when a holder opens their ticket QR (fires once per open).
  useEffect(() => {
    if (ticket.event?.id) analytics.ticketQrViewed(ticket.event.id);
  }, [ticket.event?.id]);

  const handleShare = async () => {
    // Never include the raw ticket_id — only the signed token is ever a
    // valid entry credential, and it isn't meant to be typed/forwarded as
    // text anyway. Share plain event details instead.
    const text = `🏟️ ${ticket.event.title}\n📅 ${ticket.event.date} · ${ticket.event.venue}\n\nSee you there!`;
    if (navigator.share) {
      await navigator.share({ title: ticket.event.title, text }).catch(() => {});
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    }
  };

  const handleSave = () => {
    // Encode ticket details as a data-URI download. Deliberately does NOT
    // include the raw ticket_id or the signed token as text — the token is
    // only meaningful as the QR image already rendered on this screen.
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 100;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#020005';
    ctx.fillRect(0, 0, 400, 100);
    ctx.fillStyle = '#F0F0FF';
    ctx.font = 'bold 16px Inter, sans-serif';
    ctx.fillText(ticket.event.title, 16, 32);
    ctx.fillStyle = '#8B8FA8';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText(`${ticket.event.date} · ${ticket.event.venue}`, 16, 54);
    ctx.fillText(`${ticket.ticketType.name} · x${ticket.quantity}`, 16, 76);
    const link = document.createElement('a');
    link.download = `vents-ticket-${Date.now()}.png`;
    link.href = canvas.toDataURL();
    link.click();
  };

  return (
    <div className="flex flex-col h-full" style={{ background: '#020005' }}>
      {/* Header */}
      <div 
        className="flex items-center justify-between px-4 pb-4"
        style={{ paddingTop: 'calc(14px + env(safe-area-inset-top))' }}
      >
        <button
          onClick={onBack}
          className="w-11 h-11 rounded-full flex items-center justify-center"
          style={{ background: '#090514' }}
        >
          <ArrowLeft size={18} color="#F0F0FF" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>My Ticket</h1>
        <button
          onClick={handleShare}
          className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: '#090514' }}>
          <Share2 size={16} color="#F0F0FF" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-24" style={{ scrollbarWidth: 'none' }}>
        {/* Success banner */}
        <div className="px-4 mb-5">
          <div
            className="flex items-center gap-3 p-4"
            style={{
              background: 'rgba(34, 197, 94, 0.1)',
              borderRadius: '14px',
              border: '1px solid rgba(34, 197, 94, 0.25)',
            }}
          >
            <CheckCircle size={22} color="#22C55E" />
            <div>
              <p style={{ color: '#22C55E', fontSize: '14px', fontWeight: 700 }}>Booking Confirmed!</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Your ticket has been sent to your email</p>
            </div>
          </div>
        </div>

        {/* Ticket card — "Midnight Neon" digital pass */}
        <div className="px-4">
          <div
            style={{
              background: 'linear-gradient(135deg, #7B2FBE, #4F46E5, #22D3EE)',
              borderRadius: '26px',
              padding: '1.5px',
              boxShadow: '0 0 40px rgba(123,47,190,0.35), 0 20px 60px rgba(0,0,0,0.55)',
            }}
          >
            <div
              style={{
                background: '#07030F',
                borderRadius: '24.5px',
                overflow: 'hidden',
              }}
            >
              {/* Event image header */}
              <div className="relative" style={{ height: '140px' }}>
                <img src={ticket.event.image} alt={ticket.event.title} className="w-full h-full object-cover" />
                <div
                  className="absolute inset-0"
                  style={{ background: 'linear-gradient(to bottom, rgba(7,3,15,0) 0%, rgba(7,3,15,0.97) 100%)' }}
                />
                <div className="absolute bottom-3 left-4 right-4">
                  <h2 style={{ color: '#fff', fontSize: '18px', fontWeight: 800, lineHeight: 1.2, textShadow: '0 0 20px rgba(167,139,250,0.6)' }}>
                    {ticket.event.title}
                  </h2>
                </div>
              </div>

              {/* Ticket details */}
              <div className="px-4 py-4">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Clock size={13} color="#22D3EE" />
                    <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }} className="truncate">{timestamp}</p>
                  </div>
                  <span
                    style={{
                      color: '#FFB830', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
                      background: 'rgba(255,184,48,0.12)', border: '1px solid rgba(255,184,48,0.4)', borderRadius: '100px',
                      padding: '4px 12px', flexShrink: 0, boxShadow: '0 0 14px rgba(255,184,48,0.25)',
                    }}
                  >
                    {ticket.ticketType.name}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 mb-4">
                  <MapPin size={12} color="#A78BFA" />
                  <p style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 500 }} className="truncate">{ticket.event.venue}</p>
                </div>

                {/* Ticket holder */}
                <div
                  className="flex items-center justify-between p-3 mb-4"
                  style={{ background: 'rgba(123,47,190,0.08)', borderRadius: '12px', border: '1px solid rgba(123,47,190,0.15)' }}
                >
                  <div>
                    <p style={{ color: '#8B8FA8', fontSize: '11px' }}>Ticket Holder</p>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{ticket.holderName}</p>
                  </div>
                  <div className="text-right">
                    <p style={{ color: '#8B8FA8', fontSize: '11px' }}>Qty</p>
                    <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>×{ticket.quantity}</p>
                  </div>
                </div>

                {/* Tear line */}
                <div className="relative flex items-center my-4">
                  <div
                    className="absolute -left-8 w-8 h-8 rounded-full"
                    style={{ background: '#020005' }}
                  />
                  <div
                    className="flex-1 border-t-2 border-dashed"
                    style={{ borderColor: 'rgba(255,255,255,0.1)' }}
                  />
                  <div
                    className="absolute -right-8 w-8 h-8 rounded-full"
                    style={{ background: '#020005' }}
                  />
                </div>

                {/* QR Code — only ever renders once a signed token exists.
                    A bare ticket_id is no longer a valid credential (the
                    scanner strictly rejects it), so there is nothing safe
                    to show until the signed token is ready. */}
                <div className="flex flex-col items-center py-2">
                  <div
                    className="p-3 mb-3 flex items-center justify-center"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      borderRadius: '16px',
                      border: '1px solid rgba(34,211,238,0.25)',
                      boxShadow: '0 0 24px rgba(34,211,238,0.15)',
                      width: '280px',
                      height: '280px',
                      boxSizing: 'border-box',
                    }}
                  >
                    {signedToken
                      ? <QRCodeDisplay value={signedToken} size={280} />
                      : <p style={{ color: '#8B8FA8', fontSize: '12px', textAlign: 'center', padding: '0 12px' }}>Generating secure pass…</p>}
                  </div>
                  <div className="flex items-center gap-1.5" style={{ marginTop: '4px' }}>
                    <Zap size={11} color={signedToken ? '#22D3EE' : '#555C7A'} />
                    <p style={{ color: signedToken ? '#22D3EE' : '#8B8FA8', fontSize: '10px', fontWeight: 600 }}>
                      {signedToken ? 'Cryptographically signed — show this QR code at the entrance' : 'Connect to the internet once to activate this ticket'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Total paid */}
        <div className="px-4 mt-4">
          <div
            className="flex items-center justify-between p-4"
            style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)' }}
          >
            <span style={{ color: '#8B8FA8', fontSize: '14px' }}>Total Paid</span>
            <span style={{ color: '#22C55E', fontSize: '18px', fontWeight: 800 }}>
              {formatPrice(ticket.totalAmount)}
            </span>
          </div>
        </div>
      </div>

      {/* Bottom actions */}
      <div
        className="absolute bottom-0 left-0 right-0 px-4 pb-6 pt-3"
        style={{ background: 'linear-gradient(to top, #020005 70%, transparent)' }}
      >
        <div className="flex gap-3">
          <button
            onClick={handleSave}
            className="flex-1 flex items-center justify-center gap-2"
            style={{
              height: '50px',
              background: '#090514',
              borderRadius: '14px',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <Download size={16} color="#A78BFA" />
            <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 600 }}>Save Ticket</span>
          </button>
          <button
            onClick={onGoHome}
            className="flex-1 flex items-center justify-center"
            style={{
              height: '50px',
              background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
              borderRadius: '14px',
              boxShadow: '0 4px 16px rgba(123,47,190,0.4)',
            }}
          >
            <span style={{ color: '#fff', fontSize: '14px', fontWeight: 700 }}>Back to Home</span>
          </button>
        </div>
      </div>
    </div>
  );
}
