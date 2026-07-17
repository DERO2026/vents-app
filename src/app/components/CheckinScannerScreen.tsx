import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, ScanLine, CheckCircle, XCircle, Camera, Shield, FlaskConical, CalendarX, Flashlight, FlashlightOff, Check } from 'lucide-react';
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

// Per-result display ≈ the duplicate-scan cooldown, after which the loop
// auto-resumes (the camera is never stopped/recreated). Errors show for < 1s
// (Task 7) so the door keeps moving; an approval lingers a touch longer.
const APPROVED_MS = 1000;
const ALREADY_MS = 1100;
const DENIED_MS = 850;              // < 1 second
const SAME_CODE_DEBOUNCE_MS = 2500; // ignore the identical code sitting in-frame
const STATS_RECONCILE_MS = 8000;    // throttle the (network) count queries
const VERIFY_TIMEOUT_MS = 9000;     // a stuck backend must not freeze the loop
// Single source of truth for the scan box size, shared by the ACTUAL
// html5-qrcode decode region (qrbox, computed from the real viewfinder
// dimensions at start time) and the VISIBLE reticle drawn in CSS — they
// must always agree, or the box the user sees isn't where scanning
// actually happens. Kept within the requested 65-75% of viewfinder width.
const SCAN_BOX_RATIO = 0.7;

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

// Result visuals are static — defined once at module scope so they aren't
// re-allocated on every render (this component re-renders on each scan).
const RESULT_THEME = {
  valid: { color: '#10B981', bg: 'rgba(16,185,129,0.16)', border: '#10B981', icon: <CheckCircle size={44} color="#10B981" /> },
  already_scanned: { color: '#F59E0B', bg: 'rgba(245,158,11,0.16)', border: '#F59E0B', icon: <XCircle size={44} color="#F59E0B" /> },
  denied: { color: '#EF4444', bg: 'rgba(239,68,68,0.16)', border: '#EF4444', icon: <XCircle size={44} color="#EF4444" /> },
} as const;

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
function playTone(kind: 'success' | 'error' | 'detect') {
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
    if (kind === 'success') { beep(880, 0, 0.09); beep(1320, 0.075, 0.13); }  // bright rising two-note
    else if (kind === 'detect') { beep(1568, 0, 0.045, 0.07); }               // instant, quiet "got it" tick
    else { beep(196, 0, 0.2, 0.12); }                                         // low error blip
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

// Runtime audit of the camera track's native capabilities. Every enhancement
// is DETECTED before it's enabled — unsupported features are reported, never
// faked.
interface CamCaps {
  probed: boolean;
  continuousFocus: boolean;   // continuous autofocus applied
  autoExposure: boolean;      // continuous auto-exposure applied
  tapToFocus: boolean;        // a real single-shot/manual refocus mode exists
  torch: boolean;             // torch/flashlight controllable
  zoom: { supported: boolean; min: number; max: number; step: number };
  barcodeDetector: boolean;   // native BarcodeDetector fast-decode path present
  resolution: string | null;  // actual negotiated capture resolution
}
const DEFAULT_CAPS: CamCaps = {
  probed: false, continuousFocus: false, autoExposure: false, tapToFocus: false,
  torch: false, zoom: { supported: false, min: 1, max: 1, step: 0.1 },
  barcodeDetector: false, resolution: null,
};

// Lightweight, allocation-free scan metrics (kept in a ref — never triggers a
// re-render). Aggregated as running sums/counts so memory stays flat across a
// full-day / one-hour session no matter how many scans (Task 8/9).
interface Metrics {
  camStartAt: number; cameraInitMs: number; readyAt: number; firstDetectionMs: number;
  rawDetections: number; duplicatesBlocked: number; processed: number;
  verifySum: number; verifyCount: number; totalSum: number; totalCount: number;
}
function newMetrics(): Metrics {
  return { camStartAt: 0, cameraInitMs: 0, readyAt: 0, firstDetectionMs: 0, rawDetections: 0, duplicatesBlocked: 0, processed: 0, verifySum: 0, verifyCount: 0, totalSum: 0, totalCount: 0 };
}
function summarize(m: Metrics) {
  const avgVerify = m.verifyCount ? m.verifySum / m.verifyCount : 0;
  const avgTotal = m.totalCount ? m.totalSum / m.totalCount : 0;
  return {
    cameraInitMs: Math.round(m.cameraInitMs),
    firstDetectionMs: Math.round(m.firstDetectionMs),
    avgVerifyMs: Math.round(avgVerify),
    avgTotalScanMs: Math.round(avgTotal),
    avgDetectionOverheadMs: Math.round(Math.max(0, avgTotal - avgVerify)),
    processed: m.processed,
    rawDetections: m.rawDetections,
    duplicateRatePct: m.rawDetections ? Math.round((100 * m.duplicatesBlocked) / m.rawDetections) : 0,
  };
}

// Reject the verify promise if the backend hangs, so a slow/dead network can
// never freeze the loop in the "reading" state (Task 7 error recovery / Task 9
// slow-backend). Verification logic itself is untouched.
function withVerifyTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(p), // the Postgrest builder is a thenable, not a real Promise
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('verify_timeout')), ms)),
  ]);
}

