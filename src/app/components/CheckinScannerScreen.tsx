import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ScanLine, CheckCircle, XCircle, Camera, Shield, FlaskConical } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { Event } from './types';

// html5-qrcode is loaded dynamically to avoid SSR issues
type ScanResult = 'idle' | 'scanning' | 'valid' | 'already_scanned' | 'denied';

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
  originalScannerId?: string;
}

// Web Vibration API — the browser/Capacitor-WebView equivalent of native
// haptics. No-ops silently on platforms without support (e.g. iOS Safari).
function triggerHaptic(kind: 'success' | 'error') {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try { navigator.vibrate(kind === 'success' ? 40 : [30, 60, 30]); } catch { /* ignore */ }
}

export function CheckinScannerScreen({ onBack, currentUser, selectedEvent }: CheckinScannerScreenProps) {
  const [state, setState] = useState<CheckinState>({ status: 'idle' });
  const [stats, setStats] = useState({ checkedIn: 0, total: 0 });
  const [scannerReady, setScannerReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [simulatorInput, setSimulatorInput] = useState('');
  const scannerRef = useRef<any>(null);
  const scannerDivId = 'vents-qr-scanner';
  // Vite's dev-build flag — the web/Capacitor equivalent of React Native's
  // __DEV__. Stripped out of production bundles entirely at build time.
  const isDevEnvironment = import.meta.env.DEV;
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
      // Ensure hc.userToken is set so auth.uid() resolves in RLS/SECURITY
      // DEFINER checks — without this, every scan would look unauthorized.
      await getAuthToken();

      // Single atomic RPC: existence -> relational ownership (403 if the
      // ticket's event isn't this organizer's) -> not-already-checked-in ->
      // atomic checked_in write. No client-side race between separate
      // read/insert round trips, and accepts either a bare ticket_id or an
      // HMAC-signed "id.signature" token straight off the QR.
      const { data, error } = await insforge.database.rpc('verify_entry_pass' as any, {
        p_ticket_id: ticketId,
        p_organizer_id: currentUser.id,
      });

      if (error) throw error;
      const result = data as any;

      if (result?.ok) {
        triggerHaptic('success');
        setState({
          status: 'valid',
          holderName: result.holder_name || 'Verified Attendee',
          ticketType: result.ticket_type || undefined,
          checkinTime: new Date(result.checked_in_at).toLocaleTimeString('en-NG', { timeStyle: 'short' }),
        });
      } else if (result?.reason === 'already_scanned') {
        triggerHaptic('error');
        const time = result.checked_in_at ? new Date(result.checked_in_at).toLocaleTimeString('en-NG', { timeStyle: 'short' }) : 'an earlier time';
        setState({
          status: 'already_scanned',
          errorMsg: `Already scanned at ${time}`,
          checkinTime: result.checked_in_at ? new Date(result.checked_in_at).toLocaleTimeString('en-NG', { timeStyle: 'short' }) : undefined,
          originalScannerId: result.scanner_id || undefined,
        });
      } else {
        triggerHaptic('error');
        setState({ status: 'denied', errorMsg: result?.message || 'This ticket could not be validated.' });
      }

      loadStats();
    } catch (err: any) {
      triggerHaptic('error');
      setState({ status: 'denied', errorMsg: err?.message || 'Database error. Try again.' });
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
      headline: 'ENTRY APPROVED',
    },
    already_scanned: {
      bg: 'rgba(245,158,11,0.15)',
      border: 'rgba(245,158,11,0.4)',
      icon: <XCircle size={52} color="#F59E0B" />,
      headline: 'ALREADY SCANNED',
    },
    denied: {
      bg: 'rgba(239,68,68,0.15)',
      border: 'rgba(239,68,68,0.4)',
      icon: <XCircle size={52} color="#EF4444" />,
      headline: 'ENTRY DENIED',
    },
    scanning: {
      bg: 'rgba(167,139,250,0.15)',
      border: 'rgba(167,139,250,0.4)',
      icon: <ScanLine size={52} color="#A78BFA" />,
      headline: 'Validating…',
    },
  };

  const overlay = overlayConfig[state.status];
  const pct = stats.total > 0 ? Math.round((stats.checkedIn / stats.total) * 100) : 0;

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif', position: 'relative' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 20px 14px', background: '#020005', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <button onClick={onBack} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
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
        <div style={{ background: '#090514', borderRadius: '14px', padding: '12px 16px', border: '1px solid rgba(255,255,255,0.05)' }}>
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

      {/* ── Simulator Mode (dev builds only) ──────────────────────────────── */}
      {isDevEnvironment && (
        <div style={{ margin: '0 20px 12px', flexShrink: 0, background: 'rgba(245,158,11,0.08)', border: '1px dashed rgba(245,158,11,0.4)', borderRadius: '14px', padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
            <FlaskConical size={13} color="#F59E0B" />
            <span style={{ color: '#F59E0B', fontSize: '11px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Simulator Mode</span>
          </div>
          <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '0 0 8px' }}>
            Dev-only. Inject a ticket UUID or signed token to exercise the full verify_entry_pass RPC loop without a camera.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={simulatorInput}
              onChange={e => setSimulatorInput(e.target.value)}
              placeholder="ticket_id or ticket_id.signature"
              style={{ flex: 1, minWidth: 0, background: '#060A12', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '8px', padding: '8px 10px', color: '#F0F0FF', fontSize: '12px', outline: 'none', fontFamily: 'monospace' }}
            />
            <button
              onClick={() => { if (simulatorInput.trim()) handleScan(simulatorInput.trim()); }}
              disabled={!simulatorInput.trim() || state.status === 'scanning'}
              style={{ background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '8px', padding: '0 14px', color: '#F59E0B', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Simulate Scan
            </button>
          </div>
        </div>
      )}

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
                background: '#090514',
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
            <h2 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 900, letterSpacing: '0.03em', margin: '16px 0 8px' }}>
              {overlay.headline}
            </h2>
            {state.status === 'valid' && state.holderName && (
              <p style={{ color: '#A78BFA', fontSize: '16px', fontWeight: 700, margin: '4px 0' }}>
                {state.holderName}
              </p>
            )}
            {state.status === 'valid' && state.ticketType && (
              <span style={{ display: 'inline-block', color: '#FFB830', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', background: 'rgba(255,184,48,0.12)', border: '1px solid rgba(255,184,48,0.4)', borderRadius: '100px', padding: '3px 12px', margin: '4px 0' }}>
                {state.ticketType}
              </span>
            )}
            {state.checkinTime && (
              <p style={{ color: '#8B8FA8', fontSize: '13px', margin: '4px 0' }}>
                {state.status === 'valid' ? 'Checked in at' : 'Originally scanned at'} {state.checkinTime}
              </p>
            )}
            {state.status === 'already_scanned' && state.originalScannerId && (
              <p style={{ color: '#555C7A', fontSize: '11px', margin: '2px 0', fontFamily: 'monospace' }}>
                Scanner ID: {state.originalScannerId.slice(0, 8)}…
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
