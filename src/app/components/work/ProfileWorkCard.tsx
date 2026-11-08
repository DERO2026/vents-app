import type { KeyboardEvent } from 'react';
import { ventsColors, ventsTypography } from '../../../lib/ventsDesignTokens';
import type { PillTone, RoleRow } from '../../../lib/workRoles';

// Profile -> VENTS Work entry card.
//
// Replaces the small HeroWork row whose chips listed only the roles a
// person had already engaged with, so Organizer / Provider / Representative
// were often invisible and the VENTS Cents balance was a grey pill. Now:
// a prominent heading, all four indicators always shown with their live
// state, and the whole card is one click/keyboard target (no nested
// buttons, so a tap anywhere opens VENTS Work).
//
// Colours are ventsColors tokens plus the purple accents VENTS already uses
// (accentStrong #7B2FBE, accent #8E5CF7). Indicator text stays >= 4.5:1
// on the dark tile background.

const TONE_STYLE: Record<PillTone, { color: string; background: string; dot: string }> = {
  on: { color: '#6EE7B7', background: 'rgba(52,211,153,0.14)', dot: '#34D399' },
  wait: { color: '#FCD34D', background: 'rgba(251,191,36,0.14)', dot: '#FBBF24' },
  off: { color: 'rgba(237,234,245,0.78)', background: 'rgba(255,255,255,0.07)', dot: 'rgba(237,234,245,0.45)' },
  soon: { color: ventsColors.accentSoft, background: 'rgba(142,92,247,0.16)', dot: ventsColors.accent },
};

export interface WorkIndicator {
  key: string;
  label: string;
  glyph: string;
  value: string;
  tone: PillTone;
}

export function workIndicators({ loading, organizer, provider, representative, vcSpendable }: {
  loading: boolean;
  organizer: RoleRow;
  provider: RoleRow;
  representative: RoleRow;
  vcSpendable: number | null;
}): WorkIndicator[] {
  const role = (r: RoleRow, glyph: string, label: string): WorkIndicator => ({
    key: r.key,
    label,
    glyph,
    value: loading ? '…' : r.pill.label,
    tone: loading ? 'off' : r.pill.tone,
  });
  return [
    role(organizer, '★', 'Organizer'),
    role(provider, '✦', 'Provider'),
    role(representative, '⇄', 'Representative'),
    {
      key: 'vc',
      label: 'VENTS Cents',
      glyph: '◎',
      value: vcSpendable === null ? (loading ? '…' : '—') : `${vcSpendable.toLocaleString('en-US')} VC`,
      tone: vcSpendable !== null && vcSpendable > 0 ? 'soon' : 'off',
    },
  ];
}

const CARD_CSS = `
.vents-work-card { transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease; }
.vents-work-card:hover { transform: translateY(-1px); border-color: rgba(167,139,250,0.65); box-shadow: 0 18px 48px -18px rgba(123,47,190,0.85), inset 0 1px 0 rgba(255,255,255,0.06); }
.vents-work-card:active { transform: translateY(0) scale(0.995); }
.vents-work-card:focus-visible { outline: 2px solid #B79BFF; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { .vents-work-card { transition: none; } .vents-work-card:hover { transform: none; } }
`;

export function ProfileWorkCard({ indicators, onOpen, testId = 'profile-vents-work-card' }: {
  indicators: WorkIndicator[];
  onOpen: () => void;
  testId?: string;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
  };
  const summary = indicators.map((i) => `${i.label}: ${i.value}`).join(', ');
  return (
    <>
      <style>{CARD_CSS}</style>
      <div
        data-testid={testId}
        className="vents-work-card"
        role="button"
        tabIndex={0}
        aria-label={`Open VENTS Work. ${summary}`}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        style={{
          position: 'relative',
          overflow: 'hidden',
          cursor: 'pointer',
          borderRadius: 20,
          padding: 18,
          display: 'grid',
          gap: 16,
          fontFamily: ventsTypography.fontBody,
          color: ventsColors.ink1,
          background: [
            'radial-gradient(120% 90% at 100% 0%, rgba(142,92,247,0.38) 0%, rgba(142,92,247,0) 55%)',
            'radial-gradient(90% 70% at 0% 100%, rgba(123,47,190,0.22) 0%, rgba(123,47,190,0) 60%)',
            'linear-gradient(160deg, #15102A 0%, #0B0816 55%, #07050E 100%)',
          ].join(', '),
          border: '1px solid rgba(142,92,247,0.42)',
          boxShadow: '0 14px 40px -18px rgba(123,47,190,0.75), inset 0 1px 0 rgba(255,255,255,0.05)',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.2em', textTransform: 'uppercase', color: ventsColors.accentSoft }}>
              Earn with VENTS
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 24, lineHeight: 1.15, fontWeight: 800, letterSpacing: '-0.02em', color: ventsColors.white }}>
              VENTS Work
            </h2>
            <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.45, color: 'rgba(237,234,245,0.74)' }}>
              Run events, offer services and represent others.
            </p>
          </div>
          <span
            aria-hidden
            style={{
              flexShrink: 0, width: 36, height: 36, borderRadius: '50%', display: 'grid', placeItems: 'center',
              background: 'linear-gradient(135deg, #8E5CF7 0%, #7B2FBE 100%)', color: ventsColors.white,
              fontSize: 18, fontWeight: 700, boxShadow: '0 6px 18px -4px rgba(142,92,247,0.7)',
            }}
          >
            ›
          </span>
        </div>

        {/* Indicators -- two columns on phones, four on wider screens. */}
        <div
          data-testid="vents-work-indicators"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 8 }}
        >
          {indicators.map((i) => {
            const t = TONE_STYLE[i.tone];
            return (
              <div
                key={i.key}
                data-testid={`vents-work-indicator-${i.key}`}
                data-tone={i.tone}
                style={{
                  minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 9px', borderRadius: 14,
                  background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0, width: 26, height: 26, borderRadius: 9, display: 'grid', placeItems: 'center',
                    background: 'rgba(142,92,247,0.18)', color: ventsColors.accentSoft, fontSize: 13,
                  }}
                >
                  {i.glyph}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: ventsColors.ink1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {i.label}
                  </div>
                  <div
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 3, padding: '2px 7px', borderRadius: 999,
                      background: t.background, color: t.color, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.02em',
                      maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', boxSizing: 'border-box',
                    }}
                  >
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: t.dot, flexShrink: 0 }} />
                    {i.value}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
