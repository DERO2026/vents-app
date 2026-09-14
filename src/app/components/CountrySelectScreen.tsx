import { useMemo, useState } from 'react';
import { ArrowLeft, Search, Check, ChevronRight } from 'lucide-react';
import { COUNTRY_CODES, CountryOption } from '../../lib/countries';
import { CountryMark } from './PhoneInput';
import { ventsColors, ventsTypography, ventsRadii } from '../../lib/ventsDesignTokens';

// The account/home-country step in the signup flow (Choose Country ->
// Create Account -> Email Verification -> Account Created -> Home). This is
// deliberately just account metadata, not an access boundary: it does NOT
// restrict which events a user can see or buy tickets for (event
// visibility has no country/state filter anywhere in this codebase -- see
// the select_events RLS policy, which is purely deletion/ownership based).
// It exists so the account has a home country on record (for display,
// defaults, and future country-specific features) and to pre-fill the
// signup form's phone-country picker with a sensible starting point --
// nothing more.

interface CountrySelectScreenProps {
  onContinue: (country: CountryOption) => void;
  onBack: () => void;
  selectedIso?: string;
}

export function CountrySelectScreen({ onContinue, onBack, selectedIso }: CountrySelectScreenProps) {
  const [selected, setSelected] = useState<string>(selectedIso || '');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return COUNTRY_CODES;
    return COUNTRY_CODES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.includes(q) || c.iso.toLowerCase() === q
    );
  }, [search]);

  const selectedCountry = COUNTRY_CODES.find((c) => c.iso === selected);

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
      <div
        style={{
          padding: 'calc(20px + env(safe-area-inset-top)) 20px 16px',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: ventsColors.glassBg,
            border: `1px solid ${ventsColors.glassBorder}`,
            borderRadius: '50%',
            width: '44px',
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            marginBottom: '26px',
          }}
        >
          <ArrowLeft size={18} color={ventsColors.white} />
        </button>
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
          Where's home{' '}
          <span style={{ color: ventsColors.accentSoft }}>for you?</span>
        </h1>
        <p style={{ margin: 0, color: ventsColors.ink2, fontSize: '15px', lineHeight: 1.55, maxWidth: '300px' }}>
          This sets your account's home country — you'll still see and book events everywhere on VENTS.
        </p>
      </div>

      {/* Search */}
      <div style={{ padding: '4px 20px 8px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', height: '50px', background: ventsColors.elevated, border: `1px solid ${ventsColors.glassBorder}`, borderRadius: `${ventsRadii.md}px`, padding: '0 16px' }}>
          <Search size={16} color={ventsColors.ink3} style={{ flexShrink: 0 }} />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search countries"
            style={{ flex: 1, minWidth: 0, height: '100%', background: 'none', border: 'none', outline: 'none', color: ventsColors.white, fontSize: '16px', fontFamily: ventsTypography.fontBody }}
          />
        </div>
      </div>

      {/* Country list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '10px 20px 100px',
          scrollbarWidth: 'none',
        }}
      >
        {filtered.length === 0 ? (
          <p style={{ color: ventsColors.ink3, fontSize: '14px', textAlign: 'center', padding: '24px 20px' }}>
            No countries match "{search}".
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filtered.map((country) => {
              const isSelected = selected === country.iso;
              return (
                <div
                  key={country.iso}
                  onClick={() => setSelected(country.iso)}
                  style={{
                    height: '64px',
                    boxSizing: 'border-box',
                    background: isSelected ? 'rgba(142,92,247,0.14)' : ventsColors.surface,
                    border: isSelected ? `1px solid rgba(142,92,247,0.55)` : `1px solid ${ventsColors.border}`,
                    borderRadius: `${ventsRadii.lg}px`,
                    padding: '0 18px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '14px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
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
                      flexShrink: 0,
                    }}
                  >
                    <CountryMark country={country} size={20} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <span style={{ color: isSelected ? ventsColors.white : ventsColors.ink1, fontSize: '16px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {country.name}
                    </span>
                    <span style={{ color: isSelected ? ventsColors.ink2 : ventsColors.ink3, fontFamily: ventsTypography.fontMono, fontSize: '11px', letterSpacing: '0.1em' }}>{country.code}</span>
                  </div>
                  {isSelected && (
                    <div
                      style={{
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        background: ventsColors.accent,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <Check size={12} color={ventsColors.white} strokeWidth={3} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
        <button
          onClick={() => selectedCountry && onContinue(selectedCountry)}
          disabled={!selectedCountry}
          style={{
            width: '100%',
            height: '56px',
            background: selectedCountry ? ventsColors.accent : 'rgba(255,255,255,0.05)',
            border: 'none',
            borderRadius: `${ventsRadii.lg}px`,
            padding: '0 16px',
            color: selectedCountry ? ventsColors.white : ventsColors.ink3,
            fontSize: '17px',
            fontWeight: 700,
            fontFamily: ventsTypography.fontBody,
            cursor: selectedCountry ? 'pointer' : 'not-allowed',
            boxShadow: selectedCountry ? '0 14px 40px -14px rgba(142,92,247,1)' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            transition: 'all 0.2s ease',
          }}
        >
          {selectedCountry ? `Continue with ${selectedCountry.name}` : 'Select your country'}
          {selectedCountry && <ChevronRight size={16} />}
        </button>
      </div>
    </div>
  );
}
