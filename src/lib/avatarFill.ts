// Initials avatars draw white initials on a per-user colour, and several of
// those colours (pink, amber, light green, sky blue) are too light for white
// text. avatarFill keeps the colour's hue and saturation and lowers only its
// brightness, just far enough to reach WCAG AA (4.5:1) against white, so
// each user keeps a recognisably "their" colour and gets the same fill on
// every screen. Colours that already pass, and anything that isn't a
// #rrggbb hex (e.g. 'transparent'), are returned unchanged.

const WHITE_TEXT_AA = 4.5;

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrastWithWhite([r, g, b]: number[]): number {
  const l = 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
  return 1.05 / (l + 0.05);
}

const scaled = (rgb: number[], k: number) => rgb.map((c) => Math.round(c * k));
const toHex = (rgb: number[]) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();

export function avatarFill(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  if (contrastWithWhite(rgb) >= WHITE_TEXT_AA) return color;
  // Scaling every channel by the same factor is a pure brightness change
  // (same HSV hue and saturation). Binary-search the largest factor that
  // passes, checked on the rounded result that will actually be rendered.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastWithWhite(scaled(rgb, mid)) >= WHITE_TEXT_AA) lo = mid;
    else hi = mid;
  }
  return toHex(scaled(rgb, lo));
}
