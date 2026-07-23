import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

export interface CountryOption {
  flag: string;
  /** ISO 3166-1 alpha-2, used for the badge fallback where flag emoji don't render. */
  iso: string;
  code: string;
  name: string;
  format: string;
}

// Nigeria first — the app's default region (see src/lib/regionConfig.ts).
export const COUNTRY_CODES: CountryOption[] = [
  { flag: '🇳🇬', code: '+234', iso: 'NG', name: 'Nigeria', format: '080 0000 0000' },
  { flag: '🇬🇧', code: '+44', iso: 'GB', name: 'UK', format: '07700 000000' },
  { flag: '🇺🇸', code: '+1', iso: 'US', name: 'USA', format: '(000) 000-0000' },
  { flag: '🇨🇦', code: '+1', iso: 'CA', name: 'Canada', format: '(000) 000-0000' },
  { flag: '🇬🇭', code: '+233', iso: 'GH', name: 'Ghana', format: '024 000 0000' },
  { flag: '🇿🇦', code: '+27', iso: 'ZA', name: 'South Africa', format: '071 000 0000' },
  { flag: '🇰🇪', code: '+254', iso: 'KE', name: 'Kenya', format: '0712 000000' },
  { flag: '🇫🇷', code: '+33', iso: 'FR', name: 'France', format: '06 00 00 00 00' },
  { flag: '🇩🇪', code: '+49', iso: 'DE', name: 'Germany', format: '0151 00000000' },
  { flag: '🇦🇺', code: '+61', iso: 'AU', name: 'Australia', format: '0412 000 000' },
  { flag: '🇨🇳', code: '+86', iso: 'CN', name: 'China', format: '138 0000 0000' },
  { flag: '🇮🇳', code: '+91', iso: 'IN', name: 'India', format: '98000 00000' },
  { flag: '🇦🇪', code: '+971', iso: 'AE', name: 'UAE', format: '050 000 0000' },
  { flag: '🇸🇳', code: '+221', iso: 'SN', name: 'Senegal', format: '77 000 00 00' },
  { flag: '🇪🇹', code: '+251', iso: 'ET', name: 'Ethiopia', format: '091 000 0000' },
];

export const DEFAULT_COUNTRY = COUNTRY_CODES[0];

// Flag emoji are a pair of regional-indicator codepoints. iOS and Android ship
// glyphs for them; Windows does not, and instead renders the two indicator
// letters as pale boxed characters — which read as a stray artifact sitting
// behind the dial code rather than as a flag. Measure once whether the platform
// actually composes the pair into a single glyph: if it does, the flag is
// narrower than the two letters drawn separately. Anything unexpected (no
// canvas, SSR, a thrown error) falls back to the badge, which always renders.
function detectFlagEmojiSupport(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return false;
    ctx.font = '16px sans-serif';
    // U+1F1F3 U+1F1EC = 🇳🇬. Compare against the same two codepoints separated
    // so they cannot combine; a real flag glyph is measurably narrower.
    const joined = ctx.measureText('\u{1F1F3}\u{1F1EC}').width;
    const apart = ctx.measureText('\u{1F1F3}\u{200B}\u{1F1EC}').width;
    return joined > 0 && joined < apart;
  } catch {
    return false;
  }
}

// Computed once per session — the result cannot change while the app is open.
const SUPPORTS_FLAG_EMOJI = detectFlagEmojiSupport();

/** A country's flag, or a legible ISO badge on platforms without flag glyphs. */
function CountryMark({ country, size = 16 }: { country: CountryOption; size?: number }) {
  if (SUPPORTS_FLAG_EMOJI) {
    return <span style={{ fontSize: `${size}px`, lineHeight: 1 }}>{country.flag}</span>;
  }
  return (
    <span
      aria-label={country.name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: `${Math.round(size * 1.6)}px`,
        padding: '2px 4px',
        borderRadius: '4px',
        background: 'rgba(167,139,250,0.16)',
        border: '1px solid rgba(167,139,250,0.3)',
        color: '#C4B5FD',
        fontSize: `${Math.max(9, Math.round(size * 0.62))}px`,
        fontWeight: 700,
        letterSpacing: '0.5px',
        lineHeight: 1,
      }}
    >
      {country.iso}
    </span>
  );
}

// Format strings like Nigeria's "080 0000 0000" or Kenya's "0712 000000" are
// human-readable EXAMPLE numbers, not pure templates — the '8', '7', '1', '2'
// are real example digits, not placeholder characters. Treating only literal
// '0' as a placeholder (the previous approach) left those example digits
// hardcoded into the display no matter what the user actually typed, which
// looked like the input only accepted 0/8/9. Every digit character in the
// format string is a placeholder position; only non-digits (spaces, dashes,
// parens) are literal separators.

/** Max raw digits a country's national number holds, derived from its format's digit placeholders. */
export function maxDigitsFor(country: CountryOption): number {
  return (country.format.match(/\d/g) || []).length;
}

/** Groups raw digits into a country's display format, e.g. "0801234567" -> "080 1234 567". */
export function formatNationalNumber(digits: string, country: CountryOption): string {
  let out = '';
  let di = 0;
  for (let i = 0; i < country.format.length && di < digits.length; i++) {
    const ch = country.format[i];
    if (/\d/.test(ch)) { out += digits[di]; di++; }
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
  /** Surface styling, so a host screen can match its own field treatment.
   *  Defaults preserve the original look for screens that don't pass them. */
  background?: string;
  borderColor?: string;
  radius?: string;
}

export function PhoneInput({
  countryCode, onCountryCodeChange, value, onChange, placeholder, height = 45,
  background = '#090514', borderColor = 'rgba(255,255,255,0.08)', radius = '12px',
}: PhoneInputProps) {
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
            background,
            border: `1px solid ${borderColor}`,
            borderRadius: radius,
            height: `${height}px`,
            padding: '0 10px',
            cursor: 'pointer',
            flexShrink: 0,
            boxSizing: 'border-box',
          }}
        >
          <CountryMark country={selected} size={16} />
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
            background,
            border: `1px solid ${borderColor}`,
            borderRadius: radius,
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
                  <CountryMark country={c} size={22} />
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
