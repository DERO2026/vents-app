// The design system's own foundational rule (§02: "ambient · radial · 1 per
// screen, top") -- a purple radial glow behind the top of every screen.
// Purely decorative: absolutely positioned, non-interactive, painted first
// so normal DOM order puts every real element above it. The parent screen
// must have `position: relative` (or fixed) and `overflow: hidden` so the
// glow doesn't bleed past the screen's own bounds or shift layout.
export function AmbientGlow() {
  return (
    <div
      style={{
        position: 'absolute', top: '-200px', left: '50%', transform: 'translateX(-50%)',
        width: '560px', height: '500px', borderRadius: '9999px',
        background: 'radial-gradient(circle, rgba(142,92,247,0.2) 0%, rgba(142,92,247,0) 68%)',
        pointerEvents: 'none', zIndex: 0,
      }}
    />
  );
}
