import React from 'react';

interface BadgeChipProps {
  tier: string | null | undefined;
}

const BADGE_STYLES: Record<string, React.CSSProperties> = {
  bronze: { background: '#CD7F32', color: 'white' },
  silver: { background: '#A8A9AD', color: 'white' },
  gold: { background: '#FFD700', color: '#333' },
  platinum: { background: '#E5E4E2', color: '#333' },
  elite: { background: '#090514', color: 'white', border: '1px solid #7B2FF7' },
  legend: { background: 'linear-gradient(90deg, #7B2FF7, #F107A3)', color: 'white' },
};

export default function BadgeChip({ tier }: BadgeChipProps) {
  if (!tier) return null;
  const key = tier.toLowerCase();
  const style = BADGE_STYLES[key];
  if (!style) return null;
  return (
    <span style={{
      ...style,
      height: 13,
      padding: '1px 4px',
      fontSize: 7,
      fontWeight: 800,
      borderRadius: 20,
      textTransform: 'uppercase' as const,
      marginLeft: 4,
      display: 'inline-flex',
      alignItems: 'center',
      whiteSpace: 'nowrap' as const,
      flexShrink: 0,
    }}>
      {tier}
    </span>
  );
}
