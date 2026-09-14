// Codebase-wide VENTS design tokens — the canonical values from the
// approved redesign artifact ("VENTS Redesign.dc.html" §02, "the eight
// decisions everything else inherits"). This is the single source of
// truth these values should come from; components should import from
// here rather than re-inlining hex strings.
//
// NOT yet wired into existing screens. The app currently has at least
// three divergent inline palettes in production (#020005/#090514 used in
// ~80 places, servicesDesignTokens.ts's own #020005/#A855F7 set, and
// WalletScreen/UserWalletScreen's separate #020005/#0D0520 variant) —
// exactly the "terminology/tokens drift across surfaces" finding (A11) the
// design audit itself flagged. Migrating ~150 files of hardcoded inline
// styles to this module is a real, separate, carefully-tested effort
// (see VENTS_REDESIGN_IMPLEMENTATION_CHECKPOINT.md) — introducing it here
// first, without touching every screen in the same pass, so nothing with
// zero visual-regression test coverage gets silently broken.

export const ventsColors = {
  bg: '#08070C',
  surface: '#121019',
  elevated: '#1A1724',
  glassBg: 'rgba(255,255,255,0.07)',
  glassBorder: 'rgba(255,255,255,0.14)',
  border: 'rgba(255,255,255,0.09)',
  divider: 'rgba(255,255,255,0.06)',

  accent: '#8E5CF7',
  accentSoft: '#B79BFF',
  ambientGradient: 'linear-gradient(140deg,#2A1A4A,#0B0814)',

  success: '#34D399',
  pending: '#FBBF24',
  error: '#F87171',
  info: '#60A5FA',

  ink1: '#EDEAF5',
  ink2: 'rgba(237,234,245,0.66)',
  ink3: 'rgba(237,234,245,0.55)',

  white: '#FFFFFF',
} as const;

export const ventsTypography = {
  fontBody: "'Manrope', sans-serif",
  fontMono: "'JetBrains Mono', monospace",
  display: { fontSize: 40, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.02 },
  title: { fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1 },
  heading: { fontSize: 20, fontWeight: 700, letterSpacing: '-0.015em' },
  body: { fontSize: 16, fontWeight: 600 },
  bodySecondary: { fontSize: 15, fontWeight: 500 },
  caption: { fontSize: 13, fontWeight: 600 },
  label: { fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' as const },
  money: { fontVariantNumeric: 'tabular-nums lining-nums' as const, fontWeight: 800, letterSpacing: '-0.02em' },
} as const;

export const ventsSpacing = {
  pageMarginMobile: 20,
  unit: [4, 8, 12, 16, 20, 28, 40] as const,
  sectionGap: 28,
  cardPaddingSm: 16,
  cardPaddingLg: 20,
  scrollBottomPadding: 132,
  minTouchTarget: 44,
} as const;

export const ventsRadii = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

// Status badges (ticket/booking/payment states) — consistent bg+fg pairs,
// used as `{ background: ventsStatusColors.paid.bg, color: ventsStatusColors.paid.fg }`.
export const ventsStatusColors = {
  paid: { bg: 'rgba(52,211,153,0.16)', fg: '#6EE7B7' },
  pending: { bg: 'rgba(251,191,36,0.16)', fg: '#FCD34D' },
  expired: { bg: 'rgba(248,113,113,0.16)', fg: '#FCA5A5' },
  error: { bg: 'rgba(248,113,113,0.16)', fg: '#FCA5A5' },
  transferred: { bg: 'rgba(255,255,255,0.09)', fg: 'rgba(237,234,245,0.8)' },
  info: { bg: 'rgba(96,165,250,0.1)', fg: '#93C5FD' },
} as const;
