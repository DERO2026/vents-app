import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ScanLine, CheckCircle, XCircle, Camera, Shield, FlaskConical, CalendarX } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { Event } from './types';

// Root admin account — same convention used in App.tsx / AdminDashboardScreen.tsx.
const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

// Two-phase pipeline:
//   'reading'  = Phase A. A QR was DETECTED (instant, pre-verification): light
//                haptic + white reticle pulse + "Reading Ticket…", camera stays
//                live. No approve/deny, no success sound yet.
//   valid / already_scanned / denied = Phase B, only after verify_entry_pass()
//                returns. The cryptographic verification path is UNCHANGED.
type ScanResult = 'idle' | 'reading' | 'valid' | 'already_scanned' | 'denied';

// Phase-B result display ≈ the duplicate-scan cooldown. The camera preview
// stays live and mounted the WHOLE time — this only gates re-processing, it
// never stops/recreates the camera. ~1s keeps the loop tight
// (Detect → Verify → Cooldown → Ready) while preventing an instant double scan.
const RESULT_MS = 1000;

interface CheckinScannerScreenProps {
  onBack: () => void;
  currentUser: any;
  selectedEvent?: Event | null;
  // Kill switch (app_config.disable_scanning) — verify_entry_pass also
  // rejects with 'scanning_disabled' server-side if this is bypassed.
  scanningDisabled?: boolean;
}

interface CheckinState {
  status: ScanResult;
  headline?: string;
  holderName?: string;
  ticketType?: string;
  checkinTime?: string;
  errorMsg?: string;
  originalScannerId?: string;
  flash?: 'green' | 'red' | 'amber';
  seq?: number; // bumps each result so the flash animation re-fires
}

// Web Vibration API — the browser/Capacitor-WebView equivalent of native
// haptics. No-ops silently on platforms without support (e.g. iOS Safari).
// 'detect' is the light Phase-A tick fired the instant a QR is seen.
function triggerHaptic(kind: 'detect' | 'success' | 'error') {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(kind === 'detect' ? 8 : kind === 'success' ? 40 : [30, 60, 30]);
  } catch { /* ignore */ }
}

// Optional, best-effort Web-Audio confirmation tones (no audio assets shipped).
// Useful in loud venues where haptics alone are easy to miss. Silently no-ops
// where audio is unavailable/locked — haptics remain the primary cue.
let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    if (!_audioCtx) _audioCtx = new AC();
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    return _audioCtx;
  } catch { return null; }
}
function playTone(kind: 'success' | 'error') {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const beep = (freq: number, start: number, dur: number, peak = 0.16) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(peak, now + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + start); osc.stop(now + start + dur + 0.03);
    };
    if (kind === 'success') { beep(880, 0, 0.09); beep(1320, 0.075, 0.13); } // bright rising two-note
    else { beep(196, 0, 0.2, 0.12); }                                        // low error blip
  } catch { /* ignore */ }
}

// Map a verify_entry_pass denial into an exact, glanceable headline + detail.
// (The server messages/reasons are unchanged; this only presents them.)
function deniedInfo(result: any): { headline: string; detail: string } {
  const reason = result?.reason as string | undefined;
  const msg = (result?.message as string | undefined) || '';
  const low = msg.toLowerCase();
  switch (reason) {
    case 'expired':
      return { headline: 'EXPIRED TICKET', detail: msg || 'This pass has expired.' };
    case 'wrong_organizer':
    case 'payload_mismatch':
      return { headline: 'WRONG EVENT', detail: msg || 'This ticket is for a different event.' };
    case 'not_active':
      if (low.includes('refund')) return { headline: 'REFUNDED', detail: 'This ticket was refunded.' };
      if (low.includes('cancel')) return { headline: 'CANCELLED', detail: 'This ticket was cancelled.' };
      return { headline: 'INVALID TICKET', detail: msg || 'This ticket is not active.' };
    case 'invalid_signature':
    case 'invalid_token':
    case 'unsigned_ticket':
    case 'legacy_token':
    case 'not_found':
      return { headline: 'INVALID TICKET', detail: msg || 'This ticket could not be validated.' };
    default:
      return { headline: 'ENTRY DENIED', detail: msg || 'This ticket could not be validated.' };
  }
}

