import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ScanLine, CheckCircle, XCircle, Camera, Shield } from 'lucide-react';
import { insforge } from '../../lib/insforge';
import { Event } from './types';

// html5-qrcode is loaded dynamically to avoid SSR issues
type ScanResult = 'idle' | 'scanning' | 'valid' | 'already_used' | 'invalid' | 'wrong_event';

interface CheckinScannerScreenProps {
  onBack: () => void;
  currentUser: any;
  selectedEvent?: Event | null;
}

interface CheckinState {
  status: ScanResult;
  holderName?: string;
  ticketType?: string;
  checkinTime?: string;
  errorMsg?: string;
}

export function CheckinScannerScreen({ onBack, currentUser, selectedEvent }: CheckinScannerScreenProps) {
  const [state, setState] = useState<CheckinState>({ status: 'idle' });
  const [stats, setStats] = useState({ checkedIn: 0, total: 0 });
  const [scannerReady, setScannerReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<any>(null);
  const scannerDivId = 'vents-qr-scanner';
  const processingRef = useRef(false);

  // Access guard
  const isOrganizer = currentUser?.role === 'organizer' || currentUser?.role === 'admin';

  // Load check-in stats
  const loadStats = async () => {
    if (!selectedEvent?.id) return;
    try {
      const { count: checkedCount } = await insforge.database
        .from('checkins')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', selectedEvent.id);

      const { count: totalCount } = await insforge.database
        .from('tickets')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', selectedEvent.id)
        .eq('status', 'active');

      setStats({ checkedIn: checkedCount || 0, total: totalCount || 0 });
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadStats();
  }, [selectedEvent?.id]);

  // Initialise html5-qrcode scanner
  useEffect(() => {
    if (!isOrganizer) return;

    let mounted = true;

    import('html5-qrcode').then(({ Html5QrcodeScanner }) => {
      if (!mounted) return;

      const scanner = new Html5QrcodeScanner(
        scannerDivId,
        {
          fps: 10,
          qrbox: { width: 240, height: 240 },
          aspectRatio: 1.0,
          showTorchButtonIfSupported: true,
          showZoomSliderIfSupported: true,
          defaultZoomValueIfSupported: 2,
        },
        /* verbose */ false,
      );

      scanner.render(
        async (decodedText: string) => {
          if (processingRef.current) return;
          processingRef.current = true;
          await handleScan(decodedText);
          setTimeout(() => { processingRef.current = false; }, 3000);
        },
        (errorMessage: string) => {
          // QR scan errors are expected (camera looking for QR) — suppress
          if (!errorMessage.includes('No MultiFormat Readers')) {
            setCameraError(errorMessage);
          }
        },
      );

      scannerRef.current = scanner;
      setScannerReady(true);
    }).catch(err => {
      setCameraError('Could not load scanner: ' + err.message);
    });

    return () => {
      mounted = false;
      if (scannerRef.current) {
        scannerRef.current.clear().catch(() => {});
      }
    };
  }, [isOrganizer]);

  const handleScan = async (ticketId: string) => {
    setState({ status: 'scanning' });

    try {
      // 1. Fetch the ticket
      const { data: ticket, error: ticketErr } = await insforge.database
        .from('tickets')
        .select('id, event_id, user_id, status, quantity, users(full_name)')
        .eq('id', ticketId)
        .maybeSingle();

      if (ticketErr || !ticket) {
        setState({ status: 'invalid', errorMsg: 'Ticket not found in system.' });
        return;
      }

      if (ticket.status !== 'active') {
        setState({ status: 'invalid', errorMsg: 'This ticket has been cancelled.' });
        return;
      }

      // 2. Check it belongs to the right event
      if (selectedEvent && ticket.event_id !== selectedEvent.id) {
        setState({ status: 'wrong_event', errorMsg: 'This ticket is for a different event.' });
        return;
      }

      // 3. Check for existing check-in
      const { data: existing } = await insforge.database
        .from('checkins')
        .select('id, checked_in_at')
        .eq('ticket_id', ticketId)
        .maybeSingle();

      if (existing) {
        const time = new Date(existing.checked_in_at).toLocaleTimeString('en-NG', { timeStyle: 'short' });
        setState({
          status: 'already_used',
          errorMsg: `Already checked in at ${time}`,
          holderName: (ticket as any).users?.full_name || 'Unknown',
        });
        return;
      }

      // 4. Insert check-in
      const { error: insertErr } = await insforge.database
        .from('checkins')
        .insert([{
          ticket_id: ticketId,
          event_id: ticket.event_id,
          scanned_by: currentUser.id,
        }]);

      if (insertErr) throw insertErr;

      setState({
        status: 'valid',
        holderName: (ticket as any).users?.full_name || 'Verified Attendee',
        checkinTime: new Date().toLocaleTimeString('en-NG', { timeStyle: 'short' }),
      });

      // Refresh stats
      loadStats();

    } catch (err: any) {
      setState({ status: 'invalid', errorMsg: err?.message || 'Database error. Try again.' });
    }

    // Auto-reset after 3 seconds
    setTimeout(() => setState({ status: 'idle' }), 3000);
  };

  // ── Access denied ────────────────────────────────────────────────────────────
  if (!isOrganizer) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
        <Shield size={48} color="#EF4444" style={{ marginBottom: '16px' }} />
        <h2 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800 }}>Organizers Only</h2>
        <p style={{ color: '#8B8FA8', fontSize: '13px', marginTop: '8px', lineHeight: 1.6 }}>
          The check-in scanner is only accessible to event organizers.
        </p>
        <button onClick={onBack} style={{ marginTop: '24px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', borderRadius: '12px', padding: '12px 28px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}>
          Go Back
        </button>
      </div>
    );
  }

  // ── Result overlay colour ────────────────────────────────────────────────────
  const overlayConfig: Record<string, { bg: string; border: string; icon: React.ReactNode; headline: string }> = {
    valid: {
      bg: 'rgba(16,185,129,0.15)',
      border: 'rgba(16,185,129,0.4)',
      icon: <CheckCircle size={52} color="#10B981" />,
      headline: '✅ Check-In Successful',
    },
    already_used: {
      bg: 'rgba(245,158,11,0.15)',
      border: 'rgba(245,158,11,0.4)',
      icon: <XCircle size={52} color="#F59E0B" />,
      headline: '⚠️ Already Checked In',
    },
    invalid: {
      bg: 'rgba(239,68,68,0.15)',
      border: 'rgba(239,68,68,0.4)',
      icon: <XCircle size={52} color="#EF4444" />,
      headline: '❌ Invalid Ticket',
    },
    wrong_event: {
      bg: 'rgba(239,68,68,0.15)',
      border: 'rgba(239,68,68,0.4)',
      icon: <XCircle size={52} color="#EF4444" />,
      headline: '❌ Wrong Event',
    },
    scanning: {
      bg: 'rgba(167,139,250,0.15)',
      border: 'rgba(167,139,250,0.4)',
      icon: <ScanLine size={52} color="#A78BFA" />,
      headline: '🔍 Validating…',
    },
  };

  const overlay = overlayConfig[state.status];
  const pct = stats.total > 0 ? Math.round((stats.checkedIn / stats.total) * 100) : 0;

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif', position: 'relative' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 20px 14px', background: '#020005', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <button onClick={onBack} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            Ticket Scanner
          </h1>
          {selectedEvent && (
            <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }} className="truncate">
              {selectedEvent.title}
            </p>
          )}
        </div>
        <Camera size={20} color="#A78BFA" />
      </div>

      {/* ── Stats bar ──────────────────────────────────────────────────────── */}
      <div style={{ padding: '12px 20px', flexShrink: 0 }}>
        <div style={{ background: '#131629', borderRadius: '14px', padding: '12px 16px', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Check-ins</span>
            <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>
              {stats.checkedIn} / {stats.total}
              <span style={{ color: '#A78BFA', marginLeft: '6px' }}>{pct}%</span>
            </span>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '100px', height: '6px', overflow: 'hidden' }}>
            <div style={{ background: 'linear-gradient(90deg,#7B2FBE,#4F46E5)', borderRadius: '100px', height: '100%', width: `${pct}%`, transition: 'width 0.4s ease' }} />
          </div>
        </div>
      </div>

      {/* ── Camera / Scanner area ──────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 24px' }}>
        {cameraError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginTop: '40px', textAlign: 'center' }}>
            <Camera size={40} color="#EF4444" />
            <p style={{ color: '#EF4444', fontSize: '13px', fontWeight: 600 }}>Camera Error</p>
            <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{cameraError}</p>
            <p style={{ color: '#8B8FA8', fontSize: '11px' }}>
              Make sure you have granted camera permission and are using HTTPS.
            </p>
          </div>
        ) : (
          <>
            <p style={{ color: '#8B8FA8', fontSize: '12px', textAlign: 'center', marginBottom: '12px' }}>
              Point the camera at a Vents ticket QR code
            </p>
            {/* html5-qrcode mounts into this div */}
            <div
              id={scannerDivId}
              style={{
                borderRadius: '20px',
                overflow: 'hidden',
                border: '2px solid rgba(167,139,250,0.3)',
                background: '#0A0C1A',
              }}
            />
            {!scannerReady && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '260px', color: '#8B8FA8', fontSize: '13px' }}>
                Initialising camera…
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Result Overlay ─────────────────────────────────────────────────── */}
      {overlay && (
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(6,10,18,0.92)', backdropFilter: 'blur(12px)',
            padding: '24px', textAlign: 'center', zIndex: 50,
          }}
        >
          <div style={{ background: overlay.bg, border: `2px solid ${overlay.border}`, borderRadius: '28px', padding: '40px 32px', maxWidth: '300px', width: '100%' }}>
            {overlay.icon}
            <h2 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, margin: '16px 0 8px' }}>
              {overlay.headline}
            </h2>
            {state.holderName && (
              <p style={{ color: '#A78BFA', fontSize: '16px', fontWeight: 700, margin: '4px 0' }}>
                {state.holderName}
              </p>
            )}
            {state.checkinTime && (
              <p style={{ color: '#8B8FA8', fontSize: '13px', margin: '4px 0' }}>
                Checked in at {state.checkinTime}
              </p>
            )}
            {state.errorMsg && (
              <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '8px 0 0', lineHeight: 1.5 }}>
                {state.errorMsg}
              </p>
            )}
            {state.status !== 'scanning' && (
              <p style={{ color: '#555C7A', fontSize: '11px', margin: '16px 0 0' }}>
                Resuming scanner…
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
