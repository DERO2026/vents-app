import { useState, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { openExternalUrl } from '../../lib/externalLink';

// Shown specifically before opening an organizer-provided external event
// link (Discord/Zoom/Google Meet/YouTube/other online-access URL) -- once
// someone leaves VENTS for that destination, VENTS has no control over it,
// mirroring Eventbrite's own boundary-setting for third-party links.
// Deliberately NOT wired into every existing openExternalUrl call site in
// the app (social links, help/support links, etc.) -- those are pre-
// existing, unrelated to this feature, and out of scope for this change.
export function useExternalLinkWarning() {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  const requestOpen = useCallback((url: string) => {
    setPendingUrl(url);
  }, []);

  const modal = pendingUrl ? (
    <ExternalLinkWarningModal
      url={pendingUrl}
      onCancel={() => setPendingUrl(null)}
      onConfirm={() => {
        const url = pendingUrl;
        setPendingUrl(null);
        openExternalUrl(url);
      }}
    />
  ) : null;

  return { requestOpen, modal };
}

function ExternalLinkWarningModal({ url, onCancel, onConfirm }: { url: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '480px', background: ventsColors.surface,
          borderRadius: '20px 20px 0 0', padding: '24px 20px calc(20px + env(safe-area-inset-bottom))',
          border: '1px solid rgba(255,255,255,0.08)', borderTop: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(245,158,11,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <AlertTriangle size={18} color="#F59E0B" />
          </div>
          <h3 style={{ margin: 0, color: ventsColors.white, fontSize: '17px', fontWeight: 800, fontFamily: 'Manrope, sans-serif' }}>
            You're leaving VENTS
          </h3>
        </div>
        <p style={{ color: ventsColors.ink2, fontSize: '13.5px', lineHeight: 1.6, margin: '0 0 10px' }}>
          This link will open a third-party website or app that isn't operated or controlled by VENTS. Be careful when sharing personal information, entering payment details, or interacting with other users on external platforms.
        </p>
        <p style={{ color: ventsColors.ink3, fontSize: '12.5px', lineHeight: 1.6, margin: '0 0 20px', wordBreak: 'break-all' }}>
          VENTS isn't responsible for the content, security, availability, or actions of third-party websites or services.
        </p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={onCancel}
            style={{ flex: 1, height: '50px', borderRadius: '14px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: ventsColors.ink1, fontSize: '15px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{ flex: 1, height: '50px', borderRadius: '14px', background: ventsColors.accent, border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', cursor: 'pointer' }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
