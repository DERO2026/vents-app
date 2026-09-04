import { useMemo, useState } from 'react';
import { ArrowLeft, Search, Check, ChevronRight } from 'lucide-react';
import { COUNTRY_CODES, CountryOption } from '../../lib/countries';
import { CountryMark } from './PhoneInput';

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
        background: '#020005',
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
          padding: 'calc(28px + env(safe-area-inset-top)) 24px 16px',
          background: 'linear-gradient(180deg, #0D0520 0%, #020005 100%)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            marginBottom: '16px',
          }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
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
          Where's home{' '}
          <span style={{ color: '#A855F7' }}>for you?</span>
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.5 }}>
          This sets your account's home country — you'll still see and book events everywhere on VENTS.
        </p>
      </div>

      {/* Search */}
      <div style={{ padding: '4px 20px 8px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '11px 14px' }}>
          <Search size={16} color="#8B8FA8" style={{ flexShrink: 0 }} />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search country or code..."
            style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
          />
        </div>
      </div>

      {/* Country list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 16px 100px',
          scrollbarWidth: 'none',
        }}
      >
        {filtered.length === 0 ? (
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', padding: '24px 20px' }}>
            No countries match "{search}".
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {filtered.map((country) => {
              const isSelected = selected === country.iso;
              return (
                <div
                  key={country.iso}
                  onClick={() => setSelected(country.iso)}
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
                      width: '40px',
                      height: '40px',
                      borderRadius: '12px',
                      background: isSelected ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <CountryMark country={country} size={20} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {country.name}
                    </p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{country.code}</p>
                  </div>
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
                      flexShrink: 0,
                    }}
                  >
                    {isSelected && <Check size={12} color="#fff" strokeWidth={3} />}
                  </div>
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
          background: 'linear-gradient(to top, #020005 60%, transparent)',
        }}
      >
        <button
          onClick={() => selectedCountry && onContinue(selectedCountry)}
          disabled={!selectedCountry}
          style={{
            width: '100%',
            background: selectedCountry
              ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)'
              : 'rgba(123,47,190,0.25)',
            border: 'none',
            borderRadius: '16px',
            padding: '16px',
            color: selectedCountry ? '#fff' : 'rgba(255,255,255,0.35)',
            fontSize: '17px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: selectedCountry ? 'pointer' : 'not-allowed',
            boxShadow: selectedCountry ? '0 8px 28px rgba(123,47,190,0.45)' : 'none',
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
