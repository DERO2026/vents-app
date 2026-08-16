import { useState, useMemo } from 'react';
import { ChevronDown, X, Search } from 'lucide-react';
import { COUNTRY_CODES, DEFAULT_COUNTRY, CountryOption, maxDigitsFor, formatNationalNumber } from '../../lib/countries';

export type { CountryOption } from '../../lib/countries';
export { COUNTRY_CODES, DEFAULT_COUNTRY, maxDigitsFor, formatNationalNumber } from '../../lib/countries';

// Flag emoji are a pair of regional-indicator codepoints, mechanically
// derived from the ISO alpha-2 code (each letter A-Z maps to U+1F1E6..U+1F1FF
// in order) rather than stored per-country — 195 hand-typed flag emoji is
// both a lot of data entry and a lot of surface area for typos that are
// invisible at a glance. iOS and Android ship glyphs for the resulting pair;
// Windows does not, and instead renders the two indicator letters as pale
// boxed characters — which read as a stray artifact sitting behind the dial
// code rather than as a flag. detectFlagEmojiSupport() below measures once
// whether the platform actually composes the pair into a single glyph.
function flagEmojiFor(iso: string): string {
  const codePoints = iso.toUpperCase().split('').map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// Measure once whether the platform actually composes a regional-indicator
// pair into a single flag glyph: if it does, the flag is narrower than the
// two letters drawn separately. Anything unexpected (no canvas, SSR, a
// thrown error) falls back to the ISO badge, which always renders.
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
    return <span style={{ fontSize: `${size}px`, lineHeight: 1 }}>{flagEmojiFor(country.iso)}</span>;
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
  const [search, setSearch] = useState('');

  // Some dial codes are shared (+1 is USA and Canada). The parent stores only
  // the dial code — deliberately, since both countries produce the identical
  // E.164 number, so which one is chosen cannot change the value submitted.
  // That makes the distinction purely a display concern, and it lives here:
  // remember the entry the user actually tapped so the chip and the picker
  // highlight stop snapping back to the first match. If the dial code later
  // changes to one this pick doesn't belong to, the filter below drops it
  // and we fall back to the first match for that code.
  const [pickedIso, setPickedIso] = useState<string | null>(null);
  const matches = COUNTRY_CODES.filter((c) => c.code === countryCode);
  const selected =
    (pickedIso ? matches.find((c) => c.iso === pickedIso) : undefined) ||
    matches[0] ||
    DEFAULT_COUNTRY;
  const maxDigits = maxDigitsFor(selected);
  const displayValue = formatNationalNumber(value, selected);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return COUNTRY_CODES;
    return COUNTRY_CODES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.includes(q) || c.iso.toLowerCase() === q
    );
  }, [search]);

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
          onClick={() => { setShowPicker(false); setSearch(''); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-end', zIndex: 1000 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', background: '#090514', borderRadius: '24px 24px 0 0', maxHeight: '75%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ padding: '20px 20px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }}>Select Country</p>
              <button onClick={() => { setShowPicker(false); setSearch(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={20} color="#8B8FA8" />
              </button>
            </div>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '10px 12px' }}>
                <Search size={15} color="#8B8FA8" style={{ flexShrink: 0 }} />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search country or code..."
                  style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
                />
              </div>
            </div>
            <div style={{ overflowY: 'auto', padding: '8px 0 28px' }}>
              {filtered.length === 0 ? (
                <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', padding: '24px 20px' }}>No countries match "{search}".</p>
              ) : filtered.map((c) => (
                <button
                  key={`${c.iso}`}
                  type="button"
                  onClick={() => { setPickedIso(c.iso); onCountryCodeChange(c.code); setShowPicker(false); setSearch(''); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    width: '100%',
                    padding: '14px 20px',
                    background: selected.iso === c.iso ? 'rgba(124,58,237,0.1)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <CountryMark country={c} size={22} />
                  <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Format: {c.format}</p>
                  </div>
                  <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 600, flexShrink: 0 }}>{c.code}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
