import { useEffect, useRef, useState } from 'react';
import { CheckCircle, Download, Share2, Home, Calendar, MapPin, Ticket } from 'lucide-react';
import { PurchasedTicket } from './types';
import { formatPrice } from './data';
import confetti from 'canvas-confetti';
import QRCodeLib from 'qrcode';

interface PaymentSuccessScreenProps {
  ticket: PurchasedTicket;
  onViewTickets: () => void;
  onGoHome: () => void;
}

function QRCode({ value, size = 160 }: { value: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    QRCodeLib.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 1,
      color: { dark: '#0A0A0F', light: '#ffffff' },
    });
  }, [value, size]);
  return <canvas ref={canvasRef} style={{ display: 'block', borderRadius: '8px' }} />;
}

export function PaymentSuccessScreen({ ticket, onViewTickets, onGoHome }: PaymentSuccessScreenProps) {
  const firedRef = useRef(false);
  const [saveToast, setSaveToast] = useState(false);
  const [shareToast, setShareToast] = useState(false);

  const handleSave = () => {
    const content = [
      `VENTS TICKET`,
      `Event: ${ticket.event.title}`,
      `Date: ${ticket.event.date} at ${ticket.event.time}`,
      `Venue: ${ticket.event.venue}, ${ticket.event.city}`,
      `Ticket: ${ticket.ticketType.name} × ${ticket.quantity}`,
      `Amount: ₦${ticket.totalAmount.toLocaleString()}`,
      `Booking ID: ${ticket.ticketId}`,
      `Holder: ${ticket.holderName}`,
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ticket.ticketId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setSaveToast(true);
    setTimeout(() => setSaveToast(false), 2500);
  };

  const handleShare = async () => {
    const eventUrl = `https://getvents.com/?event=${ticket.event.id}`;
    const text = `🎟️ I just booked "${ticket.event.title}" on VENTS!\n📅 ${ticket.event.date} | 📍 ${ticket.event.venue}, ${ticket.event.city}\nBooking ID: ${ticket.ticketId}\n${eventUrl}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'My VENTS Ticket', text, url: eventUrl });
      } catch {
        // user cancelled
      }
    } else {
      await navigator.clipboard.writeText(text);
      setShareToast(true);
      setTimeout(() => setShareToast(false), 2500);
    }
  };

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    const colors = ['#7C3AED', '#A855F7', '#4F46E5', '#D946EF', '#FFB830'];
    confetti({
      particleCount: 120,
      spread: 80,
      origin: { y: 0.4 },
      colors,
    });
    setTimeout(() => {
      confetti({ particleCount: 60, spread: 50, origin: { y: 0.5, x: 0.2 }, colors });
      confetti({ particleCount: 60, spread: 50, origin: { y: 0.5, x: 0.8 }, colors });
    }, 400);
  }, []);

  const purchaseDate = new Date(ticket.purchasedAt).toLocaleDateString('en-NG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

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
      {/* Success header */}
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
            background: 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05))',
            border: '2px solid rgba(16,185,129,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
            boxShadow: '0 0 32px rgba(16,185,129,0.25)',
          }}
        >
          <CheckCircle size={36} color="#10B981" fill="rgba(16,185,129,0.15)" />
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
          Booking Confirmed!
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.5 }}>
          Your ticket & booking code have been sent to your email. Show the QR code at the gate.
        </p>
      </div>

      {/* Ticket card */}
      <div style={{ padding: '0 16px 24px' }}>
        <div
          style={{
            background: '#090514',
            borderRadius: '24px',
            border: '1px solid rgba(255,255,255,0.08)',
            overflow: 'hidden',
          }}
        >
          {/* Event image header */}
          <div style={{ position: 'relative', height: '120px' }}>
            <img
              src={ticket.event.image}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(to bottom, rgba(19,22,41,0.1), rgba(19,22,41,0.85))',
              }}
            />
            <div style={{ position: 'absolute', bottom: '12px', left: '16px' }}>
              <span
                style={{
                  background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
                  color: '#fff',
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '3px 10px',
                  borderRadius: '6px',
                  letterSpacing: '0.05em',
                }}
              >
                {ticket.ticketType.name.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Ticket details */}
          <div style={{ padding: '16px' }}>
            <h2
              style={{
                color: '#F0F0FF',
                fontSize: '17px',
                fontWeight: 700,
                marginBottom: '10px',
              }}
            >
              {ticket.event.title}
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
              {[
                { icon: Calendar, text: `${ticket.event.date} · ${ticket.event.time}` },
                { icon: MapPin, text: `${ticket.event.venue}, ${ticket.event.city}` },
                {
                  icon: Ticket,
                  text: `${ticket.quantity} × ${ticket.ticketType.name} · ${formatPrice(ticket.totalAmount)}`,
                },
              ].map(({ icon: Icon, text }) => (
                <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Icon size={13} color="#8B8FA8" />
                  <span style={{ color: '#C4C9E0', fontSize: '12px' }}>{text}</span>
                </div>
              ))}
            </div>

            {/* Tear line */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                margin: '4px -16px',
                position: 'relative',
              }}
            >
              <div
                style={{
                  width: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  background: '#020005',
                  flexShrink: 0,
                }}
              />
              <div
                style={{
                  flex: 1,
                  height: '1px',
                  borderTop: '2px dashed rgba(255,255,255,0.1)',
                }}
              />
              <div
                style={{
                  width: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  background: '#020005',
                  flexShrink: 0,
                }}
              />
            </div>

            {/* QR section */}
            <div style={{ padding: '16px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  background: '#fff',
                  borderRadius: '16px',
                  padding: '12px',
                  boxShadow: '0 0 40px rgba(168,85,247,0.2)',
                }}
              >
                <QRCode value={JSON.stringify({ ticketId: ticket.ticketId, eventId: (ticket as any).eventId, userId: (ticket as any).userId, v: 1 })} size={140} />
              </div>
              <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, letterSpacing: '0.08em' }}>
                {ticket.ticketId}
              </p>
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>
                Holder: {ticket.holderName} · {purchaseDate}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Toast notifications */}
      {saveToast && (
        <div style={{ position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)', background: '#10B981', borderRadius: '12px', padding: '10px 18px', zIndex: 99, whiteSpace: 'nowrap' }}>
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>✓ Ticket saved to downloads</span>
        </div>
      )}
      {shareToast && (
        <div style={{ position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)', background: '#7B2FBE', borderRadius: '12px', padding: '10px 18px', zIndex: 99, whiteSpace: 'nowrap' }}>
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>✓ Copied to clipboard!</span>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ padding: '0 16px 32px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handleSave}
            style={{
              flex: 1,
              background: '#090514',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '14px',
              padding: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '7px',
              cursor: 'pointer',
            }}
          >
            <Download size={16} color="#A78BFA" />
            <span style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 600 }}>Save</span>
          </button>
          <button
            onClick={handleShare}
            style={{
              flex: 1,
              background: '#090514',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '14px',
              padding: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '7px',
              cursor: 'pointer',
            }}
          >
            <Share2 size={16} color="#A78BFA" />
            <span style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 600 }}>Share</span>
          </button>
        </div>

        <button
          onClick={onViewTickets}
          style={{
            width: '100%',
            background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '16px',
            padding: '15px',
            color: '#fff',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: 'pointer',
            boxShadow: '0 6px 24px rgba(123,47,190,0.4)',
          }}
        >
          View My Tickets
        </button>

        <button
          onClick={onGoHome}
          style={{
            width: '100%',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '16px',
            padding: '13px',
            color: 'rgba(255,255,255,0.6)',
            fontSize: '15px',
            fontWeight: 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
          }}
        >
          <Home size={15} />
          Back to Home
        </button>
      </div>
    </div>
  );
}
