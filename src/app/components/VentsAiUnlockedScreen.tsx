// Exact reproduction of VentsPrototype.dc.html's `ai.ph.unlocked` state --
// the one place the approved prototype actually specifies an animated
// "orb" (every other VENTS AI view uses a plain text/glyph header, no
// orb). Three layered divs (outer glow halo, the lit sphere, a glossy
// highlight) and the prototype's own vglow/vfloat keyframes, reproduced
// value-for-value from its <style> block and this screen's inline styles.
//
// Shown once per session, exactly when AiAccessScreen's onContinue()
// fires with a REAL confirmed entitlement (App.tsx's
// ventsAiJustUnlocked) -- not a simulated transition. "Start planning"
// (ai.start in the prototype) dismisses it into the real VentsAiScreen.

export function VentsAiUnlockedScreen({ onStartPlanning }: { onStartPlanning: () => void }) {
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
      <div style={{ font: "800 26px 'Manrope', sans-serif", color: '#f4f2fa' }}>VENTS AI is unlocked</div>
      <div style={{ fontSize: '15px', color: '#b4aecb', lineHeight: 1.55 }}>
        Tell it a mood, a budget or an event.
      </div>
      <div style={{ width: '100%', maxWidth: '360px', marginTop: '12px' }}>
        <button
          onClick={onStartPlanning}
          style={{
            width: '100%', height: '52px', borderRadius: '26px', border: 0,
            background: '#8b5cf6', color: '#fff', font: "700 15px 'Manrope', sans-serif", cursor: 'pointer',
          }}
        >
          Start planning
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
