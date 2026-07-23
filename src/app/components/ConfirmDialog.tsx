import { createPortal } from 'react-dom';

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
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: '12px',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.12)',
              color: '#C4C9E0',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: '12px',
              border: 'none',
              background: danger ? '#DC2626' : 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
