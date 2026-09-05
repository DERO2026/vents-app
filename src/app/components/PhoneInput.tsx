import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { COUNTRY_CODES, DEFAULT_COUNTRY, CountryOption, maxDigitsFor, formatNationalNumber } from '../../lib/countries';
import { PickerSheet } from './shared/PickerSheet';

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

/** A country's flag, or a legible ISO badge on platforms without flag glyphs.
 *  Exported for reuse by CountrySelectScreen (the account/home-country picker
 *  shown once at signup, distinct from this component's phone-dial-code
 *  picker) so both surfaces render the exact same flag/fallback logic. */
export function CountryMark({ country, size = 16 }: { country: CountryOption; size?: number }) {
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
          // Deliberately type="text" + inputMode="tel", not type="tel" --
          // type="tel" is exactly the signal iOS Safari (and some Android
          // keyboards) use to show the QuickType contact-suggestion strip
          // above the keyboard while typing, which is what this was fixing.
          // inputMode="tel" alone still brings up the numeric phone keypad,
          // so entry UX is unchanged; autoComplete/autoCorrect/autoCapitalize
          // are all suppressed too since none of them make sense for a
          // digits-only national-number field with its own country-code
          // selector right next to it.
          type="text"
          inputMode="tel"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
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
        <PickerSheet
          title="Select Country"
          searchPlaceholder="Search country or code..."
          // label carries name+code+iso so PickerSheet's search matches all
          // three (as the old bespoke filter did) even though renderOption
          // below replaces it visually with the flag/format/dial-code row.
          options={COUNTRY_CODES.map((c) => ({ value: c.iso, label: `${c.name} ${c.code} ${c.iso}` }))}
          value={selected.iso}
          onSelect={(iso) => {
            const c = COUNTRY_CODES.find((x) => x.iso === iso);
            if (!c) return;
            setPickedIso(c.iso);
            onCountryCodeChange(c.code);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
          renderOption={(o) => {
            const c = COUNTRY_CODES.find((x) => x.iso === o.value)!;
            return (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
                  <CountryMark country={c} size={20} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                    <div style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 500 }}>Format: {c.format}</div>
                  </div>
                </div>
                <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 600, flexShrink: 0 }}>{c.code}</span>
              </>
            );
          }}
        />
      )}
    </>
  );
}
