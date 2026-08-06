import { useEffect } from 'react';
import { VentsLogo } from './VentsLogo';
import { hideNativeSplash, applyNativeStatusBar } from '../../lib/native';

export function SplashScreen({ onComplete }: { onComplete: () => void }) {
  useEffect(() => {
    const t = setTimeout(onComplete, 2600);
    return () => clearTimeout(t);
  }, [onComplete]);

  // Runs on this component's own first paint — its background/logo match
  // the native launch splash pixel-for-pixel, so hiding the native one here
  // (rather than waiting for the JS bundle to fully settle) hands off
  // between the two with nothing visible in between.
  useEffect(() => {
    hideNativeSplash();
    applyNativeStatusBar(true);
  }, []);

  return (
    <div
      style={{
        background: 'radial-gradient(ellipse at 50% 0%, rgba(123,47,190,0.12) 0%, #050010 40%, #020005 100%)',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes splashFadeInScale {
          from { opacity: 0; transform: scale(0.75); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes splashFadeUp {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes splashDot {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
          40% { transform: scale(1); opacity: 1; }
        }
        @keyframes splashGlow {
          0%, 100% { opacity: 0.5; transform: translateX(-50%) scale(1); }
          50% { opacity: 0.9; transform: translateX(-50%) scale(1.15); }
        }
      `}</style>

      {/* Background glow orb */}
      <div
        style={{
          position: 'absolute',
          width: '340px',
          height: '340px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(124,58,237,0.22) 0%, transparent 70%)',
          top: '25%',
          left: '50%',
          transform: 'translateX(-50%)',
          animation: 'splashGlow 2.4s ease-in-out infinite',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: '200px',
          height: '200px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(79,70,229,0.18) 0%, transparent 70%)',
          bottom: '20%',
          right: '10%',
          pointerEvents: 'none',
        }}
      />

      {/* Logo */}
      <div
        style={{
          animation: 'splashFadeInScale 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
          opacity: 0,
        }}
      >
        <VentsLogo size={68} />
      </div>

      {/* Tagline */}
      <p
        style={{
          color: 'rgba(255,255,255,0.45)',
          fontSize: '13px',
          letterSpacing: '0.12em',
          marginTop: '14px',
          animation: 'splashFadeUp 0.6s ease-out 0.35s forwards',
          opacity: 0,
          textTransform: 'uppercase',
          fontWeight: 500,
          fontFamily: 'Inter, sans-serif',
        }}
      >
        Discover Nigeria's Best Events
      </p>

      {/* Loading dots */}
      <div
        style={{
          display: 'flex',
          gap: '7px',
          marginTop: '70px',
          animation: 'splashFadeUp 0.5s ease-out 0.6s forwards',
          opacity: 0,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: '#7B2FBE',
              animation: `splashDot 1.3s ease-in-out ${i * 0.18}s infinite`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
