import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Download, Share2, CheckCircle, Calendar, MapPin, Clock } from 'lucide-react';
import QRCode from 'qrcode';
import { PurchasedTicket } from './types';
import { formatPrice } from './data';

interface QRTicketProps {
  ticket: PurchasedTicket;
  onBack: () => void;
  onGoHome: () => void;
}

// ─── Real scannable QR canvas renderer ───────────────────────────────────────
function QRCodeDisplay({ value, size = 180 }: { value: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 2,
      color: { dark: '#0A0B14', light: '#ffffff' },
    }).catch(console.error);
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

  const handleShare = async () => {
    const text = `🏟️ ${ticket.event.title}\n📅 ${ticket.event.date} · ${ticket.event.venue}\n\nMy ticket: ${ticket.ticketId}`;
    if (navigator.share) {
      await navigator.share({ title: ticket.event.title, text }).catch(() => {});
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    }
  };

  const handleSave = () => {
    // Encode ticket details as a data-URI download
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#020005';
    ctx.fillRect(0, 0, 400, 120);
    ctx.fillStyle = '#F0F0FF';
    ctx.font = 'bold 16px Inter, sans-serif';
    ctx.fillText(ticket.event.title, 16, 32);
    ctx.fillStyle = '#8B8FA8';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText(`${ticket.event.date} · ${ticket.event.venue}`, 16, 54);
    ctx.fillText(`Ticket ID: ${ticket.ticketId}`, 16, 76);
    ctx.fillText(`${ticket.ticketType.name} · x${ticket.quantity}`, 16, 98);
    const link = document.createElement('a');
    link.download = `vents-ticket-${ticket.ticketId}.png`;
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
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: '#131629' }}
        >
          <ArrowLeft size={18} color="#F0F0FF" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>My Ticket</h1>
        <button
          onClick={handleShare}
          className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: '#131629' }}>
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

        {/* Ticket card */}
        <div className="px-4">
          <div
            style={{
              background: '#0F1322',
              borderRadius: '24px',
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          >
            {/* Event image header */}
            <div className="relative" style={{ height: '140px' }}>
              <img src={ticket.event.image} alt={ticket.event.title} className="w-full h-full object-cover" />
              <div
                className="absolute inset-0"
                style={{ background: 'linear-gradient(to bottom, rgba(15,19,34,0) 0%, rgba(15,19,34,0.95) 100%)' }}
              />
              <div className="absolute bottom-3 left-4 right-4">
                <h2 style={{ color: '#fff', fontSize: '17px', fontWeight: 800, lineHeight: 1.2 }}>
                  {ticket.event.title}
                </h2>
              </div>
            </div>

            {/* Ticket details */}
            <div className="px-4 py-4">
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Date</p>
                  <div className="flex items-center gap-1.5">
                    <Calendar size={12} color="#A78BFA" />
                    <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{ticket.event.date}</p>
                  </div>
                </div>
                <div>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Time</p>
                  <div className="flex items-center gap-1.5">
                    <Clock size={12} color="#A78BFA" />
                    <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{ticket.event.time}</p>
                  </div>
                </div>
                <div>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Venue</p>
                  <div className="flex items-center gap-1.5">
                    <MapPin size={12} color="#A78BFA" />
                    <p style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 600 }} className="truncate">{ticket.event.venue}</p>
                  </div>
                </div>
                <div>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Type</p>
                  <p style={{ color: '#FFB830', fontSize: '13px', fontWeight: 700 }}>{ticket.ticketType.name}</p>
                </div>
              </div>

              {/* Ticket holder */}
              <div
                className="flex items-center justify-between p-3 mb-4"
                style={{ background: '#161929', borderRadius: '12px' }}
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

              {/* QR Code */}
              <div className="flex flex-col items-center py-2">
                <div
                  className="p-3 mb-3"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    borderRadius: '16px',
                    border: '1px solid rgba(255,255,255,0.07)',
                  }}
                >
                  <QRCodeDisplay value={JSON.stringify({ ticketId: ticket.ticketId, eventId: (ticket as any).eventId, userId: (ticket as any).userId, v: 1 })} size={170} />
                </div>
                <p style={{ color: '#A78BFA', fontSize: '16px', fontWeight: 700, letterSpacing: '0.08em' }}>
                  {ticket.ticketId}
                </p>
                <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '2px' }}>
                  Show this QR code at the entrance
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Total paid */}
        <div className="px-4 mt-4">
          <div
            className="flex items-center justify-between p-4"
            style={{ background: '#131629', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)' }}
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
              background: '#131629',
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
