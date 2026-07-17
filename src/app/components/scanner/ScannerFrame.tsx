// ── UI: scanning frame overlay ───────────────────────────────────────────────
// Pure presentational. Renders the dimmed mask with a transparent rounded
// window punched out (via an SVG mask so the cut-out is pixel-crisp on every
// screen), animated corner brackets, and a sweeping scan line. Purely visual —
// the actual decode region is computed independently from the video frame.

import React from 'react';

interface ScannerFrameProps {
  /** Window size as a fraction of the shorter viewport side. */
  ratio?: number;
  /** Suspends the sweep animation (e.g. while showing a result). */
  paused?: boolean;
  accent?: string;
}

export function ScannerFrame({ ratio = 0.68, paused = false, accent = '#A78BFA' }: ScannerFrameProps) {
  const pct = `${Math.round(ratio * 100)}%`;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <style>{`
        @keyframes ventsScanSweep { 0% { top: 8%; } 50% { top: 88%; } 100% { top: 8%; } }
        @keyframes ventsFramePulse { 0%,100% { opacity: .85; } 50% { opacity: 1; } }
      `}</style>

      {/* Dimmed mask with a transparent centered square window. */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, display: 'block' }} preserveAspectRatio="none">
        <defs>
          <mask id="vents-scan-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x="50%" y="50%"
              width={pct} height={pct}
              rx="28"
              transform="translate(-9999,-9999)"
              style={{ transform: `translate(calc(-${pct} / 2), calc(-${pct} / 2))` }}
              fill="black"
            />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(2,0,5,0.62)" mask="url(#vents-scan-mask)" />
      </svg>

      {/* The visible frame: brackets + sweep, sized to the same window. */}
      <div
        style={{
          position: 'absolute',
          top: '50%', left: '50%',
          width: pct, height: 0,
          paddingBottom: pct,
          transform: 'translate(-50%, -50%)',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, animation: paused ? 'none' : 'ventsFramePulse 2.4s ease-in-out infinite' }}>
          {([['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']] as const).map(([v, h], i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                width: '34px', height: '34px',
                [v]: '-1px', [h]: '-1px',
                [`border${v[0].toUpperCase()}${v.slice(1)}`]: `3px solid ${accent}`,
                [`border${h[0].toUpperCase()}${h.slice(1)}`]: `3px solid ${accent}`,
                [`border${v === 'top' ? 'TopLeft' : 'BottomLeft'}Radius`]: h === 'left' ? '14px' : undefined,
                [`border${v === 'top' ? 'TopRight' : 'BottomRight'}Radius`]: h === 'right' ? '14px' : undefined,
                boxShadow: `0 0 12px ${accent}66`,
              } as React.CSSProperties}
            />
          ))}
          {!paused && (
            <div
              style={{
                position: 'absolute', left: '7%', right: '7%', height: '2px',
                background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
                borderRadius: '2px',
                boxShadow: `0 0 10px ${accent}`,
                animation: 'ventsScanSweep 2.6s ease-in-out infinite',
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
