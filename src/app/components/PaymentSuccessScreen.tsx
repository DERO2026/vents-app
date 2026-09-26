import { useEffect, useRef, useState } from 'react';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { CheckCircle, Download, Share2, Home, Calendar, MapPin, Ticket, Send, AlertCircle, X } from 'lucide-react';
import { PurchasedTicket } from './types';
import { ticketDisplayCode } from '../../lib/ticketCode';
import { formatPrice } from './data';
import confetti from 'canvas-confetti';
import QRCodeLib from 'qrcode';
import { useSignedTicketToken } from '../../lib/ticketToken';
import { renderTicketImage, saveTicketToGallery } from '../../lib/ticketImage';
import { Capacitor } from '@capacitor/core';
import { shareLink } from '../../lib/shareLink';
import { Sentry } from '../../lib/sentry';
import { TOAST_TOP_POSITION } from './shared/toastPosition';
import { supabase } from '../../lib/supabase';
import { UserAutocomplete } from './shared/UserAutocomplete';

interface PaymentSuccessScreenProps {
  ticket: PurchasedTicket;
  onViewTickets: () => void;
  onGoHome: () => void;
}

// Client-side mirror of initiate_ticket_transfer's own eligibility checks
// (0040_ticket_transfer.sql) -- purely for the UI gate; the RPC re-validates
// everything server-side regardless, so this can never be relied on as the
// actual security boundary.
function isTransferEligible(ticket: PurchasedTicket): boolean {
  if (ticket.checkedIn) return false;
  const eventDate = ticket.event.event_date ? new Date(ticket.event.event_date) : null;
  if (eventDate && eventDate.getTime() < Date.now()) return false;
  return true;
}

// v2 signed tokens are much longer than the old bare UUID, which pushes the
// QR to a denser module grid. Low error correction ('L') avoids adding
// redundant blocks on top of that density — fine here since this is shown on
// a clean, backlit phone screen, not printed on paper that could get
// scuffed. A larger render size and a wide quiet zone (margin, in modules)
// keep the individual modules large and cleanly separated from the app's
// dark-mode background so a phone camera can actually focus and lock on.
function QRCode({ value, size = 280 }: { value: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    QRCodeLib.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 4,
      errorCorrectionLevel: 'L',
      color: { dark: ventsColors.bg, light: ventsColors.white },
    });
  }, [value, size]);
  return <canvas ref={canvasRef} style={{ display: 'block', borderRadius: '8px' }} />;
}

