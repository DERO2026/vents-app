// Shared UI primitives for the Admin Console, ported verbatim (styling and
// behavior unchanged) from the legacy AdminDashboardScreen.tsx as part of
// its full retirement — every destructive/consequential admin action across
// the new console uses this same ConfirmModal, so behavior is identical to
// what admins already relied on.
import React, { useState } from 'react';
import { AlertCircle, Copy, CheckCircle } from 'lucide-react';

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = true,
  // When set, the confirm button stays disabled until the admin types this
  // exact word (case-insensitive) — the "type CANCEL/REFUND to confirm"
  // guard for higher-stakes actions.
  typedConfirmationText,
  requireReason,
  optionalReason,
  reasonPlaceholder = 'Reason (shown to the affected user)',
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  typedConfirmationText?: string;
  requireReason?: boolean;
  optionalReason?: boolean;
  reasonPlaceholder?: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}) {
  const [typedValue, setTypedValue] = useState('');
  const [reasonValue, setReasonValue] = useState('');
  const showReasonField = requireReason || optionalReason;
  const typedMatches = !typedConfirmationText || typedValue.trim().toUpperCase() === typedConfirmationText.toUpperCase();
  const reasonOk = !requireReason || reasonValue.trim().length > 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '24px',
    }}>
      <div style={{
        background: '#090514', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '20px',
        padding: '28px 24px', maxWidth: '340px', width: '100%', textAlign: 'center',
      }}>
        <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <AlertCircle size={24} color="#EF4444" />
        </div>
        <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, margin: '0 0 8px', fontFamily: 'Manrope, sans-serif' }}>{title}</h3>
        <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.5, margin: '0 0 24px' }}>{message}</p>
        {typedConfirmationText && (
          <div style={{ marginBottom: '20px', textAlign: 'left' }}>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '6px' }}>
              Type <span style={{ color: '#EF4444' }}>{typedConfirmationText}</span> to confirm
            </p>
            <input
              autoFocus
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={typedConfirmationText}
              style={{ width: '100%', background: '#060A12', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '14px', fontWeight: 700, letterSpacing: '0.05em', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
        )}
        {showReasonField && (
          <div style={{ marginBottom: '20px', textAlign: 'left' }}>
            <textarea
              autoFocus
              value={reasonValue}
              onChange={(e) => setReasonValue(e.target.value)}
              placeholder={reasonPlaceholder}
              rows={3}
              style={{ width: '100%', background: '#060A12', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', boxSizing: 'border-box', resize: 'none' }}
            />
          </div>
        )}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onCancel} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '12px', color: '#C4C9E0', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm(showReasonField ? reasonValue.trim() : undefined)}
            disabled={!typedMatches || !reasonOk}
            style={{
              flex: 1,
              background: (!typedMatches || !reasonOk) ? 'rgba(255,255,255,0.05)' : danger ? 'rgba(239,68,68,0.15)' : 'rgba(168,85,247,0.15)',
              border: `1px solid ${(!typedMatches || !reasonOk) ? 'rgba(255,255,255,0.1)' : danger ? 'rgba(239,68,68,0.4)' : 'rgba(168,85,247,0.4)'}`,
              borderRadius: '12px', padding: '12px',
              color: (!typedMatches || !reasonOk) ? '#555C7A' : danger ? '#EF4444' : '#A855F7',
              fontSize: '14px', fontWeight: 700,
              cursor: (typedMatches && reasonOk) ? 'pointer' : 'not-allowed',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: copied ? '#10B981' : '#555C7A', display: 'flex', alignItems: 'center' }}
      title="Copy UID"
    >
      {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
    </button>
  );
}
