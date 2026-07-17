// ── Ticket Scanner (rebuilt from scratch) ────────────────────────────────────
// Clean, layered architecture:
//   • useCamera        — owns getUserMedia + the <video> we render (no injected
//                        DOM; this is the fix for the old 0px-preview bug)
//   • useQrScanner     — decode loop (BarcodeDetector fast path / jsQR fallback)
//   • validateTicket   — backend check-in (verify_entry_pass), UNCHANGED logic
//   • ScannerFrame /
//     ScanResultCard   — pure presentational UI
// This screen composes them and owns only the scan→verify→result→resume state
// machine, stats, and haptics. The camera is started once and never recreated
// between scans, so it stays stable across thousands of check-ins.

import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Camera, Shield, ScanLine, CalendarX, Flashlight, FlashlightOff, SwitchCamera, FlaskConical } from 'lucide-react';
import { insforge } from '../../lib/insforge';
import { Event } from './types';
import { useCamera } from './scanner/useCamera';
import { useQrScanner } from './scanner/useQrScanner';
import { ScannerFrame } from './scanner/ScannerFrame';
import { ScanResultCard } from './scanner/ScanResultCard';
import { validateTicket, type ScanOutcome } from './scanner/ticketValidation';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

// Per-result display windows; the loop auto-resumes after these (camera never
// stops). A same-code debounce stops a QR left in-frame from re-firing.
const RESUME_MS = { valid: 1500, already_scanned: 1600, denied: 1100 } as const;
const SAME_CODE_DEBOUNCE_MS = 2500;
const STATS_RECONCILE_MS = 8000;

function triggerHaptic(kind: 'detect' | 'success' | 'error') {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(kind === 'detect' ? 8 : kind === 'success' ? 40 : [30, 60, 30]);
  } catch { /* ignore */ }
}

interface CheckinScannerScreenProps {
  onBack: () => void;
  currentUser: any;
  selectedEvent?: Event | null;
  scanningDisabled?: boolean;
}

function GuardScreen({ icon, title, body, onBack }: { icon: React.ReactNode; title: string; body: string; onBack: () => void }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#020005', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
      {icon}
      <h2 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, marginTop: '16px' }}>{title}</h2>
      <p style={{ color: '#8B8FA8', fontSize: '13px', marginTop: '8px', lineHeight: 1.6, maxWidth: '300px' }}>{body}</p>
      <button onClick={onBack} style={{ marginTop: '24px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', borderRadius: '12px', padding: '12px 28px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}>
        Go Back
      </button>
    </div>
  );
}

