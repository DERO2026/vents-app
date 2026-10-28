// Apple App Store rejection (Guideline 3.1.1, submission
// 3098bebc-a2ff-43de-8b7e-358a82693200): VENTS AI/AI+ could be purchased
// in the iOS app through Paystack instead of Apple In-App Purchase. PR #18
// removed the Paystack purchase buttons from AiPlansScreen on iOS, but
// left the rest of the real VENTS AI chat/paywall flow (AiAccessScreen's
// "Choose a plan"/"Renew" CTAs, VentsAiUnlockedScreen's "View Plans",
// VentsAiScreen's own internal AiPlansScreen) reachable on iOS -- those
// screens still describe paid plans and entitlement state, just without a
// working Subscribe button, which reads as broken rather than "not here
// yet." Real Apple In-App Purchase doesn't exist in this codebase (no
// StoreKit/RevenueCat/Capacitor purchase plugin anywhere) and isn't
// something to build and ship in a resubmission window.
//
// This screen replaces that entire flow on iOS with one honest, static
// "coming soon" destination. It makes no server call, grants nothing,
// shows no plan/price/entitlement data, and has exactly one action: go
// back. App.tsx is the only place that decides whether this screen or the
// real AiAccessScreen/VentsAiScreen stack renders for `screen ===
// 'vents-ai'` -- every entry point into VENTS AI (the bottom-nav tab, the
// Home/Services sparkle, "Ask VENTS AI to plan this night" on event
// details) already funnels through that one `navigateTo('vents-ai')`
// screen, so gating there covers all of them without touching any of the
// call sites themselves. Web is untouched -- App.tsx only swaps in this
// screen when Capacitor reports a native shell (see isMobileNativeForAiGate()
// in src/lib/platform.ts).
//
// Reused as-is for the Android restriction added later (same Google Play
// Payments Policy problem as Apple's Guideline 3.1.1 -- VENTS AI/AI+ sold
// via Paystack, not the platform's own billing): kept the component name
// (it's an internal identifier, not user-facing) but the copy below is
// platform-neutral -- it never claims the feature is "live" on whichever
// native platform isn't the one currently rendering this screen, since
// that claim would be false the instant both iOS and Android are gated.

const ACCENT_FILL = '#8E5CF7';
const BG = '#0a0810';
const SURFACE = '#120e1a';
const BORDER = '#2c2438';
const INK1 = '#f2eff6';
const INK2 = '#c9c0d4';
const INK3 = '#8a7f97';

export function VentsAiIosComingSoonScreen({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ background: BG, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 12px', borderBottom: `1px solid ${BORDER}` }}>
        <button
          onClick={onClose}
          aria-label="Close"
          data-testid="vents-ai-ios-coming-soon-close"
          style={{ width: 34, height: 34, borderRadius: 10, background: SURFACE, border: `1px solid ${BORDER}`, color: '#e4d4ff', fontSize: 16, cursor: 'pointer' }}
        >
          ✕
        </button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 800, color: INK1, marginRight: 34 }}>VENTS AI</div>
      </div>

      <div
        data-testid="vents-ai-ios-coming-soon"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '32px 28px calc(48px + env(safe-area-inset-bottom, 0px))',
          gap: 14,
        }}
      >
        <div style={{ position: 'relative', width: 96, height: 96, marginBottom: 6 }}>
          <div
            style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: '#8E5CF7', // ventsColors.accent -- solid orb, no gradient
            }}
          />
        </div>

        <div
          data-testid="vents-ai-ios-coming-soon-badge"
          style={{
            fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
            color: '#d3b8ff', background: 'rgba(139,92,246,.16)', border: '1px solid rgba(139,92,246,.35)',
            borderRadius: 999, padding: '5px 14px',
          }}
        >
          Coming soon
        </div>

        <div style={{ font: "800 24px 'Manrope', sans-serif", color: INK1 }}>VENTS AI is coming to the app</div>

        <p style={{ fontSize: 14, color: INK2, lineHeight: 1.55, maxWidth: 320, margin: 0 }}>
          We're preparing the mobile app experience for VENTS AI. It isn't available in the app yet, but it's
          already live on the web.
        </p>
        <p style={{ fontSize: 12.5, color: INK3, lineHeight: 1.5, maxWidth: 320, margin: 0 }}>
          If you already have a VENTS AI subscription, it hasn't changed — manage it from the web in the meantime.
        </p>

        <button
          onClick={onClose}
          data-testid="vents-ai-ios-coming-soon-back"
          style={{
            marginTop: 10, width: '100%', maxWidth: 280, height: 48, borderRadius: 24, border: 0,
            background: ACCENT_FILL, color: '#fff', font: "700 15px 'Manrope', sans-serif", cursor: 'pointer',
          }}
        >
          Back to VENTS
        </button>
      </div>

      <style>{`
        @keyframes ventsAiComingSoonGlow { 0%, 100% { opacity: .5; transform: scale(.94); } 50% { opacity: .9; transform: scale(1.05); } }
        @media (prefers-reduced-motion: reduce) {
          @keyframes ventsAiComingSoonGlow { 0%, 100% { opacity: .75; transform: scale(1); } }
        }
      `}</style>
    </div>
  );
}