export function PaymentSuccessScreen({ ticket, onViewTickets, onGoHome }: PaymentSuccessScreenProps) {
  const firedRef = useRef(false);
  const [saveToast, setSaveToast] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [shareToast, setShareToast] = useState(false);
  // Guards the toast setTimeouts below — "View My Tickets"/"Back to Home" can
  // navigate away immediately after a save/share action, and without this the
  // timeouts would call setState on an unmounted component.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // The gate scanner accepts ONLY a signed v2 pass token — a raw id/JSON blob
  // is rejected as "missing cryptographic signature". Mint the same signed
  // token QRTicket uses so this post-purchase QR is scannable too.
  const signedToken = useSignedTicketToken(ticket.ticketId, ticket.token);

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    // Was downloading a plain .txt receipt with no QR — replaced with a real
    // ticket image (title, date/venue, ticket type, and the actual scannable
    // QR) so what's saved is something the user can actually show at a gate.
    // Same gap as QRTicket.tsx: without a signed token, ticketImage.ts
    // falls back to a text placeholder instead of a real QR — the saved
    // image looks like a ticket but has no scannable code.
    if (saving || !signedToken) return;
    setSaving(true);
    try {
      const blob = await renderTicketImage({
        title: ticket.event.title,
        dateTimeLabel: `${ticket.event.date} · ${ticket.event.time}`,
        venue: `${ticket.event.venue}, ${ticket.event.city}`,
        ticketTypeLabel: `${ticket.ticketType.name} · x${ticket.quantity}`,
        holderName: ticket.holderName,
        referenceNumber: ticketDisplayCode(ticket.ticketId),
        signedToken,
        eventImage: ticket.event.image,
        organizer: ticket.event.organizer,
      });
      if (!blob) throw new Error('Failed to render ticket image');
      const result = await saveTicketToGallery(blob, `vents-ticket-${ticket.ticketId}.png`);
      if (!mountedRef.current) return;
      if (result === 'saved') {
        setSaveToast(true);
        setTimeout(() => { if (mountedRef.current) setSaveToast(false); }, 2500);
      } else {
        setSaveError(true);
        setTimeout(() => { if (mountedRef.current) setSaveError(false); }, 3000);
      }
    } catch (err) {
      console.error('Failed to save ticket image:', err);
      Sentry.captureException(err);
      if (mountedRef.current) {
        setSaveError(true);
        setTimeout(() => { if (mountedRef.current) setSaveError(false); }, 3000);
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const handleShare = async () => {
    const eventUrl = `https://getvents.com/?event=${ticket.event.id}`;
    const text = `🎟️ I just booked "${ticket.event.title}" on VENTS!\n📅 ${ticket.event.date} | 📍 ${ticket.event.venue}, ${ticket.event.city}\nTicket Reference: ${ticketDisplayCode(ticket.ticketId)}\n${eventUrl}`;
    const result = await shareLink({ title: 'My VENTS Ticket', text, url: eventUrl });
    if (result === 'copied' && mountedRef.current) {
      setShareToast(true);
      setTimeout(() => { if (mountedRef.current) setShareToast(false); }, 2500);
    }
  };

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    const colors = [ventsColors.accent, ventsColors.accent, ventsColors.accent, ventsColors.accentSoft, ventsColors.pending];
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

  // Transfer flow -- initiate_ticket_transfer does every real eligibility/
  // ownership/recipient check server-side; this just collects the
  // recipient identifier and surfaces the RPC's own error message.
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferIdentifier, setTransferIdentifier] = useState('');
  const [transferSending, setTransferSending] = useState(false);
  const [transferError, setTransferError] = useState('');
  const [transferSent, setTransferSent] = useState(false);

  const handleSendTransfer = async () => {
    const identifier = transferIdentifier.trim();
    if (!identifier) { setTransferError('Enter the recipient\'s email or username'); return; }
    setTransferSending(true);
    setTransferError('');
    try {
      const { error } = await supabase.rpc('initiate_ticket_transfer', {
        p_ticket_id: ticket.ticketId,
        p_recipient_identifier: identifier,
      });
      if (error) throw new Error(error.message);
      setTransferSent(true);
      setTransferIdentifier('');
    } catch (e: any) {
      setTransferError(e?.message || 'Could not start the transfer. Please try again.');
    } finally {
      setTransferSending(false);
    }
  };

  const closeTransferModal = () => {
    setShowTransfer(false);
    setTransferError('');
    setTransferSent(false);
    setTransferIdentifier('');
  };

  const purchaseDate = new Date(ticket.purchasedAt).toLocaleDateString('en-NG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <div
      style={{
        background: ventsColors.bg,
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
            width: '84px',
            height: '84px',
            borderRadius: '50%',
            background: 'rgba(52,211,153,0.14)',
            border: '1px solid rgba(52,211,153,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <CheckCircle size={40} color="#34D399" fill="rgba(52,211,153,0.15)" />
        </div>
        <h1
          style={{
            color: ventsColors.ink1,
            fontSize: '27px',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            fontFamily: 'Manrope, sans-serif',
            marginBottom: '6px',
          }}
        >
          Booking Confirmed!
        </h1>
        <p style={{ color: ventsColors.ink2, fontSize: '14px', lineHeight: 1.5 }}>
          Your ticket & booking code have been sent to your email. Show the QR code at the gate.
        </p>
      </div>

      {/* Ticket card */}
      <div style={{ padding: '0 16px 24px' }}>
        <div
          style={{
            background: ventsColors.surface,
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
                color: ventsColors.ink1,
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
                  <Icon size={13} color={ventsColors.ink2} />
                  <span style={{ color: ventsColors.ink2, fontSize: '12px' }}>{text}</span>
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
                  background: ventsColors.bg,
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
                  background: ventsColors.bg,
                  flexShrink: 0,
                }}
              />
            </div>

            {/* QR section */}
            <div style={{ padding: '16px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  background: '#EDEAF5',
                  borderRadius: '16px',
                  padding: '12px',
                  boxShadow: '0 0 40px rgba(168,85,247,0.2)',
                  width: '304px',
                  height: '304px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxSizing: 'border-box',
                }}
              >
                {/* The pass is generated server-side WITH the purchase and seeded
                    into the offline cache before this screen mounts, so the QR is
                    drawn on the first paint. This branch is only reachable if the
                    device lost connectivity at the exact moment of purchase — be
                    honest and actionable rather than spinning on "Generating…". */}
                {signedToken
                  ? <QRCode value={signedToken} size={280} />
                  : (
                    <span style={{ color: ventsColors.ink2, fontSize: '12px', textAlign: 'center', padding: '0 16px', lineHeight: 1.5 }}>
                      Your ticket is confirmed and saved.<br />
                      Open <strong style={{ color: ventsColors.accentSoft }}>My Tickets</strong> once you're back online to load your QR code.
                    </span>
                  )}
              </div>
              <p style={{ color: ventsColors.ink2, fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '2px' }}>
                Ticket Reference Number
              </p>
              <p style={{ color: ventsColors.ink1, fontSize: '16px', fontWeight: 700, letterSpacing: '0.08em' }}>
                {ticketDisplayCode(ticket.ticketId)}
              </p>
              <p style={{ color: ventsColors.ink2, fontSize: '12px' }}>
                Holder: {ticket.holderName} · {purchaseDate}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Toast notifications */}
      {saveToast && (
        <div style={{ ...TOAST_TOP_POSITION, background: ventsColors.success, borderRadius: '12px', padding: '10px 18px' }}>
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>
            ✓ {Capacitor.getPlatform() === 'ios' ? 'Ticket saved to Photos!' : Capacitor.isNativePlatform() ? 'Ticket saved to Gallery!' : 'Ticket saved!'}
          </span>
        </div>
      )}
      {saveError && (
        <div style={{ ...TOAST_TOP_POSITION, background: ventsColors.error, borderRadius: '12px', padding: '10px 18px' }}>
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>Couldn't save ticket — please try again</span>
        </div>
      )}
      {shareToast && (
        <div style={{ ...TOAST_TOP_POSITION, background: ventsColors.accent, borderRadius: '12px', padding: '10px 18px' }}>
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>✓ Copied to clipboard!</span>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ padding: '0 16px 32px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handleSave}
            disabled={saving || !signedToken}
            style={{
              flex: 1,
              background: ventsColors.surface,
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '14px',
              padding: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '7px',
              cursor: (saving || !signedToken) ? 'not-allowed' : 'pointer',
              opacity: (saving || !signedToken) ? 0.6 : 1,
            }}
          >
            <Download size={16} color={ventsColors.accentSoft} />
            <span style={{ color: ventsColors.accentSoft, fontSize: '13px', fontWeight: 600 }}>{saving ? 'Saving…' : !signedToken ? 'Connecting…' : 'Save'}</span>
          </button>
          <button
            onClick={handleShare}
            style={{
              flex: 1,
              background: ventsColors.surface,
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
            <Share2 size={16} color={ventsColors.accentSoft} />
            <span style={{ color: ventsColors.accentSoft, fontSize: '13px', fontWeight: 600 }}>Share</span>
          </button>
        </div>

        {isTransferEligible(ticket) && (
          <button
            onClick={() => setShowTransfer(true)}
            style={{
              width: '100%',
              background: ventsColors.surface,
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
            <Send size={16} color={ventsColors.accentSoft} />
            <span style={{ color: ventsColors.accentSoft, fontSize: '13px', fontWeight: 600 }}>Transfer Ticket</span>
          </button>
        )}

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
            fontFamily: 'Manrope, sans-serif',
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

      {showTransfer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
          <div style={{ background: ventsColors.surface, borderRadius: '20px', padding: '24px', width: '100%', maxWidth: '360px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <p style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: ventsColors.ink1 }}>Transfer Ticket</p>
              <button onClick={closeTransferModal} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: ventsColors.ink2 }}>
                <X size={18} />
              </button>
            </div>

            {transferSent ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '12px', padding: '14px 16px', margin: '16px 0' }}>
                  <CheckCircle size={18} color={ventsColors.success} />
                  <span style={{ color: ventsColors.success, fontSize: '13px', lineHeight: 1.5 }}>
                    Transfer request sent. They have 48 hours to accept it from their own My Tickets — this ticket stays yours until then.
                  </span>
                </div>
                <button onClick={closeTransferModal} style={{ width: '100%', background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
                  Done
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: '13px', color: ventsColors.ink2, margin: '0 0 18px', lineHeight: 1.5 }}>
                  Enter the VENTS email or username of the person you're transferring this ticket to. They must already have a VENTS account. The request expires in 48 hours if not accepted.
                </p>
                <div style={{ marginBottom: '12px' }}>
                  <UserAutocomplete
                    label="Recipient"
                    placeholder="Recipient email or username"
                    value={transferIdentifier}
                    onChange={setTransferIdentifier}
                    onSelect={() => setTransferError('')}
                  />
                </div>
                {transferError && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
                    <AlertCircle size={14} color={ventsColors.error} />
                    <span style={{ color: ventsColors.error, fontSize: '13px' }}>{transferError}</span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={closeTransferModal} style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '12px', padding: '14px', color: ventsColors.ink2, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                  <button
                    onClick={handleSendTransfer}
                    disabled={transferSending || !transferIdentifier.trim()}
                    style={{ flex: 1, background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontWeight: 700, cursor: (transferSending || !transferIdentifier.trim()) ? 'not-allowed' : 'pointer', opacity: (transferSending || !transferIdentifier.trim()) ? 0.6 : 1 }}
                  >
                    {transferSending ? 'Sending…' : 'Send Request'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