export function CheckinScannerScreen({ onBack, currentUser, selectedEvent, scanningDisabled = false }: CheckinScannerScreenProps) {
  const isOrganizer =
    currentUser?.role === 'organizer' ||
    currentUser?.role === 'organiser' ||
    currentUser?.role === 'admin' ||
    currentUser?.role === 'sub-admin' ||
    currentUser?.id === ROOT_UID;

  const active = isOrganizer && !scanningDisabled && !!selectedEvent?.id;

  const cam = useCamera(active);

  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [stats, setStats] = useState({ checkedIn: 0, total: 0 });
  const [simInput, setSimInput] = useState('');
  const isDev = import.meta.env.DEV;

  const processingRef = useRef(false);
  const lastScanRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });
  const mountedRef = useRef(true);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const lastStatsAtRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    return () => { mountedRef.current = false; timers.forEach(clearTimeout); timers.clear(); };
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => { timersRef.current.delete(id); if (mountedRef.current) fn(); }, ms);
    timersRef.current.add(id);
  }, []);

  // ── Check-in stats: optimistic bump + throttled server reconcile ────────────
  const loadStats = useCallback(async (force = false) => {
    const id = selectedEvent?.id;
    if (!id) return;
    const now = Date.now();
    if (!force && now - lastStatsAtRef.current < STATS_RECONCILE_MS) return;
    lastStatsAtRef.current = now;
    try {
      const { count: checked } = await insforge.database.from('checkins').select('id', { count: 'exact', head: true }).eq('event_id', id);
      const { count: total } = await insforge.database.from('tickets').select('id', { count: 'exact', head: true }).eq('event_id', id).eq('status', 'active');
      if (mountedRef.current) setStats({ checkedIn: checked || 0, total: total || 0 });
    } catch { /* ignore */ }
  }, [selectedEvent?.id]);

  useEffect(() => { if (active) loadStats(true); }, [active, loadStats]);

  // ── Scan → verify → result → resume ─────────────────────────────────────────
  const handleDecode = useCallback((raw: string) => {
    if (processingRef.current) return;
    const value = raw.trim();
    if (!value) return;
    const now = Date.now();
    if (value === lastScanRef.current.value && now - lastScanRef.current.at < SAME_CODE_DEBOUNCE_MS) return;

    processingRef.current = true;
    lastScanRef.current = { value, at: now };
    triggerHaptic('detect');

    validateTicket(value, currentUser.id, selectedEvent?.title).then((result) => {
      if (!mountedRef.current) return;
      triggerHaptic(result.status === 'valid' ? 'success' : 'error');
      if (result.status === 'valid') {
        setStats((s) => ({ checkedIn: s.checkedIn + 1, total: Math.max(s.total, s.checkedIn + 1) }));
        loadStats(false);
      }
      setOutcome(result);
      later(() => {
        setOutcome(null);
        processingRef.current = false;
      }, RESUME_MS[result.status]);
    });
  }, [currentUser?.id, selectedEvent?.title, later, loadStats]);

  // Decode loop is paused whenever a result is showing / being processed.
  useQrScanner({
    videoRef: cam.videoRef,
    enabled: active && cam.status === 'ready' && outcome === null,
    onDecode: handleDecode,
  });

  // ── Guards ──────────────────────────────────────────────────────────────────
  if (!isOrganizer) {
    return <GuardScreen onBack={onBack} icon={<Shield size={48} color="#EF4444" />} title="Organizers Only" body="The check-in scanner is only accessible to event organizers." />;
  }
  if (scanningDisabled) {
    return <GuardScreen onBack={onBack} icon={<ScanLine size={48} color="#8B8FA8" />} title="Scanning Temporarily Paused" body="Ticket scanning is temporarily disabled platform-wide. Please try again shortly." />;
  }
  if (!selectedEvent?.id) {
    return <GuardScreen onBack={onBack} icon={<CalendarX size={48} color="#F59E0B" />} title="No Event Selected" body="Open the scanner from an event's page or your organizer dashboard." />;
  }

  const pct = stats.total > 0 ? Math.round((stats.checkedIn / stats.total) * 100) : 0;
  const showFrame = cam.status === 'ready' && outcome === null;

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden', fontFamily: 'Inter, sans-serif' }}>
      {/* Live camera preview — owned by us, fills the screen, cannot collapse. */}
      <video
        ref={cam.videoRef}
        autoPlay
        muted
        playsInline
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}
      />

      {/* Scanning frame + dimmed mask */}
      {showFrame && <ScannerFrame />}

      {/* Result overlay */}
      {outcome && <ScanResultCard outcome={outcome} />}

      {/* Starting / error states over the black preview */}
      {cam.status !== 'ready' && cam.status !== 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontSize: '13px', gap: '14px' }}>
          <span style={{ width: '30px', height: '30px', borderRadius: '50%', border: '2px solid rgba(167,139,250,0.25)', borderTopColor: '#A78BFA', display: 'inline-block', animation: 'ventsSpin 0.8s linear infinite' }} />
          Starting camera…
          <style>{`@keyframes ventsSpin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      {cam.status === 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 28px', gap: '12px' }}>
          <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Camera size={32} color="#EF4444" />
          </div>
          <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, margin: 0 }}>Camera Unavailable</p>
          <p style={{ color: '#C4C9E0', fontSize: '13px', margin: 0, lineHeight: 1.6, maxWidth: '300px' }}>{cam.error}</p>
          <button onClick={cam.retry} style={{ marginTop: '6px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', borderRadius: '12px', padding: '12px 32px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}>
            Try Again
          </button>
        </div>
      )}

      {/* ── Top bar: back + event + camera controls ─────────────────────────── */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30, display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(16px + env(safe-area-inset-top)) 16px 14px', background: 'linear-gradient(to bottom, rgba(2,0,5,0.85), transparent)' }}>
        <button onClick={onBack} aria-label="Back" style={{ background: 'rgba(9,5,20,0.7)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '50%', width: '38px', height: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <ArrowLeft size={17} color="#F0F0FF" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ color: '#fff', fontSize: '16px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>Ticket Scanner</h1>
          {selectedEvent && (
            <p style={{ color: '#C4C9E0', fontSize: '11px', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedEvent.title}</p>
          )}
        </div>
        {cam.status === 'ready' && cam.canSwitchCamera && (
          <button onClick={cam.switchCamera} aria-label="Switch camera" style={{ background: 'rgba(9,5,20,0.7)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '50%', width: '38px', height: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <SwitchCamera size={17} color="#F0F0FF" />
          </button>
        )}
        {cam.status === 'ready' && cam.torchSupported && (
          <button onClick={cam.toggleTorch} aria-label="Toggle flashlight" style={{ background: cam.torchOn ? '#FFB830' : 'rgba(9,5,20,0.7)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '50%', width: '38px', height: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            {cam.torchOn ? <Flashlight size={17} color="#020005" /> : <FlashlightOff size={17} color="#F0F0FF" />}
          </button>
        )}
      </div>

      {/* ── Bottom: prompt + live check-in count ─────────────────────────────── */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30, padding: '20px 20px calc(22px + env(safe-area-inset-bottom))', background: 'linear-gradient(to top, rgba(2,0,5,0.9), transparent)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
        {showFrame && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10B981', boxShadow: '0 0 8px #10B981', animation: 'ventsLiveDot 1.3s ease-in-out infinite' }} />
            <span style={{ color: '#E6FFF4', fontSize: '13px', fontWeight: 700 }}>Point at a Vents ticket QR</span>
            <style>{`@keyframes ventsLiveDot { 0%,100% { opacity: 1; } 50% { opacity: .35; } }`}</style>
          </div>
        )}
        <div style={{ width: '100%', maxWidth: '340px', background: 'rgba(9,5,20,0.72)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '10px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '7px' }}>
            <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Checked in</span>
            <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>{stats.checkedIn} / {stats.total}<span style={{ color: '#A78BFA', marginLeft: '6px' }}>{pct}%</span></span>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '100px', height: '5px', overflow: 'hidden' }}>
            <div style={{ background: 'linear-gradient(90deg,#7B2FBE,#4F46E5)', borderRadius: '100px', height: '100%', width: `${pct}%`, transition: 'width 0.4s ease' }} />
          </div>
        </div>

        {/* Dev-only simulator: exercises the full verify path without a camera. */}
        {isDev && (
          <div style={{ width: '100%', maxWidth: '340px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <FlaskConical size={13} color="#F59E0B" style={{ flexShrink: 0 }} />
            <input value={simInput} onChange={(e) => setSimInput(e.target.value)} placeholder="payload.signature" style={{ flex: 1, minWidth: 0, background: '#060A12', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '8px', padding: '7px 10px', color: '#F0F0FF', fontSize: '12px', outline: 'none', fontFamily: 'monospace' }} />
            <button onClick={() => { if (simInput.trim()) handleDecode(simInput.trim()); }} style={{ background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '8px', padding: '7px 12px', color: '#F59E0B', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>Simulate</button>
          </div>
        )}
      </div>
    </div>
  );
}
