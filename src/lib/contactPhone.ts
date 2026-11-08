// Organizer contact numbers on event pages: one place that turns whatever
// is stored in events.contact_phone into
//   - the number to SHOW (Nigerian numbers in local format, 0XXXXXXXXXX;
//     other countries in international format, +CCC...),
//   - the tel: target for the call button (always international, +234...),
//   - the wa.me number for WhatsApp (international digits, no +).
//
// Why this exists: until this fix, Create Event saved only the digits typed
// after the country picker (e.g. "9152579794") and dropped the dial code,
// so the event page showed "9152579794", the call button dialled
// tel:9152579794 and WhatsApp opened wa.me/9152579794 -- neither reachable.
// New saves store E.164 (toE164ContactPhone); this module also reads every
// older shape, so no stored record has to be rewritten.
//
// Display only: nothing here changes what is stored.
import { COUNTRY_CODES, DEFAULT_COUNTRY } from './countries';

export interface ContactPhoneLinks {
  /** What to show on screen. */
  display: string;
  /** href for the call button, or null if the number can't be dialled reliably. */
  telHref: string | null;
  /** Digits for https://wa.me/<n>, or null when the country is unknown. */
  whatsappNumber: string | null;
}

const NG_CODE = '234';
// Nigerian national significant numbers are 10 digits (mobile 70x/80x/81x/
// 90x/91x..., also landlines). Stored legacy values had no country code and
// no trunk 0, and Nigeria is the picker's default, so a bare 10-digit number
// starting 7/8/9 is read as Nigerian.
const NG_NSN = /^[789]\d{9}$/;

function nigerian(nsn: string): ContactPhoneLinks {
  return { display: `0${nsn}`, telHref: `tel:+${NG_CODE}${nsn}`, whatsappNumber: `${NG_CODE}${nsn}` };
}

export function contactPhoneLinks(raw: string | null | undefined): ContactPhoneLinks | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('00')) digits = digits.slice(2);
  if (!digits) return null;

  // +234 / 234 forms (also tolerates a stray trunk 0 typed after the code: +2340915...).
  if (digits.startsWith(NG_CODE)) {
    let nsn = digits.slice(NG_CODE.length);
    if (nsn.length === 11 && nsn.startsWith('0')) nsn = nsn.slice(1);
    if (nsn.length === 10) return nigerian(nsn);
  }
  if (!international) {
    // 0XXXXXXXXXX: already Nigerian local format.
    if (digits.length === 11 && digits.startsWith('0') && NG_NSN.test(digits.slice(1))) return nigerian(digits.slice(1));
    // Legacy saves: the 10 digits after the (default, Nigerian) picker.
    if (NG_NSN.test(digits)) return nigerian(digits);
    // Unknown country: show as stored, dial as stored, no WhatsApp (wa.me needs a country code).
    return { display: trimmed, telHref: `tel:${digits}`, whatsappNumber: null };
  }
  // Any other country: keep international formatting.
  return { display: `+${digits}`, telHref: `tel:+${digits}`, whatsappNumber: digits };
}

// Countries where the leading 0 is part of the international number (Italy,
// San Marino, Vatican); everywhere else a leading 0 is a trunk prefix.
const KEEP_LEADING_ZERO = new Set(['+39', '+378', '+379']);

/** The value Create/Edit Event stores: E.164 from the picker's dial code and the typed digits. */
export function toE164ContactPhone(countryCode: string, nationalDigits: string): string {
  let nsn = nationalDigits.replace(/\D/g, '');
  if (!nsn) return '';
  if (nsn.startsWith('0') && !KEEP_LEADING_ZERO.has(countryCode)) nsn = nsn.replace(/^0+/, '');
  return `${countryCode}${nsn}`;
}

/** Split a stored value back into the picker's dial code and national digits (Edit Event). */
export function splitStoredContactPhone(stored: string | null | undefined): { countryCode: string; national: string } {
  const trimmed = (stored ?? '').trim();
  if (!trimmed) return { countryCode: DEFAULT_COUNTRY.code, national: '' };
  if (trimmed.startsWith('+')) {
    const digits = trimmed.replace(/\D/g, '');
    const match = [...new Set(COUNTRY_CODES.map((c) => c.code))]
      .filter((code) => digits.startsWith(code.slice(1)))
      .sort((a, b) => b.length - a.length)[0];
    if (match) return { countryCode: match, national: digits.slice(match.length - 1) };
    return { countryCode: DEFAULT_COUNTRY.code, national: digits };
  }
  const ng = contactPhoneLinks(trimmed);
  if (ng && ng.whatsappNumber?.startsWith(NG_CODE)) return { countryCode: '+234', national: ng.whatsappNumber.slice(NG_CODE.length) };
  return { countryCode: DEFAULT_COUNTRY.code, national: trimmed.replace(/\D/g, '') };
}
