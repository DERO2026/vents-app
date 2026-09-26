import { useState } from 'react';
import { Check } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { CATEGORIES } from './categories';
import { ventsColors, ventsTypography, ventsRadii } from '../../lib/ventsDesignTokens';

interface InterestsScreenProps {
  userId: string;
  onDone: () => void;
}

const MIN_INTERESTS = 3;

export function InterestsScreen({ userId, onDone }: InterestsScreenProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function save(interests: string[]) {
    setSaving(true);
    setError(null);
    try {
      await supabase.from('users').update({ interests }).eq('id', userId);
      onDone();
    } catch (err: any) {
      setError(err?.message || 'Failed to save interests.');
      setSaving(false);
    }
  }

  const canContinue = selected.length >= MIN_INTERESTS;

  return (
    <div
      style={{
        background: ventsColors.bg,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Header */}
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 20px 16px', flexShrink: 0 }}>
        <p style={{ margin: '0 0 8px', fontFamily: ventsTypography.fontMono, fontSize: '11px', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: ventsColors.accentSoft }}>
          Personalize your feed
        </p>
        <h1
          style={{
            margin: 0,
            color: ventsColors.white,
            fontSize: '30px',
            fontWeight: 800,
            fontFamily: ventsTypography.fontBody,
            lineHeight: 1.12,
            letterSpacing: '-0.03em',
            marginBottom: '8px',
          }}
        >
          What are you into?
        </h1>
        <p style={{ margin: 0, color: ventsColors.ink2, fontSize: '15px', lineHeight: 1.55, maxWidth: '320px' }}>
          Pick at least {MIN_INTERESTS} — we'll use them to recommend events and services you'll actually like.
        </p>
      </div>

      {/* Interest cards */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px 140px', scrollbarWidth: 'none' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '10px',
          }}
        >
          {CATEGORIES.map((cat) => {
            const isSelected = selected.includes(cat.id);
            return (
              <div
                key={cat.id}
                onClick={() => toggle(cat.id)}
                style={{
                  minHeight: '84px',
                  boxSizing: 'border-box',
                  background: isSelected ? 'rgba(142,92,247,0.14)' : ventsColors.surface,
                  border: isSelected ? '1px solid rgba(142,92,247,0.55)' : `1px solid ${ventsColors.border}`,
                  borderRadius: `${ventsRadii.lg}px`,
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '10px',
                  cursor: 'pointer',
                  position: 'relative',
                  transition: 'all 0.2s ease',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                }}
              >
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: `${ventsRadii.sm}px`,
                    background: isSelected ? 'rgba(142,92,247,0.2)' : 'rgba(255,255,255,0.05)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '18px',
                    flexShrink: 0,
                  }}
                >
                  {cat.icon}
                </div>
                <span
                  style={{
                    color: isSelected ? ventsColors.white : ventsColors.ink1,
                    fontSize: '14px',
                    fontWeight: 700,
                    fontFamily: ventsTypography.fontBody,
                  }}
                >
                  {cat.label}
                </span>
                {isSelected && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '10px',
                      right: '10px',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      background: ventsColors.accent,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Check size={11} color={ventsColors.white} strokeWidth={3} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* CTA */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '14px 20px 32px',
          background: `linear-gradient(to top, ${ventsColors.bg} 60%, transparent)`,
        }}
      >
        {error && <p style={{ color: '#F87171', fontSize: '13px', textAlign: 'center', margin: '0 0 10px' }}>{error}</p>}
        <p style={{ color: ventsColors.ink3, fontSize: '12px', textAlign: 'center', margin: '0 0 12px', fontFamily: ventsTypography.fontMono, letterSpacing: '0.04em' }}>
          {selected.length} selected {canContinue ? '✓' : `(${MIN_INTERESTS - selected.length} more needed)`}
        </p>
        <button
          onClick={() => save(selected)}
          disabled={saving || !canContinue}
          style={{
            width: '100%',
            height: '56px',
            background: canContinue ? ventsColors.accent : 'rgba(255,255,255,0.05)',
            border: 'none',
            borderRadius: `${ventsRadii.lg}px`,
            padding: '0 16px',
            color: canContinue ? ventsColors.white : ventsColors.ink3,
            fontSize: '17px',
            fontWeight: 700,
            fontFamily: ventsTypography.fontBody,
            cursor: canContinue ? 'pointer' : 'not-allowed',
            boxShadow: canContinue ? '0 14px 40px -14px rgba(142,92,247,1)' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
            marginBottom: '10px',
          }}
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
        <button
          onClick={() => save([])}
          disabled={saving}
          style={{
            width: '100%',
            background: 'none',
            border: 'none',
            color: ventsColors.ink3,
            fontSize: '14px',
            fontWeight: 600,
            fontFamily: ventsTypography.fontBody,
            cursor: saving ? 'not-allowed' : 'pointer',
            padding: '6px',
          }}
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
