import { useEffect, useState } from 'react';
import { Camera, Bell, Settings } from 'lucide-react';
import { registerPrimerHost } from '../../../lib/permissionPrimer';

type PrimerState = { kind: 'primer'; icon: 'camera' | 'bell'; title: string; message: string; onContinue: () => void; onNotNow: () => void };
type DeniedState = { kind: 'denied'; icon: 'camera' | 'bell'; title: string; message: string; onOpenSettings: () => void; onDismiss: () => void };

const ICONS = { camera: Camera, bell: Bell };

// Mounted once at the app root (App.tsx). Plain-JS callers (pickImage.ts,
// pushNotifications.ts) can't render React themselves, so they reach this via
// the registerPrimerHost bridge in lib/permissionPrimer.ts instead of each
// needing their own sheet markup.
export function PermissionSheetHost() {
  const [state, setState] = useState<PrimerState | DeniedState | null>(null);

  useEffect(() => {
    return registerPrimerHost({
      showPrimer: (req) => setState({ kind: 'primer', ...req }),
      showDenied: (req) => setState({ kind: 'denied', ...req }),
    });
  }, []);

  if (!state) return null;
  const Icon = ICONS[state.icon];

  const close = () => {
    if (state.kind === 'primer') state.onNotNow();
    else state.onDismiss();
    setState(null);
  };

  return (
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2,0,5,0.55)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'flex-end',
        animation: 'permissionBackdropIn 0.2s ease',
      }}
    >
      <style>{`
        @keyframes permissionBackdropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes permissionSheetIn { from { transform: translateY(24px); opacity: 0.6; } to { transform: translateY(0); opacity: 1; } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          background: '#0D0A1A',
          borderTopLeftRadius: '24px',
          borderTopRightRadius: '24px',
          border: '1px solid rgba(255,255,255,0.08)',
          borderBottom: 'none',
          boxShadow: '0 -20px 50px rgba(0,0,0,0.45)',
          padding: '28px 24px calc(24px + env(safe-area-inset-bottom))',
          animation: 'permissionSheetIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '18px',
            background: 'rgba(168,85,247,0.12)',
            border: '1px solid rgba(168,85,247,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '16px',
          }}
        >
          <Icon size={26} color="#A78BFA" />
        </div>
        <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: '0 0 8px', textAlign: 'center' }}>
          {state.title}
        </h3>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.5, textAlign: 'center', margin: '0 0 24px' }}>
          {state.message}
        </p>

        {state.kind === 'primer' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
            <button
              onClick={() => { state.onContinue(); setState(null); }}
              style={{
                background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
                border: 'none',
                borderRadius: '14px',
                padding: '14px',
                color: '#fff',
                fontSize: '15px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Continue
            </button>
            <button
              onClick={() => { state.onNotNow(); setState(null); }}
              style={{ background: 'none', border: 'none', padding: '10px', color: '#8B8FA8', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}
            >
              Not now
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
            <button
              onClick={() => { state.onOpenSettings(); setState(null); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
                border: 'none',
                borderRadius: '14px',
                padding: '14px',
                color: '#fff',
                fontSize: '15px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              <Settings size={16} />
              Open Settings
            </button>
            <button
              onClick={close}
              style={{ background: 'none', border: 'none', padding: '10px', color: '#8B8FA8', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}
            >
              Not now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
