import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

export interface CountryOption {
  flag: string;
  code: string;
  name: string;
  format: string;
}

// Nigeria first — the app's default region (see src/lib/regionConfig.ts).
export const COUNTRY_CODES: CountryOption[] = [
  { flag: '🇳🇬', code: '+234', name: 'Nigeria', format: '080 0000 0000' },
  { flag: '🇬🇧', code: '+44', name: 'UK', format: '07700 000000' },
  { flag: '🇺🇸', code: '+1', name: 'USA', format: '(000) 000-0000' },
  { flag: '🇨🇦', code: '+1', name: 'Canada', format: '(000) 000-0000' },
  { flag: '🇬🇭', code: '+233', name: 'Ghana', format: '024 000 0000' },
  { flag: '🇿🇦', code: '+27', name: 'South Africa', format: '071 000 0000' },
  { flag: '🇰🇪', code: '+254', name: 'Kenya', format: '0712 000000' },
  { flag: '🇫🇷', code: '+33', name: 'France', format: '06 00 00 00 00' },
  { flag: '🇩🇪', code: '+49', name: 'Germany', format: '0151 00000000' },
  { flag: '🇦🇺', code: '+61', name: 'Australia', format: '0412 000 000' },
  { flag: '🇨🇳', code: '+86', name: 'China', format: '138 0000 0000' },
  { flag: '🇮🇳', code: '+91', name: 'India', format: '98000 00000' },
  { flag: '🇦🇪', code: '+971', name: 'UAE', format: '050 000 0000' },
  { flag: '🇸🇳', code: '+221', name: 'Senegal', format: '77 000 00 00' },
  { flag: '🇪🇹', code: '+251', name: 'Ethiopia', format: '091 000 0000' },
];

export const DEFAULT_COUNTRY = COUNTRY_CODES[0];

/** Max raw digits a country's national number holds, derived from its format's '0' placeholders. */
export function maxDigitsFor(country: CountryOption): number {
  return (country.format.match(/0/g) || []).length;
}

/** Groups raw digits into a country's display format, e.g. "0801234567" -> "080 1234 567". */
export function formatNationalNumber(digits: string, country: CountryOption): string {
  let out = '';
  let di = 0;
  for (let i = 0; i < country.format.length && di < digits.length; i++) {
    const ch = country.format[i];
    if (ch === '0') { out += digits[di]; di++; }
    else out += ch;
  }
  return out;
}

interface PhoneInputProps {
  /** Dial code with leading '+', e.g. '+234'. Defaults to Nigeria if not a known code. */
  countryCode: string;
  onCountryCodeChange: (code: string) => void;
  /** Raw national-number digits only (no country code, no leading zero handling done here). */
  value: string;
  onChange: (digits: string) => void;
  placeholder?: string;
  height?: number;
}

export function PhoneInput({ countryCode, onCountryCodeChange, value, onChange, placeholder, height = 45 }: PhoneInputProps) {
  const [showPicker, setShowPicker] = useState(false);
  const selected = COUNTRY_CODES.find((c) => c.code === countryCode) || DEFAULT_COUNTRY;
  const maxDigits = maxDigitsFor(selected);
  const displayValue = formatNationalNumber(value, selected);

  return (
    <>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          onClick={() => setShowPicker(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '12px',
            height: `${height}px`,
            padding: '0 10px',
            cursor: 'pointer',
            flexShrink: 0,
            boxSizing: 'border-box',
          }}
        >
          <span style={{ fontSize: '16px' }}>{selected.flag}</span>
          <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 500 }}>{selected.code}</span>
          <ChevronDown size={12} color="#8B8FA8" />
        </button>
        <input
          type="tel"
          placeholder={placeholder || selected.format}
          value={displayValue}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, maxDigits))}
          style={{
            flex: 1,
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '12px',
            height: `${height}px`,
            padding: '0 14px',
            color: '#F0F0FF',
            fontSize: '14px',
            fontFamily: 'Inter, sans-serif',
            outline: 'none',
            boxSizing: 'border-box',
            minWidth: 0,
          }}
        />
      </div>

      {showPicker && (
        <div
          onClick={() => setShowPicker(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-end', zIndex: 1000 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', background: '#090514', borderRadius: '24px 24px 0 0', maxHeight: '70%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ padding: '20px 20px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }}>Select Country</p>
              <button onClick={() => setShowPicker(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={20} color="#8B8FA8" />
              </button>
            </div>
            <div style={{ overflowY: 'auto', padding: '8px 0 28px' }}>
              {COUNTRY_CODES.map((c) => (
                <button
                  key={`${c.code}-${c.name}`}
                  type="button"
                  onClick={() => { onCountryCodeChange(c.code); setShowPicker(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    width: '100%',
                    padding: '14px 20px',
                    background: selected.name === c.name ? 'rgba(124,58,237,0.1)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: '22px' }}>{c.flag}</span>
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>{c.name}</p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Format: {c.format}</p>
                  </div>
                  <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 600 }}>{c.code}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