export function CheckinScannerScreen({ onBack, currentUser, selectedEvent, scanningDisabled = false }: CheckinScannerScreenProps) {
  const [state, setState] = useState<CheckinState>({ status: 'idle' });
  const [stats, setStats] = useState({ checkedIn: 0, total: 0 });
  const [scannerReady, setScannerReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [simulatorInput, setSimulatorInput] = useState('');
  const scannerRef = useRef<any>(null);
  const scannerDivId = 'vents-qr-scanner';
  const isDevEnvironment = import.meta.env.DEV;

  const processingRef = useRef(false);
  const seqRef = useRef(0);
  const lastScanRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });

  // ── Temp debug logging (dev builds only) — remove once verified stable on
  //    real devices. Confirms: single mount, single permission/init cycle,
  //    scannerReady flips exactly twice (false->true on start, no further
  //    flips unless a genuine rotation/backgrounding event occurs), and a
  //    sane render count (no runaway re-render loop). ──────────────────────
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  useEffect(() => {
    if (isDevEnvironment) {
      // eslint-disable-next-line no-console
      console.debug('[VENTS scanner] render #', renderCountRef.current);
    }
  });

  // ── Lifecycle-safe timers + mount tracking (no setState after unmount) ──────
  const mountedRef = useRef(true);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const later = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => { timersRef.current.delete(id); if (mountedRef.current) fn(); }, ms);
    timersRef.current.add(id);
    return id;
  }, []);
  const safeSetState = useCallback((s: CheckinState) => { if (mountedRef.current) setState(s); }, []);

  // ── Instrumentation (Task 8) ────────────────────────────────────────────────
  const metricsRef = useRef<Metrics>(newMetrics());
  const logMetrics = useCallback((tag = '') => {
    // eslint-disable-next-line no-console
    console.info(`[VENTS scanner] metrics${tag ? ' (' + tag + ')' : ''}:`, summarize(metricsRef.current));
  }, []);

  // ── Professional camera pipeline state ──────────────────────────────────────
  const [caps, setCaps] = useState<CamCaps>(DEFAULT_CAPS);
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [focusRing, setFocusRing] = useState<{ x: number; y: number; id: number } | null>(null);
  const camCapsRef = useRef<any>(null);           // html5-qrcode CameraCapabilities (zoom/torch)
  const pinchRef = useRef<{ startDist: number; startZoom: number } | null>(null);
  const zoomThrottleRef = useRef(0);
  const zoomRef = useRef(1);
  const torchOnRef = useRef(false);               // mirror for listeners that must not re-register
  // Graceful camera recovery — bumping this remounts ONLY the camera session
  // (used by the "Try Again" button after a permission/hardware failure).
  const [retryNonce, setRetryNonce] = useState(0);
  // The scanner frame — ResizeObserver watches it so a real layout change
  // (device rotation, safe-area shift, restoring from background) forces a
  // clean camera restart. html5-qrcode never recomputes its viewfinder or
  // decode region after start() — see the effect below and the note on the
  // scannerDivId container — so without this, the crop region silently goes
  // stale and drifts out of alignment with the visible frame after rotation.
  const scannerContainerRef = useRef<HTMLDivElement>(null);
  const lastObservedWidthRef = useRef<number | null>(null);
  // Low-light guidance: last moment the scanner saw ANY QR (or other activity).
  const lastActivityRef = useRef(Date.now());
  const [showTorchHint, setShowTorchHint] = useState(false);
  // Keep the screen awake during a scanning shift (best-effort, auto no-op
  // where the Wake Lock API is unavailable).
  const wakeLockRef = useRef<any>(null);
  const acquireWakeLock = useCallback(async () => {
    try {
      const wl = (navigator as any).wakeLock;
      if (!wl?.request) return;
      wakeLockRef.current = await wl.request('screen');
    } catch { /* denied or unsupported — never fatal */ }
  }, []);

  // Access guard — event organizer, sub-admin, or root/platform admin.
  const isOrganizer =
    currentUser?.role === 'organizer' ||
    currentUser?.role === 'organiser' ||
    currentUser?.role === 'admin' ||
    currentUser?.role === 'sub-admin' ||
    currentUser?.id === ROOT_UID;

  // Component-lifetime bookkeeping: clear pending timers + emit a final metrics
  // report on unmount so nothing lingers or fires after teardown.
  useEffect(() => {
    mountedRef.current = true;
    if (isDevEnvironment) {
      // eslint-disable-next-line no-console
      console.info('[VENTS scanner] lifecycle: MOUNTED');
    }
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      timers.forEach(clearTimeout);
      timers.clear();
      if (isDevEnvironment) {
        // eslint-disable-next-line no-console
        console.info('[VENTS scanner] lifecycle: UNMOUNTED');
      }
      logMetrics('session-end');
    };
  }, [logMetrics, isDevEnvironment]);

  // Dev-only: confirms scannerReady only flips on genuine start/stop/rotation
  // events, never in a rapid back-and-forth loop.
  useEffect(() => {
    if (isDevEnvironment) {
      // eslint-disable-next-line no-console
      console.info('[VENTS scanner] lifecycle: camera active changed ->', scannerReady);
    }
  }, [scannerReady, isDevEnvironment]);

  // Unlock the audio context on the first user gesture so Phase-B tones are
  // reliable (mobile browsers start it suspended until a real interaction).
  useEffect(() => {
    const unlock = () => { getAudioCtx(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // ── Background/foreground lifecycle ─────────────────────────────────────────
  // When the app is backgrounded: pause scanning + the video element (battery),
  // kill the torch, and release the wake lock. On return: resume the SAME
  // camera session (never recreated) and re-acquire the wake lock.
  useEffect(() => {
    const onVisibility = () => {
      const qr = scannerRef.current;
      if (isDevEnvironment) {
        // eslint-disable-next-line no-console
        console.info('[VENTS scanner] lifecycle: screen focus changed -> hidden =', document.hidden);
      }
      if (document.hidden) {
        try { if (torchOnRef.current) { camCapsRef.current?.torchFeature?.()?.apply?.(false); torchOnRef.current = false; if (mountedRef.current) setTorchOn(false); } } catch { /* ignore */ }
        try { if (qr?.isScanning) qr.pause(true); } catch { /* not scanning */ }
        try { wakeLockRef.current?.release?.(); } catch { /* ignore */ } finally { wakeLockRef.current = null; }
      } else {
        try { qr?.resume?.(); } catch { /* wasn't paused */ }
        lastActivityRef.current = Date.now();
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      try { wakeLockRef.current?.release?.(); } catch { /* ignore */ } finally { wakeLockRef.current = null; }
    };
  }, [acquireWakeLock, isDevEnvironment]);

  // ── Low-light guidance ──────────────────────────────────────────────────────
  // If the device has a torch, it's off, and the scanner has been armed for a
  // while with zero detections, softly suggest the torch (dark venues). The
  // interval only flips state when the value actually changes.
  useEffect(() => {
    if (!caps.torch) return;
    const id = setInterval(() => {
      const idleTooLong = Date.now() - lastActivityRef.current > 12000;
      const next = idleTooLong && !torchOnRef.current && !document.hidden;
      if (mountedRef.current) setShowTorchHint(prev => (prev === next ? prev : next));
    }, 3000);
    return () => clearInterval(id);
  }, [caps.torch]);

  // ── Check-in stats — optimistic + throttled (Task 6/9) ──────────────────────
  // Instead of two COUNT queries after EVERY scan (crippling at a 5,000-attendee
  // event with several organizers scanning), we optimistically bump the local
  // count on each approval and reconcile with the server at most once every 8s.
  const lastStatsFetchRef = useRef(0);
  const loadStats = useCallback(async (force = false) => {
    if (!selectedEvent?.id) return;
    const now = Date.now();
    if (!force && now - lastStatsFetchRef.current < STATS_RECONCILE_MS) return;
    lastStatsFetchRef.current = now;
    try {
      const { count: checkedCount } = await insforge.database
        .from('checkins').select('id', { count: 'exact', head: true }).eq('event_id', selectedEvent.id);
      const { count: totalCount } = await insforge.database
        .from('tickets').select('id', { count: 'exact', head: true }).eq('event_id', selectedEvent.id).eq('status', 'active');
      if (mountedRef.current) setStats({ checkedIn: checkedCount || 0, total: totalCount || 0 });
    } catch { /* ignore */ }
  }, [selectedEvent?.id]);

  const bumpCheckedIn = useCallback(() => {
    if (mountedRef.current) setStats(s => ({ checkedIn: s.checkedIn + 1, total: Math.max(s.total, s.checkedIn + 1) }));
  }, []);

  useEffect(() => { loadStats(true); }, [loadStats]);

  // ── The scan handler — kept in a ref so the once-created camera callback
  //    always calls the freshest version (no stale closures / no re-subscribe). ─
  const handleScan = useCallback(async (rawTicketId: string, detectAt = performance.now()) => {
    const m = metricsRef.current;
    m.processed++;
    const ticketId = rawTicketId.trim();
    let resumeMs = DENIED_MS;

    // ── PHASE A — QR DETECTED (instant, synchronous, no network) ──────────────
    // Haptic + quiet tick + white flash fire IMMEDIATELY on detection; the
    // backend verification below is fully asynchronous.
    triggerHaptic('detect');
    playTone('detect');
    safeSetState({ status: 'reading', seq: ++seqRef.current });

    try {
      await getAuthToken();
      const vStart = performance.now();
      // Unchanged: single atomic server-side verification of the signed v2 pass,
      // now guarded by a timeout so a hung backend can't freeze the scanner.
      const { data, error } = await withVerifyTimeout(
        insforge.database.rpc('verify_entry_pass' as any, { p_ticket_id: ticketId, p_actor_id: currentUser.id }),
        VERIFY_TIMEOUT_MS,
      ) as any;
      m.verifySum += performance.now() - vStart; m.verifyCount++;

      if (error) throw error;
      const result = data as any;
      const seq = ++seqRef.current;

      // ── PHASE B — VERIFICATION COMPLETE ─────────────────────────────────────
      if (result?.ok) {
        triggerHaptic('success'); playTone('success');
        bumpCheckedIn();
        resumeMs = APPROVED_MS;
        safeSetState({
          status: 'valid', headline: 'APPROVED',
          holderName: result.holder_name || 'Verified Attendee',
          ticketType: result.ticket_type || undefined,
          checkinTime: result.checked_in_at ? new Date(result.checked_in_at).toLocaleTimeString('en-NG', { timeStyle: 'short' }) : undefined,
          flash: 'green', seq,
        });
      } else if (result?.reason === 'already_scanned') {
        triggerHaptic('error'); playTone('error');
        resumeMs = ALREADY_MS;
        const t = result.checked_in_at ? new Date(result.checked_in_at).toLocaleTimeString('en-NG', { timeStyle: 'short' }) : undefined;
        safeSetState({
          status: 'already_scanned', headline: 'ALREADY CHECKED IN',
          errorMsg: t ? `First scanned at ${t}` : 'This ticket was already scanned.',
          checkinTime: t, originalScannerId: result.scanner_id || undefined, flash: 'amber', seq,
        });
      } else {
        triggerHaptic('error'); playTone('error');
        resumeMs = DENIED_MS;
        const info = deniedInfo(result);
        safeSetState({ status: 'denied', headline: info.headline, errorMsg: info.detail, flash: 'red', seq });
      }

      loadStats(false); // throttled reconcile
    } catch (err: any) {
      triggerHaptic('error'); playTone('error');
      resumeMs = DENIED_MS;
      const msg = String(err?.message || '');
      const detail = /verify_timeout/.test(msg)
        ? 'Network is slow — try again.'
        : msg.includes('rate_limited') ? 'Scanning too fast — pause a moment and try again.'
        : (msg || 'Could not verify. Try again.');
      safeSetState({ status: 'denied', headline: /verify_timeout/.test(msg) ? 'CONNECTION SLOW' : 'ENTRY DENIED', errorMsg: detail, flash: 'red', seq: ++seqRef.current });
    }

    m.totalSum += performance.now() - detectAt; m.totalCount++;
    if (isDevEnvironment) logMetrics();

    // Automatically resume scanning — the camera is never restarted; we just
    // clear the result and re-arm re-processing after the result window.
    later(() => { safeSetState({ status: 'idle' }); processingRef.current = false; }, resumeMs);
  }, [currentUser?.id, safeSetState, later, loadStats, bumpCheckedIn, logMetrics, isDevEnvironment]);

  const handleScanRef = useRef(handleScan);
  handleScanRef.current = handleScan;

  // Initialise the camera directly via the low-level Html5Qrcode API. We
  // deliberately do NOT use Html5QrcodeScanner (it hides its own controls and
  // reads as "broken"). This effect runs ONCE per session (stable deps) — the
  // camera is never recreated between scans.
  useEffect(() => {
    if (!isOrganizer || !selectedEvent?.id) return;

    let mounted = true;
    let html5QrCode: any = null;
    metricsRef.current = newMetrics();
    metricsRef.current.camStartAt = performance.now();

    import('html5-qrcode').then(async ({ Html5Qrcode }) => {
      if (!mounted) return;
      html5QrCode = new Html5Qrcode(scannerDivId, /* verbose */ false);
      scannerRef.current = html5QrCode;

      // ── TEMP DEBUG (camera-init diagnostics) — remove once verified ─────────
      // eslint-disable-next-line no-console
      console.info('[VENTS scanner] init: preflight', {
        isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : 'n/a',
        hasMediaDevices: !!(navigator as any)?.mediaDevices?.getUserMedia,
        protocol: typeof location !== 'undefined' ? location.protocol : 'n/a',
      });
      try {
        const perm = await (navigator as any)?.permissions?.query?.({ name: 'camera' as any });
        // eslint-disable-next-line no-console
        console.info('[VENTS scanner] init: camera permission =', perm?.state ?? 'unknown');
      } catch { /* permissions API not available for camera — expected on some WebViews */ }
      // Init watchdog: flag if start() neither resolves nor rejects in time.
      const initWatchdog = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.warn('[VENTS scanner] init: still pending after 12s (possible getUserMedia hang)');
      }, 12000);

      try {
        // Rear camera. NOTE: pass a MINIMAL constraint. Do NOT request an
        // explicit width/height/frameRate here — demanding a square 1280×1280
        // stream made getUserMedia reject on real devices/WebViews (no sensor
        // is natively 1:1), which surfaced as "Could not start the camera".
        // The higher-quality focus/exposure/resolution tuning is applied AFTER
        // the stream is live, non-fatally, in tuneCamera().
        await html5QrCode.start(
          { facingMode: 'environment' } as any,
          {
            // Decode-attempt rate (html5-qrcode throttling), NOT a getUserMedia
            // constraint — with the native BarcodeDetector path this is cheap
            // and halves worst-case detection latency vs 15.
            fps: 30,
            // Region-of-interest: decoding is cropped to this box each frame
            // instead of the full preview — faster, more accurate, and stable
            // against edge noise. A FUNCTION (not a fixed pixel size) so the
            // crop is computed from the viewfinder's actual rendered
            // dimensions at start time — the same SCAN_BOX_RATIO used by the
            // visible reticle below, so the real decode region can never
            // drift out of alignment with what the user sees on any screen
            // size (previously a hardcoded 260px box vs. a `min(62%,230px)`
            // visible reticle — the two diverged on most real screen widths).
            qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
              const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * SCAN_BOX_RATIO);
              return { width: size, height: size };
            },
            aspectRatio: 1.0,
            // Native, hardware-accelerated barcode detection (no JS image
            // processing / no still captures) wherever the platform provides
            // BarcodeDetector; html5-qrcode falls back to WASM/JS elsewhere.
            // Decoder config only — cannot affect camera start.
            experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          },
          // Detection callback — created ONCE, closes only over stable refs, and
          // dispatches to the freshest handleScan via handleScanRef.
          (decodedText: string) => {
            const m = metricsRef.current;
            m.rawDetections++;
            lastActivityRef.current = Date.now();
            const nowP = performance.now();
            if (!m.firstDetectionMs && m.readyAt) m.firstDetectionMs = nowP - m.readyAt;

            if (processingRef.current) { m.duplicatesBlocked++; return; }
            const v = decodedText.trim();
            const now = Date.now();
            if (v === lastScanRef.current.value && now - lastScanRef.current.at < SAME_CODE_DEBOUNCE_MS) { m.duplicatesBlocked++; return; }

            processingRef.current = true;
            lastScanRef.current = { value: v, at: now };
            handleScanRef.current(decodedText, nowP);
          },
          (_errorMessage: string) => { /* per-frame "no QR here" noise — not an error */ },
        );
        clearTimeout(initWatchdog);
        if (!mounted) return;
        metricsRef.current.cameraInitMs = performance.now() - metricsRef.current.camStartAt;
        metricsRef.current.readyAt = performance.now();
        lastActivityRef.current = Date.now();
        // eslint-disable-next-line no-console
        console.info('[VENTS scanner] init: camera STARTED', {
          initMs: Math.round(metricsRef.current.cameraInitMs),
          settings: (() => { try { return html5QrCode.getRunningTrackSettings?.(); } catch { return null; } })(),
        });
        setScannerReady(true);
        acquireWakeLock(); // keep the screen on for the scanning shift
        tuneCamera(html5QrCode);
      } catch (err: any) {
        clearTimeout(initWatchdog);
        if (!mounted) return;
        // Full diagnostics to the console (name/message/constraint/stack);
        // the user sees only the friendly, actionable message below.
        // eslint-disable-next-line no-console
        console.error('[VENTS scanner] init: camera start FAILED', {
          name: err?.name, message: err?.message,
          constraint: err?.constraint, // set on OverconstrainedError
          stack: err?.stack, raw: err,
        });
        const raw = String(err?.name || err?.message || err || '');
        let friendly = 'Could not start the camera. Please try again.';
        if (/NotAllowedError|Permission denied|permission/i.test(raw)) {
          friendly = 'Camera access is blocked. Allow camera access for Vents in your device or browser settings, then tap Try Again.';
        } else if (/NotFoundError|no camera|DevicesNotFound/i.test(raw)) {
          friendly = 'No camera was found on this device.';
        } else if (/NotReadableError|TrackStartError|in use/i.test(raw)) {
          friendly = 'The camera is already in use by another app. Close it, then tap Try Again.';
        } else if (/OverconstrainedError/i.test(raw)) {
          friendly = 'This device could not provide a compatible camera stream.';
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
        try { camCapsRef.current?.torchFeature?.()?.apply?.(false); torchOnRef.current = false; } catch { /* ignore */ }
        html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
      }
    };
    // retryNonce lets the "Try Again" button re-run this ONE effect after a
    // camera failure — it never remounts mid-session (nonce only changes on
    // explicit user retry from the error screen).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOrganizer, selectedEvent?.id, retryNonce]);

  // html5-qrcode reads the container's pixel width ONCE, when start() is
  // called, and never revisits it — rotating the device, restoring the app
  // from the background, or any other real layout change leaves its decode
  // region computed against stale dimensions even though the CSS-driven
  // preview resizes instantly and correctly. Watching the actual frame and
  // forcing a full camera restart on a real width change is the only way to
  // keep the detection region and the visible frame in agreement.
  //
  // BUG THIS REPLACES: the previous version tore down and recreated the
  // ResizeObserver — re-capturing its "current width" baseline — every time
  // `scannerReady` flipped. Becoming ready swaps the "Initialising camera…"
  // placeholder for the live reticle/controls and, shortly after, adds the
  // capability-chip row, both of which change this scrollable area's total
  // content height and can toggle whether its scrollbar is reserved —
  // narrowing/widening the scanner box's own measured width as a side
  // effect. The observer read that SELF-INFLICTED width change, mistook it
  // for a real device rotation, and called setScannerReady(false) +
  // retryNonce++ — tearing down and fully restarting the camera. Restarting
  // flips scannerReady again, which re-armed the exact same broken baseline
  // mid-transition, so the cycle repeated forever: the camera never
  // stabilized and the screen continuously flickered between init states.
  //
  // Fix: the observer is created exactly ONCE per mount and never torn down
  // by our own ready-state flips. It only acts once `resizeBaselineReadyRef`
  // is true, which is set only after the camera has been ready AND the
  // post-ready DOM swap has had time to fully settle. Going not-ready
  // (camera down / mid-restart) immediately clears that flag, so resize
  // noise from a restart can never retrigger another one.
  const resizeBaselineReadyRef = useRef(false);

  useEffect(() => {
    const el = scannerContainerRef.current;
    if (!el) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width == null || !resizeBaselineReadyRef.current) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const last = lastObservedWidthRef.current;
        if (last != null && Math.abs(width - last) > 4) {
          lastObservedWidthRef.current = width;
          resizeBaselineReadyRef.current = false; // don't react again until the restart re-settles
          if (isDevEnvironment) {
            // eslint-disable-next-line no-console
            console.info('[VENTS scanner] lifecycle: genuine layout resize detected, restarting camera', { from: last, to: width });
          }
          setScannerReady(false);
          setRetryNonce((n) => n + 1);
        }
      }, 300);
    });
    ro.observe(el);
    return () => { if (debounceTimer) clearTimeout(debounceTimer); ro.disconnect(); };
    // Set up exactly once per mount — never torn down/recreated by our own
    // ready-state flips (see the bug note above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arms the resize-recovery baseline only once the camera is ready AND the
  // ready-state DOM swap has had time to settle — capturing the baseline any
  // earlier would bake in a transient, mid-swap width as "normal" (see the
  // bug note above). Going not-ready disarms it immediately.
  useEffect(() => {
    if (!scannerReady) { resizeBaselineReadyRef.current = false; return; }
    const el = scannerContainerRef.current;
    if (!el) return;
    const id = setTimeout(() => {
      if (!mountedRef.current) return;
      lastObservedWidthRef.current = el.getBoundingClientRect().width;
      resizeBaselineReadyRef.current = true;
    }, 900); // comfortably past the ready-state DOM swap + tuneCamera's async capability probing
    return () => clearTimeout(id);
  }, [scannerReady]);

  // ── Camera capability audit + tuning ────────────────────────────────────────
  // All quality upgrades happen HERE — after the stream is live — via
  // spec-droppable `advanced` constraint sets wrapped in try/catch. Unlike a
  // pre-start getUserMedia constraint (which once broke camera start on
  // Android WebView), a post-start advanced set that the device can't satisfy
  // is simply discarded; it can never kill a running track.
  const tuneCamera = async (qr: any) => {
    const report: CamCaps = { ...DEFAULT_CAPS, probed: true };
    try {
      const trackCaps: any = qr.getRunningTrackCapabilities?.() || {};

      const focusModes: string[] = trackCaps.focusMode || [];
      if (focusModes.includes('continuous')) {
        try { await qr.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] } as any); report.continuousFocus = true; } catch { /* not applyable */ }
      }
      const exposureModes: string[] = trackCaps.exposureMode || [];
      if (exposureModes.includes('continuous')) {
        try { await qr.applyVideoConstraints({ advanced: [{ exposureMode: 'continuous' }] } as any); report.autoExposure = true; } catch { /* not applyable */ }
      }
      report.tapToFocus = focusModes.includes('single-shot') || focusModes.includes('manual');

      // Highest STABLE preview quality — only request what the hardware
      // declares (clamped to its own maxima), and only when it's an upgrade
      // over the currently negotiated settings.
      try {
        const cur: any = qr.getRunningTrackSettings?.() || {};
        const maxW = Number(trackCaps.width?.max || 0);
        const maxH = Number(trackCaps.height?.max || 0);
        if (maxW >= 1280 && maxH >= 720 && (Number(cur.width || 0) < 1280 || Number(cur.height || 0) < 720)) {
          const w = Math.min(1920, maxW), h = Math.min(1080, maxH);
          await qr.applyVideoConstraints({ advanced: [{ width: w, height: h }] } as any).catch(() => {});
        }
        const maxFps = Number(trackCaps.frameRate?.max || 0);
        if (maxFps >= 60 && Number(cur.frameRate || 0) < 60) {
          // Prefer 60fps when the sensor supports it (smoother preview,
          // more decode-ready frames); silently dropped where it doesn't.
          await qr.applyVideoConstraints({ advanced: [{ frameRate: 60 }] } as any).catch(() => {});
        }
      } catch { /* best-effort only */ }

      // Report the FINAL negotiated settings (after any upgrades above).
      const settings: any = qr.getRunningTrackSettings?.() || {};
      if (settings.width && settings.height) {
        report.resolution = `${settings.width}×${settings.height}${settings.frameRate ? ` @${Math.round(settings.frameRate)}fps` : ''}`;
      }

      const camCaps: any = qr.getRunningTrackCameraCapabilities?.();
      camCapsRef.current = camCaps || null;
      const zf = camCaps?.zoomFeature?.();
      if (zf?.isSupported?.()) {
        report.zoom = { supported: true, min: zf.min(), max: zf.max(), step: zf.step?.() || 0.1 };
        const z = zf.value?.() || 1; zoomRef.current = z; if (mountedRef.current) setZoom(z);
      }
      const tf = camCaps?.torchFeature?.();
      report.torch = !!tf?.isSupported?.();
    } catch { /* capability probing unavailable — degrade to plain preview */ }

    report.barcodeDetector = typeof (window as any).BarcodeDetector !== 'undefined';
    if (mountedRef.current) setCaps(report);
    // eslint-disable-next-line no-console
    console.info('[VENTS scanner] camera capabilities:', report);
  };

  const toggleTorch = useCallback(async () => {
    const tf = camCapsRef.current?.torchFeature?.();
    if (!tf?.isSupported?.()) return;
    try {
      const next = !torchOnRef.current;
      await tf.apply(next);
      torchOnRef.current = next;
      lastActivityRef.current = Date.now(); // torch action clears the low-light hint window
      if (mountedRef.current) { setTorchOn(next); setShowTorchHint(false); }
    } catch { /* ignore */ }
  }, []);

  // Apply zoom to hardware AND state at most ~16×/s so a fast pinch doesn't
  // storm re-renders or spam the track.
  const applyZoom = useCallback((z: number) => {
    const zf = camCapsRef.current?.zoomFeature?.();
    if (!zf?.isSupported?.()) return;
    const clamped = Math.max(caps.zoom.min, Math.min(caps.zoom.max, z));
    const now = Date.now();
    if (now - zoomThrottleRef.current < 60) return;
    zoomThrottleRef.current = now;
    zoomRef.current = clamped;
    try { zf.apply(clamped); } catch { /* ignore */ }
    if (mountedRef.current) setZoom(clamped);
  }, [caps.zoom.min, caps.zoom.max]);

  // Tap-to-focus — only when the device exposes a real refocus mode. (Point-based
  // focus needs `pointsOfInterest`, which browsers almost never expose — so we
  // refocus centrally rather than fake a per-point focus.)
  const onCameraTap = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!caps.tapToFocus) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setFocusRing({ x: e.clientX - rect.left, y: e.clientY - rect.top, id: Date.now() });
    later(() => setFocusRing(null), 900);
    const qr = scannerRef.current;
    const modes: string[] = (qr?.getRunningTrackCapabilities?.()?.focusMode) || [];
    (async () => {
      try {
        if (modes.includes('single-shot')) await qr.applyVideoConstraints({ advanced: [{ focusMode: 'single-shot' }] } as any);
        else if (modes.includes('manual')) await qr.applyVideoConstraints({ advanced: [{ focusMode: 'manual' }] } as any);
        later(() => { if (modes.includes('continuous')) qr?.applyVideoConstraints?.({ advanced: [{ focusMode: 'continuous' }] } as any).catch(() => {}); }, 1600);
      } catch { /* ignore */ }
    })();
  }, [caps.tapToFocus, later]);

  const onPinchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && caps.zoom.supported) {
      const [a, b] = [e.touches[0], e.touches[1]];
      pinchRef.current = { startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), startZoom: zoomRef.current };
    }
  }, [caps.zoom.supported]);
  const onPinchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current && caps.zoom.supported) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      applyZoom(pinchRef.current.startZoom * (dist / pinchRef.current.startDist));
    }
  }, [caps.zoom.supported, applyZoom]);
  const onPinchEnd = useCallback(() => { pinchRef.current = null; }, []);

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
  const theme = isResult ? RESULT_THEME[state.status as keyof typeof RESULT_THEME] : null;
  const flashColor = state.flash === 'green' ? '#10B981' : state.flash === 'red' ? '#EF4444' : '#F59E0B';

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif', position: 'relative' }}>
      <style>{`
        @keyframes ventsReticlePulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
        @keyframes ventsGentlePulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.03); } }
        @keyframes ventsSweep { 0% { top: 4%; } 100% { top: 92%; } }
        @keyframes ventsFlash { 0% { opacity: .5; } 100% { opacity: 0; } }
        @keyframes ventsPop { 0% { transform: scale(.9); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes ventsSpin { to { transform: rotate(360deg); } }
        @keyframes ventsLiveDot { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
        @keyframes ventsFocusRing { 0% { transform: translate(-50%,-50%) scale(1.6); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(-50%,-50%) scale(1); opacity: 0; } }
        /* html5-qrcode inserts its own <video>/<canvas> sized to the native
           camera stream's aspect ratio, which is rarely square — left alone
           it can render taller or narrower than our square container and
           get asymmetrically clipped, shifting the visible feed inside the
           frame. Forcing it to exactly fill the container keeps the visible
           feed and the qrbox decode region (computed from this same
           container's dimensions) in the same coordinate space. */
        #${scannerDivId} video, #${scannerDivId} canvas {
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
          max-width: 100% !important;
          max-height: 100% !important;
          object-fit: cover !important;
          display: block !important;
        }
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
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 24px', scrollbarGutter: 'stable' }}>
        {cameraError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginTop: '40px', textAlign: 'center', padding: '0 12px' }}>
            <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Camera size={32} color="#EF4444" />
            </div>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, margin: 0 }}>Camera Unavailable</p>
            <p style={{ color: '#C4C9E0', fontSize: '13px', margin: 0, lineHeight: 1.6, maxWidth: '300px' }}>{cameraError}</p>
            <button
              onClick={() => { setCameraError(null); setScannerReady(false); setRetryNonce(n => n + 1); }}
              style={{ marginTop: '8px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', borderRadius: '12px', padding: '12px 32px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}
            >
              Try Again
            </button>
            <p style={{ color: '#555C7A', fontSize: '11px', margin: '4px 0 0' }}>
              Scanning requires camera permission over a secure (HTTPS) connection.
            </p>
          </div>
        ) : (
          <>
            <p style={{ color: reading ? '#F0F0FF' : '#8B8FA8', fontSize: '12px', textAlign: 'center', marginBottom: '12px', transition: 'color .2s', fontWeight: reading ? 700 : 400 }}>
              {reading ? 'Reading Ticket…' : 'Point the camera at a Vents ticket QR code'}
            </p>

            {/* Scanner — the camera preview is ALWAYS mounted and live. Every
                state (reading / result / cooldown) renders OVER the running
                preview; the camera is never stopped, recreated, or hidden. */}
            <div
              ref={scannerContainerRef}
              onClick={onCameraTap}
              onTouchStart={onPinchStart}
              onTouchMove={onPinchMove}
              onTouchEnd={onPinchEnd}
              style={{ position: 'relative', width: '100%', aspectRatio: '1 / 1', borderRadius: '20px', overflow: 'hidden', border: `3px solid ${isResult && theme ? theme.border : 'rgba(167,139,250,0.3)'}`, background: '#090514', boxShadow: isResult && theme ? `0 0 30px ${theme.bg}` : 'none', transition: 'border-color .15s, box-shadow .15s', touchAction: caps.zoom.supported ? 'none' : 'auto', cursor: caps.tapToFocus ? 'crosshair' : 'default' }}
            >
              {/* Absolutely positioned + inset:0, NOT a bare block div — this is
                  the actual root cause of the camera overflowing the frame.
                  html5-qrcode injects a <video>/<canvas> and forces its own
                  `width:100%;height:100%` (see the style block below), but a
                  percentage height only resolves against a parent with a
                  DEFINITE height. A plain block div's height is `auto` (sized
                  to its content — the video), so the previous height:100%
                  rule silently no-opped and the video fell back to its native
                  camera aspect ratio, rendering taller or shorter than this
                  square frame and spilling past the purple border. Pinning
                  this div to inset:0 against its `position:relative` parent
                  (which IS a definite square via aspect-ratio above) gives it
                  a real height for the video's 100% to resolve against. */}
              <div id={scannerDivId} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />

              {/* "Initialising camera…" lives INSIDE this fixed-size box (absolute
                  overlay), not as a document-flow sibling below it. This box's own
                  size is governed purely by CSS (width:100% + aspect-ratio:1/1) and
                  is unaffected by its children, so mounting/unmounting this overlay
                  can never change the scrollable ancestor's total content height —
                  which is exactly the self-inflicted layout shift that used to fool
                  the resize-recovery ResizeObserver into restarting the camera (see
                  the note on that effect below). */}
              {!scannerReady && !cameraError && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', color: '#8B8FA8', fontSize: '13px', background: '#090514' }}>
                  Initialising camera…
                </div>
              )}

              {/* Reticle: corner brackets + (idle) sweep line; pulses white while
                  reading. Hidden during a result so it doesn't clutter the card. */}
              {scannerReady && !isResult && (
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ position: 'relative', width: `${SCAN_BOX_RATIO * 100}%`, aspectRatio: '1 / 1', animation: reading ? 'none' : 'ventsGentlePulse 2.4s ease-in-out infinite' }}>
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

              {/* Torch / flashlight toggle — only when the hardware supports it. */}
              {scannerReady && caps.torch && (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleTorch(); }}
                  aria-label={torchOn ? 'Turn torch off' : 'Turn torch on'}
                  style={{ position: 'absolute', top: '12px', right: '12px', width: '42px', height: '42px', borderRadius: '50%', border: '1px solid rgba(255,255,255,0.25)', background: torchOn ? '#FFB830' : 'rgba(2,0,5,0.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 6 }}
                >
                  {torchOn ? <Flashlight size={19} color="#020005" /> : <FlashlightOff size={19} color="#fff" />}
                </button>
              )}

              {/* Zoom level indicator (pinch-to-zoom) — shown while zoomed in. */}
              {scannerReady && caps.zoom.supported && zoom > 1.05 && (
                <div style={{ position: 'absolute', top: '14px', left: '14px', background: 'rgba(2,0,5,0.6)', backdropFilter: 'blur(6px)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '100px', padding: '4px 10px', fontSize: '11px', fontWeight: 700, color: '#fff', zIndex: 6, pointerEvents: 'none' }}>
                  {zoom.toFixed(1)}×
                </div>
              )}

              {/* Tap-to-focus ring (only rendered when a real refocus fired). */}
              {focusRing && (
                <div key={focusRing.id} style={{ position: 'absolute', left: focusRing.x, top: focusRing.y, width: '64px', height: '64px', border: '2px solid #FFFFFF', borderRadius: '50%', boxShadow: '0 0 10px rgba(255,255,255,0.5)', pointerEvents: 'none', zIndex: 6, animation: 'ventsFocusRing 0.9s ease-out forwards' }} />
              )}

              {/* Active-scanning indicator — a live pulsing dot so the operator
                  always knows the scanner is armed and working (Task 5). */}
              {scannerReady && !reading && !isResult && (
                <div style={{ position: 'absolute', bottom: '12px', left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px', background: 'rgba(2,0,5,0.55)', backdropFilter: 'blur(6px)', border: '1px solid rgba(16,185,129,0.35)', borderRadius: '100px', padding: '5px 12px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10B981', boxShadow: '0 0 8px #10B981', animation: 'ventsLiveDot 1.3s ease-in-out infinite' }} />
                    <span style={{ color: '#E6FFF4', fontSize: '11.5px', fontWeight: 700, letterSpacing: '0.03em' }}>Scanning</span>
                  </div>
                </div>
              )}

              {/* Phase-A detect flash — a quick white blink the instant a QR is
                  seen, before any network round-trip. */}
              {reading && (
                <div key={`d${state.seq}`} style={{ position: 'absolute', inset: 0, background: '#FFFFFF', pointerEvents: 'none', animation: 'ventsFlash 0.22s ease-out forwards' }} />
              )}

              {/* Low-light guidance — only when the device HAS a torch, it's off,
                  and nothing has been detected for a while. */}
              {scannerReady && !reading && !isResult && showTorchHint && caps.torch && !torchOn && (
                <div style={{ position: 'absolute', top: '62px', right: '12px', background: 'rgba(2,0,5,0.72)', backdropFilter: 'blur(6px)', border: '1px solid rgba(255,184,48,0.4)', borderRadius: '10px', padding: '6px 10px', fontSize: '11px', fontWeight: 600, color: '#FFB830', zIndex: 6, pointerEvents: 'none', maxWidth: '150px', textAlign: 'right' }}>
                  Dark venue? Try the torch ↑
                </div>
              )}

              {/* Phase-B colour flash — confined to the live camera frame (0.5s). */}
              {isResult && state.flash && (
                <div key={state.seq} style={{ position: 'absolute', inset: 0, background: flashColor, pointerEvents: 'none', animation: 'ventsFlash 0.5s ease-out forwards' }} />
              )}

              {/* Phase-B result — a bottom card OVER the still-running preview
                  (the live camera stays visible above the gradient), so it never
                  looks frozen. Auto-clears after the cooldown. */}
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

            {/* Camera capability audit — reports which native enhancements are
                ACTIVE on this device. Unsupported ones are shown muted (never
                faked). Full detail is also logged to the console. */}
            {scannerReady && caps.probed && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center', marginTop: '12px' }}>
                {([
                  ['Autofocus', caps.continuousFocus],
                  ['Auto-exposure', caps.autoExposure],
                  ['Tap-focus', caps.tapToFocus],
                  ['Torch', caps.torch],
                  ['Zoom', caps.zoom.supported],
                  ['Fast-decode', caps.barcodeDetector],
                ] as [string, boolean][]).map(([label, on]) => (
                  <span key={label} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                    fontSize: '10.5px', fontWeight: 600, borderRadius: '100px', padding: '3px 9px',
                    background: on ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${on ? 'rgba(16,185,129,0.35)' : 'rgba(255,255,255,0.08)'}`,
                    color: on ? '#34D399' : '#555C7A',
                  }}>
                    {on ? <Check size={10} /> : <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#555C7A', display: 'inline-block' }} />}
                    {label}
                  </span>
                ))}
                {caps.resolution && (
                  <span style={{ fontSize: '10.5px', fontWeight: 600, color: '#8B8FA8', borderRadius: '100px', padding: '3px 9px', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)' }}>
                    {caps.resolution}
                  </span>
                )}
              </div>
            )}

            {/* Live performance readout (dev only) — the same metrics streamed to
                the console on every scan and at session end. */}
            {isDevEnvironment && scannerReady && (() => {
              const m = summarize(metricsRef.current);
              return (
                <p style={{ color: '#555C7A', fontSize: '10px', textAlign: 'center', marginTop: '8px', fontFamily: 'monospace' }}>
                  init {m.cameraInitMs}ms · 1st-detect {m.firstDetectionMs}ms · verify {m.avgVerifyMs}ms · scan {m.avgTotalScanMs}ms · {m.processed} done · dup {m.duplicateRatePct}%
                </p>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
