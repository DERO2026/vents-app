import { describe, it, expect } from 'vitest';
import { servicesPayableCurrencyForCountry } from './currencies';

describe('servicesPayableCurrencyForCountry: NGN-only for this pass', () => {
  it('returns NGN for Nigeria', () => {
    expect(servicesPayableCurrencyForCountry('NG')).toBe('NGN');
  });

  it('returns NGN for the United States (not USD)', () => {
    expect(servicesPayableCurrencyForCountry('US')).toBe('NGN');
  });

  it('returns NGN for Qatar (not QAR)', () => {
    expect(servicesPayableCurrencyForCountry('QA')).toBe('NGN');
  });

  it('returns NGN for the United Kingdom (not GBP)', () => {
    expect(servicesPayableCurrencyForCountry('GB')).toBe('NGN');
  });

  it('returns NGN for an unknown/unmapped country', () => {
    expect(servicesPayableCurrencyForCountry('ZZ')).toBe('NGN');
  });

  it('returns NGN when no country is set at all', () => {
    expect(servicesPayableCurrencyForCountry(undefined)).toBe('NGN');
    expect(servicesPayableCurrencyForCountry(null)).toBe('NGN');
    expect(servicesPayableCurrencyForCountry('')).toBe('NGN');
  });
});
