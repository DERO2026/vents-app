// The real, official VENTS wordmark asset (public/brand/vents-logo*.png) --
// never redrawn/reinterpreted in CSS. This used to be a hand-built CSS
// recreation (text + glowing bars) because no real asset had ever been
// supplied to this codebase; one was provided with the QR/scanner/media
// design pass and belongs here instead, per the redesign's own standing
// rule to use the supplied logo assets exactly.
export function VentsLogo({ size = 46 }: { size?: number }) {
  // The source asset is a 430x150 wordmark (≈2.87:1) -- height-constrained
  // so it drops into the same inline slots the old CSS version used
  // (AuthScreen/HomeScreen/StateSelectScreen/WelcomeScreen all pass a
  // pixel `size` meant as a line-height-ish box).
  const height = Math.round(size * 0.62);
  return (
    <img
      src="/brand/vents-logo-small.png"
      alt="VENTS"
      style={{ height: `${height}px`, width: 'auto', display: 'block', userSelect: 'none' }}
      draggable={false}
    />
  );
}
