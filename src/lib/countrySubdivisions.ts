// Per-country state/province/region picker data. Deliberately NOT
// attempting all ~195 countries: only a small, genuinely-researched list
// for the countries this app has an immediate, concrete need for (its
// launch market, plus the countries explicitly named in the country-aware
// QA pass). Any country without an entry here falls back to a free-text
// region field -- the same graceful-degradation pattern already used
// throughout this codebase (AuthScreen's non-Nigeria signup fallback,
// ProfileDetailsScreen's non-Nigeria profile fallback, organizer
// verification's non-Nigeria individual/business fallback). Adding a
// country later means adding one more entry here, not rebuilding this
// module or any of its call sites.
import { NIGERIA_STATE_NAMES } from './nigeriaLocations';

export interface CountrySubdivisions {
  /** What to call this list in the UI, e.g. "State", "Province". */
  label: string;
  options: string[];
}

export const COUNTRY_SUBDIVISIONS: Record<string, CountrySubdivisions> = {
  NG: { label: 'State', options: [...NIGERIA_STATE_NAMES] },
  // Rwanda's 5 provinces (Kigali City is administered as a province-level
  // city) -- the official, stable top-level administrative divisions.
  RW: {
    label: 'Province',
    options: ['Kigali City', 'Eastern Province', 'Northern Province', 'Southern Province', 'Western Province'],
  },
  // Qatar's 8 municipalities (baladiyat) -- the official top-level
  // administrative divisions.
  QA: {
    label: 'Municipality',
    options: ['Doha', 'Al Rayyan', 'Al Wakrah', 'Al Khor', 'Umm Salal', 'Al Daayen', 'Al Shamal', 'Al Shahaniya'],
  },
};

export function subdivisionsForCountry(iso?: string | null): CountrySubdivisions | null {
  if (!iso) return null;
  return COUNTRY_SUBDIVISIONS[iso.toUpperCase()] || null;
}
