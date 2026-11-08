import { describe, it, expect } from 'vitest';
import { contactPhoneLinks, toE164ContactPhone, splitStoredContactPhone } from './contactPhone';

describe('contactPhoneLinks: Nigerian numbers', () => {
  const expected = { display: '09152579794', telHref: 'tel:+2349152579794', whatsappNumber: '2349152579794' };
  it.each([
    ['9152579794'],          // legacy saves: digits after the default +234 picker
    ['09152579794'],         // local format
    ['+2349152579794'],      // E.164 (current saves)
    ['2349152579794'],       // E.164 without +
    ['+234 915 257 9794'],   // spaced
    ['+23409152579794'],     // stray trunk 0 after the code
    ['002349152579794'],     // 00 international prefix
  ])('%s -> 0915..., tel +234, wa 234', (raw) => {
    expect(contactPhoneLinks(raw)).toEqual(expected);
  });
  it('never drops or duplicates digits', () => {
    for (const raw of ['8031234567', '+2348031234567', '08031234567']) {
      const l = contactPhoneLinks(raw)!;
      expect(l.display).toBe('08031234567');
      expect(l.display.length).toBe(11);
      expect(l.whatsappNumber).toBe('2348031234567');
    }
  });
});

describe('contactPhoneLinks: other countries keep international format', () => {
  it('UK', () => {
    expect(contactPhoneLinks('+447911123456')).toEqual({ display: '+447911123456', telHref: 'tel:+447911123456', whatsappNumber: '447911123456' });
  });
  it('Ghana', () => {
    expect(contactPhoneLinks('+233241234567')!.whatsappNumber).toBe('233241234567');
  });
  it('unknown country without a code: shown as stored, no WhatsApp link (wa.me needs a country code)', () => {
    expect(contactPhoneLinks('5551234')).toEqual({ display: '5551234', telHref: 'tel:5551234', whatsappNumber: null });
  });
  it('empty values render nothing', () => {
    expect(contactPhoneLinks('')).toBeNull();
    expect(contactPhoneLinks(null)).toBeNull();
    expect(contactPhoneLinks('  ')).toBeNull();
  });
});

describe('saving and editing', () => {
  it('stores E.164 from the picker', () => {
    expect(toE164ContactPhone('+234', '9152579794')).toBe('+2349152579794');
    expect(toE164ContactPhone('+234', '09152579794')).toBe('+2349152579794');
    expect(toE164ContactPhone('+44', '07911123456')).toBe('+447911123456');
    expect(toE164ContactPhone('+39', '0612345678')).toBe('+390612345678');
    expect(toE164ContactPhone('+234', '')).toBe('');
  });
  it('splits stored values back for Edit Event', () => {
    expect(splitStoredContactPhone('+2349152579794')).toEqual({ countryCode: '+234', national: '9152579794' });
    expect(splitStoredContactPhone('9152579794')).toEqual({ countryCode: '+234', national: '9152579794' });
    expect(splitStoredContactPhone('09152579794')).toEqual({ countryCode: '+234', national: '9152579794' });
    expect(splitStoredContactPhone('+447911123456')).toEqual({ countryCode: '+44', national: '7911123456' });
    expect(splitStoredContactPhone(null)).toEqual({ countryCode: '+234', national: '' });
  });
  it('round-trips', () => {
    const { countryCode, national } = splitStoredContactPhone('+2349152579794');
    expect(toE164ContactPhone(countryCode, national)).toBe('+2349152579794');
  });
});
