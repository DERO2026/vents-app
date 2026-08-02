import { createPortal } from 'react-dom';
import { PrimaryButton, SecondaryButton } from './shared/Button';

/**
 * In-app confirmation dialog — a replacement for window.confirm(), which on
 * mobile WebViews renders a native browser popup that looks out of place and
 * (on some Capacitor/iOS builds) can be dismissed or blocked inconsistently.
 * Rendered through a portal to document.body so it escapes the phone-frame's
 * overflow:hidden clipping, matching ImageCropperModal's approach.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 3000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        style={{
          width: '100%',
          maxWidth: '340px',
          background: '#0E0A1C',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '20px',
          padding: '22px 20px 18px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
        }}
      >
        <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700, margin: '0 0 8px', fontFamily: 'Space Grotesk, sans-serif' }}>
          {title}
        </h3>
        <p style={{ color: '#9BA0BC', fontSize: '13px', lineHeight: 1.5, margin: '0 0 20px' }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <SecondaryButton
            onClick={onCancel}
            size="sm"
            style={{ flex: 1, background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: '#C4C9E0', fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
          >
            {cancelLabel}
          </SecondaryButton>
          <PrimaryButton
            onClick={onConfirm}
            size="sm"
            style={danger ? { flex: 1, background: '#DC2626', boxShadow: 'none' } : { flex: 1 }}
          >
            {confirmLabel}
          </PrimaryButton>
        </div>
      </div>
    </div>,
    document.body
  );
}
