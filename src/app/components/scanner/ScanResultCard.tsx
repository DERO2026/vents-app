// ── UI: scan result overlay (success / error) ────────────────────────────────
// Pure presentational. Renders a full-frame verdict over the still-running
// preview: a large animated status glyph plus attendee/ticket/event detail on
// success, or a clear reason on failure. Auto-dismissal is the caller's job.

import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { ScanOutcome } from './ticketValidation';

const THEME = {
  valid: { color: '#10B981', glow: 'rgba(16,185,129,0.45)', ring: 'rgba(16,185,129,0.16)' },
  already_scanned: { color: '#F59E0B', glow: 'rgba(245,158,11,0.45)', ring: 'rgba(245,158,11,0.16)' },
  denied: { color: '#EF4444', glow: 'rgba(239,68,68,0.45)', ring: 'rgba(239,68,68,0.16)' },
} as const;

export function ScanResultCard({ outcome }: { outcome: ScanOutcome }) {
  const t = THEME[outcome.status];
  const Icon = outcome.status === 'valid' ? CheckCircle2 : outcome.status === 'already_scanned' ? AlertTriangle : XCircle;

  return (
    <div
      key={outcome.headline + (outcome.checkinTime || '') + (outcome.errorMsg || '')}
      style={{
        position: 'absolute', inset: 0, zIndex: 20,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '32px 24px', textAlign: 'center',
        background: `radial-gradient(circle at 50% 42%, ${t.ring} 0%, rgba(2,0,5,0.86) 55%, rgba(2,0,5,0.94) 100%)`,
        animation: 'ventsResultIn 0.22s ease-out',
      }}
    >
      <style>{`
        @keyframes ventsResultIn { 0% { opacity: 0; } 100% { opacity: 1; } }
        @keyframes ventsResultPop { 0% { transform: scale(.6); opacity: 0; } 60% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 1; } }
        @keyframes ventsResultRing { 0% { transform: scale(.8); opacity: .7; } 100% { transform: scale(1.5); opacity: 0; } }
      `}</style>

      <div style={{ position: 'relative', width: '96px', height: '96px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px' }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${t.color}`, animation: 'ventsResultRing 0.9s ease-out forwards' }} />
        <div style={{ width: '96px', height: '96px', borderRadius: '50%', background: t.ring, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 40px ${t.glow}`, animation: 'ventsResultPop 0.3s ease-out' }}>
          <Icon size={54} color={t.color} strokeWidth={2.4} />
        </div>
      </div>

      <h2 style={{ color: t.color, fontSize: '24px', fontWeight: 900, letterSpacing: '0.02em', margin: '0 0 6px', fontFamily: 'Space Grotesk, sans-serif' }}>
        {outcome.headline}
      </h2>

      {outcome.status === 'valid' ? (
        <>
          {outcome.holderName && (
            <p style={{ color: '#F5F5FF', fontSize: '19px', fontWeight: 800, margin: '6px 0 2px' }}>{outcome.holderName}</p>
          )}
          {outcome.ticketType && (
            <span style={{ display: 'inline-block', color: '#FFB830', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', background: 'rgba(255,184,48,0.12)', border: '1px solid rgba(255,184,48,0.4)', borderRadius: '100px', padding: '4px 14px', margin: '6px 0' }}>
              {outcome.ticketType}
            </span>
          )}
          {outcome.eventName && (
            <p style={{ color: '#C4C9E0', fontSize: '13px', margin: '6px 0 0' }}>{outcome.eventName}</p>
          )}
          {outcome.checkinTime && (
            <p style={{ color: '#8B8FA8', fontSize: '12.5px', margin: '4px 0 0' }}>Checked in at {outcome.checkinTime}</p>
          )}
          <p style={{ color: t.color, fontSize: '13px', fontWeight: 700, margin: '16px 0 0' }}>Checked In Successfully</p>
        </>
      ) : (
        <>
          {outcome.holderName && (
            <p style={{ color: '#F5F5FF', fontSize: '16px', fontWeight: 700, margin: '4px 0 2px' }}>{outcome.holderName}</p>
          )}
          {outcome.errorMsg && (
            <p style={{ color: '#C4C9E0', fontSize: '14px', lineHeight: 1.5, margin: '6px 0 0', maxWidth: '300px' }}>{outcome.errorMsg}</p>
          )}
        </>
      )}
    </div>
  );
}
