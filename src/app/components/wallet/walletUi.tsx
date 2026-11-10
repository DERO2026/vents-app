// Small shared building blocks for the unified wallet (dark/purple VENTS
// look, 44px touch targets, safe-area aware sheets).
import React, { useEffect } from 'react';
import { ventsColors } from '../../../lib/ventsDesignTokens';

export const walletCard: React.CSSProperties = {
  background: ventsColors.surface,
  border: `1px solid ${ventsColors.border}`,
  borderRadius: 24,
  padding: 16,
  boxSizing: 'border-box',
  minWidth: 0,
};

export function Sheet({ title, onClose, children, testId, busy }: { title: string; onClose: () => void; children: React.ReactNode; testId: string; busy?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  return (
    <div data-testid={testId} role="dialog" aria-modal="true" aria-label={title}
      onClick={() => !busy && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 9500 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: '#110D1B', border: `1px solid ${ventsColors.border}`, borderBottom: 'none', borderRadius: '32px 32px 0 0', width: '100%', maxWidth: 480,
          maxHeight: 'calc(100dvh - 24px - env(safe-area-inset-top))', overflowY: 'auto', boxSizing: 'border-box',
          padding: '20px 20px calc(20px + env(safe-area-inset-bottom))', boxShadow: '0 -10px 50px rgba(124,58,237,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: ventsColors.ink1 }}>{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            style={{ minWidth: 44, minHeight: 44, background: 'none', border: 'none', color: ventsColors.ink2, fontSize: 22, cursor: busy ? 'not-allowed' : 'pointer' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PrimaryButton({ children, onClick, disabled, testId, tone = 'purple', type = 'button' }:
  { children: React.ReactNode; onClick?: () => void; disabled?: boolean; testId?: string; tone?: 'purple' | 'ghost' | 'danger'; type?: 'button' | 'submit' }) {
  const bg = tone === 'purple' ? 'linear-gradient(135deg, #8E5CF7 0%, #7B2FBE 100%)' : tone === 'danger' ? 'rgba(248,113,113,0.14)' : 'rgba(255,255,255,0.06)';
  const color = tone === 'danger' ? ventsColors.error : ventsColors.white;
  return (
    <button type={type} data-testid={testId} onClick={onClick} disabled={disabled}
      style={{ width: '100%', minHeight: 48, borderRadius: 999, border: tone === 'ghost' ? `1px solid ${ventsColors.border}` : 'none', background: bg, color,
        fontWeight: 800, fontSize: 15, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, boxSizing: 'border-box' }}>
      {children}
    </button>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} style={{ display: 'block', fontSize: 12, fontWeight: 700, color: ventsColors.ink2, margin: '12px 0 6px' }}>{children}</label>;
}

export const inputStyle: React.CSSProperties = {
  width: '100%', minHeight: 48, padding: '12px 16px', borderRadius: 18, border: `1px solid ${ventsColors.glassBorder}`,
  background: '#0B0912', color: ventsColors.ink1, fontSize: 16, boxSizing: 'border-box', outline: 'none',
};

export function DetailRow({ label, value, mono, testId }: { label: string; value: React.ReactNode; mono?: boolean; testId?: string }) {
  return (
    <div data-testid={testId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${ventsColors.divider}`, padding: '10px 0', fontSize: 13 }}>
      <span style={{ color: ventsColors.ink3, flexShrink: 0 }}>{label}</span>
      <span style={{ color: ventsColors.ink1, fontWeight: 600, textAlign: 'right', overflowWrap: 'anywhere', minWidth: 0, fontFamily: mono ? "'JetBrains Mono', monospace" : undefined }}>{value}</span>
    </div>
  );
}

export function Notice({ tone, children, testId }: { tone: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode; testId?: string }) {
  const c = tone === 'error' ? ventsColors.error : tone === 'warn' ? ventsColors.pending : tone === 'ok' ? ventsColors.success : ventsColors.accentSoft;
  return (
    <div data-testid={testId} role={tone === 'error' ? 'alert' : 'status'}
      style={{ border: `1px solid ${c}55`, background: `${c}14`, color: c, borderRadius: 18, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.45 }}>
      {children}
    </div>
  );
}
