import { useState } from 'react';
import { MapPin, ChevronRight, Check } from 'lucide-react';
import { VentsLogo } from './VentsLogo';

export const NIGERIA_STATES = [
  { name: 'Lagos', city: 'Lagos', emoji: '🌆', desc: 'Commercial capital · Entertainment hub', events: 120 },
  { name: 'Abuja', city: 'Abuja', emoji: '🏛️', desc: 'Federal capital · International events', events: 85 },
  { name: 'Rivers', city: 'Port Harcourt', emoji: '⛽', desc: 'Oil city · Vibrant music scene', events: 64 },
  { name: 'Oyo', city: 'Ibadan', emoji: '🎭', desc: 'Ancient city · Cultural festivals', events: 48 },
  { name: 'Kano', city: 'Kano', emoji: '🕌', desc: 'Northern commercial hub', events: 42 },
  { name: 'Delta', city: 'Warri', emoji: '🌊', desc: 'Delta culture · Urhobo festivals', events: 36 },
  { name: 'Anambra', city: 'Onitsha', emoji: '🏘️', desc: 'Igbo heartland · Trade fairs', events: 34 },
  { name: 'Ogun', city: 'Abeokuta', emoji: '🌿', desc: 'Gateway state · Close to Lagos', events: 30 },
  { name: 'Kaduna', city: 'Kaduna', emoji: '🏔️', desc: 'Northern Nigeria · Political hub', events: 28 },
  { name: 'Edo', city: 'Benin City', emoji: '🎨', desc: 'Ancient kingdom · Arts & culture', events: 26 },
  { name: 'Imo', city: 'Owerri', emoji: '🎉', desc: 'Party capital of the East', events: 24 },
  { name: 'Enugu', city: 'Enugu', emoji: '🏙️', desc: 'Coal city · Eastern hub', events: 22 },
  { name: 'Cross River', city: 'Calabar', emoji: '🎪', desc: 'Tourism capital · Calabar Carnival', events: 20 },
  { name: 'Kwara', city: 'Ilorin', emoji: '🌾', desc: 'Middle Belt · Gateway to north', events: 18 },
  { name: 'Osun', city: 'Osogbo', emoji: '🌺', desc: 'Cultural heritage · Osun festival', events: 14 },
];

interface StateSelectScreenProps {
  onContinue: (state: typeof NIGERIA_STATES[0]) => void;
  selectedStateName?: string;
}

export function StateSelectScreen({ onContinue, selectedStateName }: StateSelectScreenProps) {
  const [selected, setSelected] = useState<string>(selectedStateName || '');

  const selectedState = NIGERIA_STATES.find((s) => s.name === selected);

  return (
    <div
      style={{
        background: '#060A12',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '28px 24px 20px',
          background: 'linear-gradient(180deg, #0D0520 0%, #060A12 100%)',
          flexShrink: 0,
        }}
      >
        <div style={{ marginBottom: '16px' }}>
          <VentsLogo size={32} />
        </div>
        <h1
          style={{
            color: '#F0F0FF',
            fontSize: '26px',
            fontWeight: 800,
            fontFamily: 'Space Grotesk, sans-serif',
            lineHeight: 1.2,
            marginBottom: '6px',
          }}
        >
          Where are you{' '}
          <span style={{ color: '#A855F7' }}>located?</span>
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.5 }}>
          We'll show you the best events happening near you.
        </p>
      </div>

      {/* State grid */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 16px 100px',
          scrollbarWidth: 'none',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {NIGERIA_STATES.map((state) => {
            const isSelected = selected === state.name;
            return (
              <div
                key={state.name}
                onClick={() => setSelected(state.name)}
                style={{
                  background: isSelected ? 'rgba(168,85,247,0.12)' : '#131629',
                  border: isSelected ? '1.5px solid rgba(168,85,247,0.45)' : '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '16px',
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
              >
                <div
                  style={{
                    width: '46px',
                    height: '46px',
                    borderRadius: '13px',
                    background: isSelected ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '22px',
                    flexShrink: 0,
                  }}
                >
                  {state.emoji}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                    <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>{state.name}</p>
                    <span
                      style={{
                        color: '#8B8FA8',
                        fontSize: '12px',
                        fontWeight: 400,
                      }}
                    >
                      · {state.city}
                    </span>
                  </div>
                  <p style={{ color: '#8B8FA8', fontSize: '12px', lineHeight: 1.4 }}>{state.desc}</p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                  <div
                    style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '50%',
                      background: isSelected ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : 'transparent',
                      border: isSelected ? 'none' : '2px solid rgba(255,255,255,0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {isSelected && <Check size={12} color="#fff" strokeWidth={3} />}
                  </div>
                  <span
                    style={{
                      color: isSelected ? '#A855F7' : '#5A5A7A',
                      fontSize: '10px',
                      fontWeight: 600,
                    }}
                  >
                    {state.events}+ events
                  </span>
                </div>
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
          background: 'linear-gradient(to top, #060A12 60%, transparent)',
        }}
      >
        <button
          onClick={() => selectedState && onContinue(selectedState)}
          disabled={!selected}
          style={{
            width: '100%',
            background: selected
              ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)'
              : 'rgba(123,47,190,0.25)',
            border: 'none',
            borderRadius: '16px',
            padding: '16px',
            color: selected ? '#fff' : 'rgba(255,255,255,0.35)',
            fontSize: '17px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: selected ? 'pointer' : 'not-allowed',
            boxShadow: selected ? '0 8px 28px rgba(123,47,190,0.45)' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            transition: 'all 0.2s ease',
          }}
        >
          <MapPin size={16} />
          {selected ? `Continue with ${selected}` : 'Select your state'}
          {selected && <ChevronRight size={16} />}
        </button>
      </div>
    </div>
  );
}
