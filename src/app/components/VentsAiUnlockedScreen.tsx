import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { resolveHasRealAiAccess } from '../../lib/aiEntitlementClient';

// Exact reproduction of VentsPrototype.dc.html's `ai.ph.unlocked` state --
// the one place the approved prototype actually specifies an animated
// "orb" (every other VENTS AI view uses a plain text/glyph header, no
// orb). Three layered divs (outer glow halo, the lit sphere, a glossy
// highlight) and the prototype's own vglow/vfloat keyframes, reproduced
// value-for-value from its <style> block and this screen's inline styles.
//
// Shown once per session when AiAccessScreen's onContinue() fires --
// which today means EITHER a real confirmed entitlement (enforcement on)
// OR simply that app_config.ai_entitlement_enforced is off (production's
// current default), in which case onContinue() fires for literally every
// signed-in user regardless of whether they have ever paid for anything.
// The previous version of this screen unconditionally said "VENTS AI is
// unlocked" for both cases -- which is a false claim for a user with no
// real entitlement. This component now does its own lightweight
// get_my_ai_entitlement() read (the same STABLE, SECURITY DEFINER,
// auth.uid()-scoped RPC the status pill and AiAccessScreen itself use) to
// show the real "unlocked" copy only when a genuine, currently-valid
// entitlement exists (trialing/active/grace, not expired past any grace
// window) -- and an honest preview/upgrade message otherwise. This never
// blocks access (enforcement being off means the real chat screen is
// still reachable either way), it only stops claiming something false
// about the user's subscription state.

type RealAccessState = 'checking' | 'has_access' | 'no_access';

export function VentsAiUnlockedScreen({
  onStartPlanning,
  onViewPlans,
}: {
  onStartPlanning: () => void;
  onViewPlans?: () => void;
}) {
  const [realAccess, setRealAccess] = useState<RealAccessState>('checking');

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('get_my_ai_entitlement').then(({ data, error }) => {
      if (cancelled) return;
      setRealAccess(!error && resolveHasRealAiAccess(data) ? 'has_access' : 'no_access');
    });
    return () => { cancelled = true; };
  }, []);

  const hasRealAccess = realAccess === 'has_access';

  return (
    <div
      style={{
        background: '#07050d',
        width: '100%',
        height: '100%',
        padding: '20px 24px calc(140px + env(safe-area-inset-bottom, 0px))',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        textAlign: 'center',
      }}
    >
      <div style={{ position: 'relative', width: '120px', height: '120px', margin: '20px auto' }}>
        <div
          style={{
            position: 'absolute', inset: '-24px', borderRadius: '50%',
            background: 'radial-gradient(closest-side, rgba(139,92,246,.45), transparent)',
            animation: 'ventsAiOrbGlow 4.5s ease-in-out infinite',
          }}
        />
        <div
          style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: 'radial-gradient(circle at 32% 28%, #e9ddff 0%, #a78bfa 22%, #6d28d9 58%, #1b1140 100%)',
            boxShadow: 'inset 0 -10px 24px rgba(0,0,0,.45), inset 0 8px 18px rgba(255,255,255,.28)',
            animation: 'ventsAiOrbFloat 6s ease-in-out infinite',
          }}
        />
        <div
          style={{
            position: 'absolute', left: '24%', top: '16%', width: '34%', height: '20%',
            borderRadius: '50%', background: 'rgba(255,255,255,.35)', filter: 'blur(5px)',
          }}
        />
      </div>
      {realAccess === 'checking' ? (
        <div style={{ font: "800 26px 'Manrope', sans-serif", color: '#f4f2fa' }}>VENTS AI</div>
      ) : hasRealAccess ? (
        <div style={{ font: "800 26px 'Manrope', sans-serif", color: '#f4f2fa' }}>VENTS AI is unlocked</div>
      ) : (
        <div style={{ font: "800 26px 'Manrope', sans-serif", color: '#f4f2fa' }}>Welcome to VENTS AI</div>
      )}
      <div style={{ fontSize: '15px', color: '#b4aecb', lineHeight: 1.55 }}>
        {realAccess === 'checking'
          ? 'Checking your access…'
          : hasRealAccess
            ? 'Tell it a mood, a budget or an event.'
            : 'Subscribe to chat with VENTS AI about events, services and planning — or take a look around first.'}
      </div>
      <div style={{ width: '100%', maxWidth: '360px', marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {!hasRealAccess && realAccess !== 'checking' && onViewPlans && (
          <button
            onClick={onViewPlans}
            data-testid="vents-ai-unlocked-view-plans"
            style={{
              width: '100%', height: '52px', borderRadius: '26px', border: 0,
              background: '#8b5cf6', color: '#fff', font: "700 15px 'Manrope', sans-serif", cursor: 'pointer',
            }}
          >
            View Plans
          </button>
        )}
        <button
          onClick={onStartPlanning}
          data-testid="vents-ai-unlocked-continue"
          style={{
            width: '100%', height: '52px', borderRadius: '26px',
            border: !hasRealAccess && realAccess !== 'checking' ? '1px solid rgba(255,255,255,.18)' : 0,
            background: !hasRealAccess && realAccess !== 'checking' ? 'transparent' : '#8b5cf6',
            color: !hasRealAccess && realAccess !== 'checking' ? '#e4d4ff' : '#fff',
            font: "700 15px 'Manrope', sans-serif", cursor: 'pointer',
          }}
        >
          {!hasRealAccess && realAccess !== 'checking' ? 'Continue to VENTS AI' : 'Start planning'}
        </button>
      </div>
      <style>{`
        @keyframes ventsAiOrbGlow { 0%, 100% { opacity: .55; transform: scale(.94); } 50% { opacity: 1; transform: scale(1.06); } }
        @keyframes ventsAiOrbFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @media (prefers-reduced-motion: reduce) {
          @keyframes ventsAiOrbGlow { 0%, 100% { opacity: .8; transform: scale(1); } }
          @keyframes ventsAiOrbFloat { 0%, 100% { transform: translateY(0); } }
        }
      `}</style>
    </div>
  );
}
