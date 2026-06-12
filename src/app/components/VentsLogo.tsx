export function VentsLogo({ size = 46 }: { size?: number }) {
  const barW = Math.round(size * 0.62);
  const barH = Math.round(size * 0.16);
  const midBarW = Math.round(size * 0.46);
  const gap = Math.round(size * 0.11);
  const containerH = Math.round(size * 0.88);

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: 'Space Grotesk, sans-serif',
        fontWeight: 800,
        fontSize: `${size}px`,
        letterSpacing: '-1.5px',
        color: '#FFFFFF',
        lineHeight: 1,
        userSelect: 'none',
        gap: 0,
      }}
    >
      <span>V</span>

      {/* E → three horizontal purple bars (top, middle, bottom) */}
      <span
        style={{
          display: 'inline-flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: `${gap}px`,
          width: `${barW}px`,
          height: `${containerH}px`,
          margin: `0 ${Math.round(size * 0.04)}px`,
          flexShrink: 0,
          filter: [
            'drop-shadow(0 0 3px rgba(168,85,247,1))',
            'drop-shadow(0 0 8px rgba(168,85,247,0.8))',
            'drop-shadow(0 0 18px rgba(124,58,237,0.5))',
          ].join(' '),
        }}
      >
        {/* Top bar — full width */}
        <span style={{ display: 'block', width: `${barW}px`, height: `${barH}px`, borderRadius: '3px', background: '#A855F7' }} />
        {/* Middle bar — shorter */}
        <span style={{ display: 'block', width: `${midBarW}px`, height: `${barH}px`, borderRadius: '3px', background: '#A855F7' }} />
        {/* Bottom bar — full width */}
        <span style={{ display: 'block', width: `${barW}px`, height: `${barH}px`, borderRadius: '3px', background: '#A855F7' }} />
      </span>

      <span>NTS</span>
    </div>
  );
}