export function CheckinScannerScreen({ onBack, currentUser, selectedEvent, scanningDisabled = false }: CheckinScannerScreenProps) {
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
  const seqRef = useRef(0);
  const lastScanRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });

  // Access guard — event organizer, sub-admin, or root/platform admin.
  const isOrganizer =
    currentUser?.role === 'organizer' ||
    currentUser?.role === 'organiser' ||
    currentUser?.role === 'admin' ||
    currentUser?.role === 'sub-admin' ||
    currentUser?.id === ROOT_UID;

  // Unlock the audio context on the first user gesture so Phase-B tones are
  // reliable (mobile browsers start it suspended until a real interaction).
  useEffect(() => {
    const unlock = () => { getAudioCtx(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

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

  // Initialise the camera directly via the low-level Html5Qrcode API.
  //
  // We deliberately do NOT use Html5QrcodeScanner (the high-level, auto-UI
  // class) — it never starts the camera on its own and hides its controls
  // inside our dark container, which reads as "the scanner is broken". Driving
  // Html5Qrcode.start() ourselves triggers the permission prompt immediately
  // and starts decoding the instant the stream is live.
  useEffect(() => {
    if (!isOrganizer || !selectedEvent?.id) return;

    let mounted = true;
    let html5QrCode: any = null;

    import('html5-qrcode').then(async ({ Html5Qrcode }) => {
      if (!mounted) return;

      html5QrCode = new Html5Qrcode(scannerDivId, /* verbose */ false);
      scannerRef.current = html5QrCode;

      try {
        await html5QrCode.start(
          { facingMode: 'environment' },
          // fps 15 (up from 10) for snappier detection; a slightly larger qrbox
          // acquires the code from a bit further away without hurting decode.
          { fps: 15, qrbox: { width: 260, height: 260 }, aspectRatio: 1.0 },
          async (decodedText: string) => {
            // Continuous loop — the camera is NEVER stopped or unmounted between
            // scans; we only gate re-processing. Two guards:
            //   * processingRef: a ~1s cooldown after each scan (Cooldown → Ready).
            //   * lastScanRef: debounce the SAME code sitting in-frame so it
            //     doesn't repeat, while a DIFFERENT ticket still scans instantly
            //     the moment the cooldown clears.
            if (processingRef.current) return;
            const v = decodedText.trim();
            const now = Date.now();
            if (v === lastScanRef.current.value && now - lastScanRef.current.at < 2500) return;
            processingRef.current = true;
            lastScanRef.current = { value: v, at: now };
            await handleScan(decodedText);
            setTimeout(() => { processingRef.current = false; }, RESULT_MS);
          },
          (_errorMessage: string) => {
            // Per-frame "no QR in this frame" noise — expected, not an error.
          },
        );
        if (!mounted) return;
        setScannerReady(true);
      } catch (err: any) {
        if (!mounted) return;
        const raw = String(err?.name || err?.message || err || '');
        let friendly = 'Could not start the camera. Please try again.';
        if (/NotAllowedError|Permission denied|permission/i.test(raw)) {
          friendly = 'Camera access denied. Enable camera permission for Vents in your device/browser settings, then reopen the scanner.';
        } else if (/NotFoundError|no camera|DevicesNotFound/i.test(raw)) {
          friendly = 'No camera was found on this device.';
        } else if (/NotReadableError|TrackStartError|in use/i.test(raw)) {
          friendly = 'The camera is already in use by another app. Close it and try again.';
        } else if (/OverconstrainedError/i.test(raw)) {
          friendly = 'This device has no rear-facing camera available.';
        }
        setCameraError(friendly);
      }
    }).catch(err => {
      if (!mounted) return;
      setCameraError('Could not load the scanner module: ' + (err?.message || err));
    });

    return () => {
      mounted = false;
      if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
      }
    };
  }, [isOrganizer, selectedEvent?.id]);

  const handleScan = async (rawTicketId: string) => {
    const ticketId = rawTicketId.trim();

    // ── PHASE A — QR DETECTED (instant, synchronous, no network) ──────────────
    // Runs before the first await, so the reticle + light tick land in <50 ms.
    // The camera preview keeps running; no approve/deny, no success tone yet.
    triggerHaptic('detect');
    setState({ status: 'reading' });

    try {
      // Ensure hc.userToken is set so auth.uid() resolves in the RPC's checks.
      await getAuthToken();

      // Unchanged: single atomic server-side verification of the signed v2 pass.
      const { data, error } = await insforge.database.rpc('verify_entry_pass' as any, {
        p_ticket_id: ticketId,
        p_actor_id: currentUser.id,
      });

      if (error) throw error;
      const result = data as any;
      const seq = ++seqRef.current;

      // ── PHASE B — VERIFICATION COMPLETE ─────────────────────────────────────
      if (result?.ok) {
        triggerHaptic('success'); playTone('success');
        setState({
          status: 'valid',
          headline: 'APPROVED',
          holderName: result.holder_name || 'Verified Attendee',
          ticketType: result.ticket_type || undefined,
          checkinTime: result.checked_in_at ? new Date(result.checked_in_at).toLocaleTimeString('en-NG', { timeStyle: 'short' }) : undefined,
          flash: 'green', seq,
        });
      } else if (result?.reason === 'already_scanned') {
        triggerHaptic('error'); playTone('error');
        const t = result.checked_in_at ? new Date(result.checked_in_at).toLocaleTimeString('en-NG', { timeStyle: 'short' }) : undefined;
        setState({
          status: 'already_scanned',
          headline: 'ALREADY CHECKED IN',
          errorMsg: t ? `First scanned at ${t}` : 'This ticket was already scanned.',
          checkinTime: t,
          originalScannerId: result.scanner_id || undefined,
          flash: 'amber', seq,
        });
      } else {
        triggerHaptic('error'); playTone('error');
        const info = deniedInfo(result);
        setState({ status: 'denied', headline: info.headline, errorMsg: info.detail, flash: 'red', seq });
      }

      loadStats();
    } catch (err: any) {
      triggerHaptic('error'); playTone('error');
      const rateLimited = String(err?.message || '').includes('rate_limited');
      setState({
        status: 'denied',
        headline: 'ENTRY DENIED',
        errorMsg: rateLimited ? 'Scanning too fast — pause a moment and try again.' : (err?.message || 'Database error. Try again.'),
        flash: 'red', seq: ++seqRef.current,
      });
    }

    // Automatically return to scanning mode.
    setTimeout(() => setState({ status: 'idle' }), RESULT_MS);
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

  // ── Kill switch (app_config.disable_scanning) ───────────────────────────────
  if (scanningDisabled) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
        <ScanLine size={48} color="#8B8FA8" style={{ marginBottom: '16px' }} />
        <h2 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800 }}>Scanning Temporarily Paused</h2>
        <p style={{ color: '#8B8FA8', fontSize: '13px', marginTop: '8px', lineHeight: 1.6 }}>
          Ticket scanning is temporarily disabled platform-wide. Please try again shortly.
        </p>
        <button onClick={onBack} style={{ marginTop: '24px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '12px 28px', color: '#C4C9E0', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}>
          Go Back
        </button>
      </div>
    );
  }

  // ── No event selected ────────────────────────────────────────────────────────
  if (!selectedEvent?.id) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
        <CalendarX size={48} color="#F59E0B" style={{ marginBottom: '16px' }} />
        <h2 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800 }}>No Event Selected</h2>
        <p style={{ color: '#8B8FA8', fontSize: '13px', marginTop: '8px', lineHeight: 1.6 }}>
          No event selected for scanning. Open the scanner from an event's page or your organizer dashboard.
        </p>
        <button onClick={onBack} style={{ marginTop: '24px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', borderRadius: '12px', padding: '12px 28px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}>
          Go Back
        </button>
      </div>
    );
  }

  const pct = stats.total > 0 ? Math.round((stats.checkedIn / stats.total) * 100) : 0;
  const isResult = state.status === 'valid' || state.status === 'already_scanned' || state.status === 'denied';
  const reading = state.status === 'reading';

  const resultTheme = {
    valid: { color: '#10B981', bg: 'rgba(16,185,129,0.16)', border: '#10B981', icon: <CheckCircle size={44} color="#10B981" /> },
    already_scanned: { color: '#F59E0B', bg: 'rgba(245,158,11,0.16)', border: '#F59E0B', icon: <XCircle size={44} color="#F59E0B" /> },
    denied: { color: '#EF4444', bg: 'rgba(239,68,68,0.16)', border: '#EF4444', icon: <XCircle size={44} color="#EF4444" /> },
  } as const;
  const theme = isResult ? resultTheme[state.status as keyof typeof resultTheme] : null;
  const flashColor = state.flash === 'green' ? '#10B981' : state.flash === 'red' ? '#EF4444' : '#F59E0B';

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif', position: 'relative' }}>
      <style>{`
        @keyframes ventsReticlePulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
        @keyframes ventsSweep { 0% { top: 4%; } 100% { top: 92%; } }
        @keyframes ventsFlash { 0% { opacity: .5; } 100% { opacity: 0; } }
        @keyframes ventsPop { 0% { transform: scale(.9); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes ventsSpin { to { transform: rotate(360deg); } }
      `}</style>

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
            Dev-only. Inject a signed v2 pass token ("payload.signature") to exercise the full verify_entry_pass RPC loop without a camera — unsigned, tampered, expired, or legacy tokens are rejected, same as a real scan.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={simulatorInput}
              onChange={e => setSimulatorInput(e.target.value)}
              placeholder="payload.signature"
              style={{ flex: 1, minWidth: 0, background: '#060A12', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '8px', padding: '8px 10px', color: '#F0F0FF', fontSize: '12px', outline: 'none', fontFamily: 'monospace' }}
            />
            <button
              onClick={() => { if (simulatorInput.trim() && !reading) handleScan(simulatorInput.trim()); }}
              disabled={!simulatorInput.trim() || reading}
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
            <p style={{ color: reading ? '#F0F0FF' : '#8B8FA8', fontSize: '12px', textAlign: 'center', marginBottom: '12px', transition: 'color .2s', fontWeight: reading ? 700 : 400 }}>
              {reading ? 'Reading Ticket…' : 'Point the camera at a Vents ticket QR code'}
            </p>

            {/* Scanner — the camera preview is ALWAYS mounted and live. Every
                state (reading / result / cooldown) renders OVER the running
                preview; the camera is never stopped, recreated, or hidden, so
                the loop never black-screens or freezes between scans. */}
            <div style={{ position: 'relative', borderRadius: '20px', overflow: 'hidden', border: `3px solid ${isResult && theme ? theme.border : 'rgba(167,139,250,0.3)'}`, background: '#090514', minHeight: scannerReady ? undefined : '260px', boxShadow: isResult && theme ? `0 0 30px ${theme.bg}` : 'none', transition: 'border-color .15s, box-shadow .15s' }}>
              <div id={scannerDivId} />

              {/* Reticle: corner brackets + (idle) sweep line; pulses white while
                  reading. Hidden during a result so it doesn't clutter the card. */}
              {scannerReady && !isResult && (
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ position: 'relative', width: 'min(62%, 230px)', aspectRatio: '1 / 1' }}>
                    {([['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']] as const).map(([v, h], i) => (
                      <div key={i} style={{
                        position: 'absolute', width: '30px', height: '30px',
                        [v]: '-2px', [h]: '-2px',
                        [`border${v[0].toUpperCase()}${v.slice(1)}`]: `3px solid ${reading ? '#FFFFFF' : 'rgba(167,139,250,0.85)'}`,
                        [`border${h[0].toUpperCase()}${h.slice(1)}`]: `3px solid ${reading ? '#FFFFFF' : 'rgba(167,139,250,0.85)'}`,
                        [`border${v === 'top' ? 'TopLeft' : 'BottomLeft'}Radius`]: h === 'left' ? '10px' : undefined,
                        [`border${v === 'top' ? 'TopRight' : 'BottomRight'}Radius`]: h === 'right' ? '10px' : undefined,
                        boxShadow: reading ? '0 0 12px rgba(255,255,255,0.6)' : 'none',
                        animation: reading ? 'ventsReticlePulse 0.7s ease-in-out infinite' : 'none',
                        transition: 'border-color .15s',
                      } as React.CSSProperties} />
                    ))}
                    {!reading && (
                      <div style={{ position: 'absolute', left: '6%', right: '6%', height: '2px', background: 'linear-gradient(90deg, transparent, #A78BFA, transparent)', borderRadius: '2px', animation: 'ventsSweep 2.2s ease-in-out infinite alternate' }} />
                    )}
                  </div>
                </div>
              )}

              {/* Phase-A "Reading Ticket…" pill */}
              {reading && (
                <div style={{ position: 'absolute', bottom: '14px', left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(2,0,5,0.72)', backdropFilter: 'blur(6px)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '100px', padding: '7px 14px' }}>
                    <span style={{ width: '13px', height: '13px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', display: 'inline-block', animation: 'ventsSpin 0.7s linear infinite' }} />
                    <span style={{ color: '#fff', fontSize: '12.5px', fontWeight: 700 }}>Reading Ticket…</span>
                  </div>
                </div>
              )}

              {/* Phase-B colour flash — confined to the live camera frame (0.5s). */}
              {isResult && state.flash && (
                <div key={state.seq} style={{ position: 'absolute', inset: 0, background: flashColor, pointerEvents: 'none', animation: 'ventsFlash 0.5s ease-out forwards' }} />
              )}

              {/* Phase-B result — a bottom card OVER the still-running preview
                  (the live camera stays visible above the gradient), so it never
                  looks frozen. Auto-clears after the ~1s cooldown. */}
              {isResult && theme && (
                <div key={`r${state.seq}`} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', pointerEvents: 'none' }}>
                  <div style={{ background: 'linear-gradient(to top, rgba(2,3,8,0.97) 0%, rgba(2,3,8,0.86) 48%, transparent 90%)', padding: '36px 16px 16px', textAlign: 'center', animation: 'ventsPop 0.18s ease-out' }}>
                    {theme.icon}
                    <h2 style={{ color: theme.color, fontSize: '21px', fontWeight: 900, letterSpacing: '0.02em', margin: '4px 0 4px' }}>
                      {state.headline}
                    </h2>
                    {state.status === 'valid' && state.holderName && (
                      <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, margin: '2px 0' }}>{state.holderName}</p>
                    )}
                    {state.status === 'valid' && state.ticketType && (
                      <span style={{ display: 'inline-block', color: '#FFB830', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', background: 'rgba(255,184,48,0.12)', border: '1px solid rgba(255,184,48,0.4)', borderRadius: '100px', padding: '3px 12px', margin: '3px 0' }}>
                        {state.ticketType}
                      </span>
                    )}
                    {state.status === 'valid' && state.checkinTime && (
                      <p style={{ color: '#8B8FA8', fontSize: '12.5px', margin: '4px 0 0' }}>Checked in at {state.checkinTime}</p>
                    )}
                    {state.status !== 'valid' && state.errorMsg && (
                      <p style={{ color: '#C4C9E0', fontSize: '13px', margin: '4px 0 0', lineHeight: 1.5 }}>{state.errorMsg}</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {!scannerReady && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80px', color: '#8B8FA8', fontSize: '13px' }}>
                Initialising camera…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
