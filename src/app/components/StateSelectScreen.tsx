import { useState } from 'react';
import { MapPin, ChevronRight, Check } from 'lucide-react';
import { VentsLogo } from './VentsLogo';
import { Event } from './types';

export const NIGERIA_STATES = [
  { name: 'Abia', city: 'Umuahia', emoji: '📍', desc: 'God\'s Own State', events: 0 },
  { name: 'Adamawa', city: 'Yola', emoji: '📍', desc: 'Land of Beauty', events: 0 },
  { name: 'Akwa Ibom', city: 'Uyo', emoji: '📍', desc: 'Land of Promise', events: 0 },
  { name: 'Anambra', city: 'Awka', emoji: '📍', desc: 'Light of the Nation', events: 0 },
  { name: 'Bauchi', city: 'Bauchi', emoji: '📍', desc: 'Pearl of Tourism', events: 0 },
  { name: 'Bayelsa', city: 'Yenagoa', emoji: '📍', desc: 'Glory of all Lands', events: 0 },
  { name: 'Benue', city: 'Makurdi', emoji: '📍', desc: 'Food Basket of the Nation', events: 0 },
  { name: 'Borno', city: 'Maiduguri', emoji: '📍', desc: 'Home of Peace', events: 0 },
  { name: 'Cross River', city: 'Calabar', emoji: '🎪', desc: 'Tourism Capital · Calabar Carnival', events: 0 },
  { name: 'Delta', city: 'Asaba', emoji: '🌊', desc: 'The Finger of God', events: 0 },
  { name: 'Ebonyi', city: 'Abakaliki', emoji: '📍', desc: 'Salt of the Nation', events: 0 },
  { name: 'Edo', city: 'Benin City', emoji: '🎨', desc: 'Heartbeat of the Nation · Ancient Benin', events: 0 },
  { name: 'Ekiti', city: 'Ado Ekiti', emoji: '📍', desc: 'Land of Honour', events: 0 },
  { name: 'Enugu', city: 'Enugu', emoji: '🏙️', desc: 'Coal City State · Eastern Hub', events: 0 },
  { name: 'Federal Capital Territory (Abuja)', city: 'Abuja', emoji: '🏛️', desc: 'Federal Capital · Center of Unity', events: 0 },
  { name: 'Gombe', city: 'Gombe', emoji: '📍', desc: 'Jewel in the Savannah', events: 0 },
  { name: 'Imo', city: 'Owerri', emoji: '🎉', desc: 'Land of Hope · Eastern Hub', events: 0 },
  { name: 'Jigawa', city: 'Dutse', emoji: '📍', desc: 'The New World', events: 0 },
  { name: 'Kaduna', city: 'Kaduna', emoji: '🏔️', desc: 'Centre of Learning', events: 0 },
  { name: 'Kano', city: 'Kano', emoji: '🕌', desc: 'Centre of Commerce · Northern Hub', events: 0 },
  { name: 'Katsina', city: 'Katsina', emoji: '📍', desc: 'Home of Hospitality', events: 0 },
  { name: 'Kebbi', city: 'Birnin Kebbi', emoji: '📍', desc: 'Land of Equity', events: 0 },
  { name: 'Kogi', city: 'Lokoja', emoji: '📍', desc: 'The Confluence State', events: 0 },
  { name: 'Kwara', city: 'Ilorin', emoji: '🌾', desc: 'State of Harmony', events: 0 },
  { name: 'Lagos', city: 'Lagos', emoji: '🌆', desc: 'Commercial Capital · Entertainment Hub', events: 120 },
  { name: 'Nasarawa', city: 'Lafia', emoji: '📍', desc: 'Home of Solid Minerals', events: 0 },
  { name: 'Niger', city: 'Minna', emoji: '📍', desc: 'The Power State', events: 0 },
  { name: 'Ogun', city: 'Abeokuta', emoji: '🌿', desc: 'Gateway State · Abeokuta Rocks', events: 0 },
  { name: 'Ondo', city: 'Akure', emoji: '📍', desc: 'Sunshine State', events: 0 },
  { name: 'Osun', city: 'Osogbo', emoji: '🌺', desc: 'Land of Virtue · Cultural Heritage', events: 0 },
  { name: 'Oyo', city: 'Ibadan', emoji: '🎭', desc: 'Pace Setter State', events: 0 },
  { name: 'Plateau', city: 'Jos', emoji: '📍', desc: 'Home of Peace and Tourism', events: 0 },
  { name: 'Rivers', city: 'Port Harcourt', emoji: '⛽', desc: 'Treasure Base of the Nation', events: 0 },
  { name: 'Sokoto', city: 'Sokoto', emoji: '📍', desc: 'Seat of the Caliphate', events: 0 },
  { name: 'Taraba', city: 'Jalingo', emoji: '📍', desc: 'Nature\'s Gift to the Nation', events: 0 },
  { name: 'Yobe', city: 'Damaturu', emoji: '📍', desc: 'Pride of the Sahel', events: 0 },
  { name: 'Zamfara', city: 'Gusau', emoji: '📍', desc: 'Farming is our Pride', events: 0 }
];

export function eventMatchesState(event: Event, stateName: string): boolean {
  if (stateName === 'All States' || stateName === 'All Cities') return true;

  const cleanState = stateName.toLowerCase().replace(/\s+state$/, '').trim();
  const cleanEventState = (event.state || '').toLowerCase().replace(/\s+state$/, '').trim();
  const cleanEventCity = (event.city || '').toLowerCase().trim();

  if (cleanState.includes('abuja') || cleanState.includes('federal capital territory')) {
    return cleanEventCity.includes('abuja') || cleanEventState.includes('abuja') || cleanEventState.includes('federal capital territory');
  }

  return cleanEventState === cleanState || cleanEventCity === cleanState || cleanEventState.includes(cleanState) || cleanEventCity.includes(cleanState);
}


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
        background: '#020005',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: 'calc(28px + env(safe-area-inset-top)) 24px 20px',
          background: 'linear-gradient(180deg, #0D0520 0%, #020005 100%)',
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
          background: 'linear-gradient(to top, #020005 60%, transparent)',
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
