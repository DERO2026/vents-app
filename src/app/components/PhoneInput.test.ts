import { describe, it, expect } from 'vitest';
import { stripRedundantCountryCode } from './PhoneInput';
import { buildE164, maxDigitsFor, COUNTRY_CODES } from '../../lib/countries';
import { REGION } from '../../lib/regionConfig';

// Regression coverage for the double-country-code bug: pasting/typing a
// number in full international form ("+234801234567" / "234801234567")
// into the national-number field, right beside a selector chip that
// already reads "+234", used to truncate real subscriber digits before
// buildE164 ever ran, producing a doubly-prefixed value that failed
// REGION.phoneRegex even though the user entered a genuinely valid number.
//
// The fix is deliberately gated on the raw digit length exceeding the
// selected country's own local-number length, not merely on a
// "startsWith(dial code)" match -- a short dial code like +1 can be a
// perfectly valid LEADING digit of a real local number in some countries,
// so a length-agnostic prefix-strip would wrongly truncate a correctly
// sized local number. These tests exercise the exact pipeline
// PhoneInput.tsx now runs: stripRedundantCountryCode -> (capped to
// maxDigits) -> buildE164 -> the country's own validation, for Nigeria
// (a long dial code) and the US (a short, digit-colliding dial code).

const NG = COUNTRY_CODES.find((c) => c.iso === 'NG')!;
const US = COUNTRY_CODES.find((c) => c.iso === 'US')!;
const NG_MAX_DIGITS = maxDigitsFor(NG); // 11 -- format "080 0000 0000"
const US_MAX_DIGITS = maxDigitsFor(US); // 10 -- format "(000) 000-0000"

function normalize(raw: string, countryCode: string, maxDigits: number): string {
  const digitsOnly = raw.replace(/\D/g, '');
  const stripped = stripRedundantCountryCode(digitsOnly, countryCode, maxDigits).slice(0, maxDigits);
  return buildE164(stripped, countryCode);
}

describe('stripRedundantCountryCode', () => {
  it('leaves a normal Nigerian local number (with leading 0) untouched -- same length as the max, no strip', () => {
    expect(stripRedundantCountryCode('08012345678', '+234', NG_MAX_DIGITS)).toBe('08012345678');
  });

  it('leaves a normal Nigerian local number (without leading 0) untouched', () => {
    expect(stripRedundantCountryCode('9162337459', '+234', NG_MAX_DIGITS)).toBe('9162337459');
  });

  it('strips a redundant leading dial-code prefix when the raw digits exceed the local-number length', () => {
    expect(stripRedundantCountryCode('2348012345678', '+234', NG_MAX_DIGITS)).toBe('8012345678');
  });

  it('does not strip when the digits are exactly the dial code with nothing after it (still <= max length)', () => {
    expect(stripRedundantCountryCode('234', '+234', NG_MAX_DIGITS)).toBe('234');
  });

  it('does not strip when the digits do not start with the dial code', () => {
    expect(stripRedundantCountryCode('8012345678', '+234', NG_MAX_DIGITS)).toBe('8012345678');
  });

  // The cross-country correctness case this revision specifically fixes:
  // +1's dial-code digit ("1") is a plausible leading digit of some
  // countries' local numbers. A length-agnostic startsWith check would
  // wrongly truncate a correctly-sized local number just because it starts
  // with "1". Gating on length (only strip when the raw digits are LONGER
  // than the country's own local-number length) prevents that.
  it('does NOT strip a full-length local number that happens to start with the dial-code digit (+1)', () => {
    const localStartingWithOne = '1234567890'; // 10 digits, exactly US_MAX_DIGITS -- a plausible local number
    expect(localStartingWithOne).toHaveLength(US_MAX_DIGITS);
    expect(stripRedundantCountryCode(localStartingWithOne, '+1', US_MAX_DIGITS)).toBe(localStartingWithOne);
  });

  it('DOES strip a redundant +1 prefix when the raw digits exceed the local-number length (genuine international-form paste)', () => {
    const pastedInternational = '11234567890'; // 11 digits: "1" (dial code) + the 10-digit local number above
    expect(pastedInternational).toHaveLength(US_MAX_DIGITS + 1);
    expect(stripRedundantCountryCode(pastedInternational, '+1', US_MAX_DIGITS)).toBe('1234567890');
  });
});

describe('Nigerian phone normalization end-to-end (PhoneInput -> buildE164 -> REGION.phoneRegex)', () => {
  const cases: Array<[label: string, raw: string, expectedE164: string]> = [
    ['standard local format with leading 0', '08012345678', '+2348012345678'],
    ['local format without leading 0', '8012345678', '+2348012345678'],
    ['the exact Sentry-reported number, no leading 0', '9162337459', '+2349162337459'],
    ['pasted full international form with +', '+2348012345678', '+2348012345678'],
    ['pasted full international form without +', '2348012345678', '+2348012345678'],
  ];

  it.each(cases)('%s: %s -> %s', (_label, raw, expectedE164) => {
    const e164 = normalize(raw, '+234', NG_MAX_DIGITS);
    expect(e164).toBe(expectedE164);
    expect(REGION.phoneRegex.test(e164)).toBe(true);
  });

  it('does not corrupt the real subscriber digits for any of the above (regression guard)', () => {
    // Every case above must resolve to a 10-digit national number after the
    // +234 prefix -- if truncation ever ate into real digits again, the
    // resulting string would be shorter than 10 digits and this would catch
    // it even if some other change happened to make the regex looser.
    for (const [, raw] of cases) {
      const e164 = normalize(raw, '+234', NG_MAX_DIGITS);
      expect(e164.replace('+234', '')).toHaveLength(10);
    }
  });
});

describe('US phone normalization end-to-end (short dial code, +1)', () => {
  it('preserves a valid local number that starts with the dial-code digit', () => {
    const e164 = normalize('1234567890', '+1', US_MAX_DIGITS);
    // Must resolve to the number as entered, not have its leading "1"
    // misread as a redundant dial-code prefix and stripped.
    expect(e164).toBe('+11234567890');
    expect(e164.replace('+1', '')).toHaveLength(US_MAX_DIGITS);
  });

  it('correctly normalizes a genuine full international-form paste', () => {
    const e164 = normalize('+11234567890', '+1', US_MAX_DIGITS);
    expect(e164).toBe('+11234567890');
    expect(e164.replace('+1', '')).toHaveLength(US_MAX_DIGITS);
  });

  it('correctly normalizes a plain 10-digit local number with no dial-code collision', () => {
    const e164 = normalize('4155551234', '+1', US_MAX_DIGITS);
    expect(e164).toBe('+14155551234');
    expect(e164.replace('+1', '')).toHaveLength(US_MAX_DIGITS);
  });
});
