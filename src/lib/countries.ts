// Full country/dial-code list backing PhoneInput's selector. Kept separate
// from PhoneInput.tsx (a UI component) so it can also be imported by
// validation code (schemas.ts, AuthScreen.tsx, SettingsScreen.tsx) without
// pulling in React.
//
// VENTS launches Nigeria-first (see src/lib/regionConfig.ts — currency,
// SMS, CAC business verification are all genuinely Nigeria-scoped features),
// but phone-number entry itself must not be: a user in Qatar, Rwanda, the
// US, or anywhere else has to be able to sign up, hold a profile, and use
// the app with their own country's number. This list intentionally covers
// every ITU-T-assigned calling code, not just the countries VENTS actively
// operates in.

export interface CountryOption {
  /** ISO 3166-1 alpha-2. Flags are derived from this at render time (see
   *  flagEmojiFor in PhoneInput.tsx) rather than stored per-entry. */
  iso: string;
  /** Dial code with leading '+'. Several countries share one (e.g. +1). */
  code: string;
  name: string;
  /** Example national-number format. Digit characters are placeholder
   *  positions (see formatNationalNumber); non-digits are literal
   *  separators. Countries without a precisely known mobile format use a
   *  reasonable generic length for that region rather than a fabricated
   *  exact template — validation cares about digit-count range, not the
   *  cosmetic grouping. */
  format: string;
}

// Nigeria first — the app's default region (see src/lib/regionConfig.ts).
// Then the rest, alphabetical by name within reasonable groupings.
export const COUNTRY_CODES: CountryOption[] = [
  { iso: 'NG', code: '+234', name: 'Nigeria', format: '080 0000 0000' },

  { iso: 'AF', code: '+93', name: 'Afghanistan', format: '070 000 0000' },
  { iso: 'AL', code: '+355', name: 'Albania', format: '066 000 0000' },
  { iso: 'DZ', code: '+213', name: 'Algeria', format: '0550 00 00 00' },
  { iso: 'AD', code: '+376', name: 'Andorra', format: '000 000' },
  { iso: 'AO', code: '+244', name: 'Angola', format: '923 000 000' },
  { iso: 'AR', code: '+54', name: 'Argentina', format: '11 0000-0000' },
  { iso: 'AM', code: '+374', name: 'Armenia', format: '00 000000' },
  { iso: 'AU', code: '+61', name: 'Australia', format: '0412 000 000' },
  { iso: 'AT', code: '+43', name: 'Austria', format: '0664 0000000' },
  { iso: 'AZ', code: '+994', name: 'Azerbaijan', format: '040 000 00 00' },

  { iso: 'BH', code: '+973', name: 'Bahrain', format: '3600 0000' },
  { iso: 'BD', code: '+880', name: 'Bangladesh', format: '01700-000000' },
  { iso: 'BY', code: '+375', name: 'Belarus', format: '029 000-00-00' },
  { iso: 'BE', code: '+32', name: 'Belgium', format: '0470 00 00 00' },
  { iso: 'BZ', code: '+501', name: 'Belize', format: '622-0000' },
  { iso: 'BJ', code: '+229', name: 'Benin', format: '90 00 00 00' },
  { iso: 'BT', code: '+975', name: 'Bhutan', format: '17 000 000' },
  { iso: 'BO', code: '+591', name: 'Bolivia', format: '71200000' },
  { iso: 'BA', code: '+387', name: 'Bosnia and Herzegovina', format: '061 000 000' },
  { iso: 'BW', code: '+267', name: 'Botswana', format: '71 000 000' },
  { iso: 'BR', code: '+55', name: 'Brazil', format: '(11) 00000-0000' },
  { iso: 'BN', code: '+673', name: 'Brunei', format: '712 0000' },
  { iso: 'BG', code: '+359', name: 'Bulgaria', format: '048 000 000' },
  { iso: 'BF', code: '+226', name: 'Burkina Faso', format: '70 00 00 00' },
  { iso: 'BI', code: '+257', name: 'Burundi', format: '79 56 00 00' },

  { iso: 'KH', code: '+855', name: 'Cambodia', format: '091 000 000' },
  { iso: 'CM', code: '+237', name: 'Cameroon', format: '6 70 00 00 00' },
  { iso: 'CA', code: '+1', name: 'Canada', format: '(000) 000-0000' },
  { iso: 'CV', code: '+238', name: 'Cape Verde', format: '991 00 00' },
  { iso: 'CF', code: '+236', name: 'Central African Republic', format: '70 00 00 00' },
  { iso: 'TD', code: '+235', name: 'Chad', format: '63 00 00 00' },
  { iso: 'CL', code: '+56', name: 'Chile', format: '9 0000 0000' },
  { iso: 'CN', code: '+86', name: 'China', format: '138 0000 0000' },
  { iso: 'CO', code: '+57', name: 'Colombia', format: '300 0000000' },
  { iso: 'KM', code: '+269', name: 'Comoros', format: '321 00 00' },
  { iso: 'CG', code: '+242', name: 'Congo (Congo-Brazzaville)', format: '06 000 0000' },
  { iso: 'CD', code: '+243', name: 'Congo (DRC)', format: '099 000 0000' },
  { iso: 'CR', code: '+506', name: 'Costa Rica', format: '8300 0000' },
  { iso: 'HR', code: '+385', name: 'Croatia', format: '091 000 0000' },
  { iso: 'CU', code: '+53', name: 'Cuba', format: '05 000 0000' },
  { iso: 'CY', code: '+357', name: 'Cyprus', format: '96 000000' },
  { iso: 'CZ', code: '+420', name: 'Czechia', format: '601 000 000' },

  { iso: 'DK', code: '+45', name: 'Denmark', format: '00 00 00 00' },
  { iso: 'DJ', code: '+253', name: 'Djibouti', format: '77 00 00 00' },
  { iso: 'DM', code: '+1767', name: 'Dominica', format: '000-0000' },
  { iso: 'DO', code: '+1', name: 'Dominican Republic', format: '(000) 000-0000' },

  { iso: 'EC', code: '+593', name: 'Ecuador', format: '099 000 0000' },
  { iso: 'EG', code: '+20', name: 'Egypt', format: '0100 000 0000' },
  { iso: 'SV', code: '+503', name: 'El Salvador', format: '7000 0000' },
  { iso: 'GQ', code: '+240', name: 'Equatorial Guinea', format: '222 000 000' },
  { iso: 'ER', code: '+291', name: 'Eritrea', format: '07 000 000' },
  { iso: 'EE', code: '+372', name: 'Estonia', format: '5000 0000' },
  { iso: 'SZ', code: '+268', name: 'Eswatini', format: '7600 0000' },
  { iso: 'ET', code: '+251', name: 'Ethiopia', format: '091 000 0000' },

  { iso: 'FJ', code: '+679', name: 'Fiji', format: '700 0000' },
  { iso: 'FI', code: '+358', name: 'Finland', format: '041 2345678' },
  { iso: 'FR', code: '+33', name: 'France', format: '06 00 00 00 00' },

  { iso: 'GA', code: '+241', name: 'Gabon', format: '06 00 00 00' },
  { iso: 'GM', code: '+220', name: 'Gambia', format: '301 0000' },
  { iso: 'GE', code: '+995', name: 'Georgia', format: '0555 00 00 00' },
  { iso: 'DE', code: '+49', name: 'Germany', format: '0151 00000000' },
  { iso: 'GH', code: '+233', name: 'Ghana', format: '024 000 0000' },
  { iso: 'GR', code: '+30', name: 'Greece', format: '691 000 0000' },
  { iso: 'GD', code: '+1473', name: 'Grenada', format: '000-0000' },
  { iso: 'GT', code: '+502', name: 'Guatemala', format: '5000 0000' },
  { iso: 'GN', code: '+224', name: 'Guinea', format: '601 00 00 00' },
  { iso: 'GW', code: '+245', name: 'Guinea-Bissau', format: '955 000000' },
  { iso: 'GY', code: '+592', name: 'Guyana', format: '600 0000' },

  { iso: 'HT', code: '+509', name: 'Haiti', format: '34 00 0000' },
  { iso: 'HN', code: '+504', name: 'Honduras', format: '9000-0000' },
  { iso: 'HK', code: '+852', name: 'Hong Kong', format: '5100 0000' },
  { iso: 'HU', code: '+36', name: 'Hungary', format: '06 20 000 0000' },

  { iso: 'IS', code: '+354', name: 'Iceland', format: '611 0000' },
  { iso: 'IN', code: '+91', name: 'India', format: '98000 00000' },
  { iso: 'ID', code: '+62', name: 'Indonesia', format: '0812 000 0000' },
  { iso: 'IR', code: '+98', name: 'Iran', format: '0912 000 0000' },
  { iso: 'IQ', code: '+964', name: 'Iraq', format: '0790 000 0000' },
  { iso: 'IE', code: '+353', name: 'Ireland', format: '085 000 0000' },
  { iso: 'IL', code: '+972', name: 'Israel', format: '050-000-0000' },
  { iso: 'IT', code: '+39', name: 'Italy', format: '312 000 0000' },

  { iso: 'JM', code: '+1876', name: 'Jamaica', format: '000-0000' },
  { iso: 'JP', code: '+81', name: 'Japan', format: '090-0000-0000' },
  { iso: 'JO', code: '+962', name: 'Jordan', format: '079 000 0000' },

  { iso: 'KZ', code: '+7', name: 'Kazakhstan', format: '700 000 0000' },
  { iso: 'KE', code: '+254', name: 'Kenya', format: '0712 000000' },
  { iso: 'KI', code: '+686', name: 'Kiribati', format: '72000000' },
  { iso: 'KW', code: '+965', name: 'Kuwait', format: '500 00000' },
  { iso: 'KG', code: '+996', name: 'Kyrgyzstan', format: '0700 000 000' },

  { iso: 'LA', code: '+856', name: 'Laos', format: '020 0000 0000' },
  { iso: 'LV', code: '+371', name: 'Latvia', format: '21 000 000' },
  { iso: 'LB', code: '+961', name: 'Lebanon', format: '71 000 000' },
  { iso: 'LS', code: '+266', name: 'Lesotho', format: '5000 0000' },
  { iso: 'LR', code: '+231', name: 'Liberia', format: '077 000 0000' },
  { iso: 'LY', code: '+218', name: 'Libya', format: '091-0000000' },
  { iso: 'LI', code: '+423', name: 'Liechtenstein', format: '660 000 000' },
  { iso: 'LT', code: '+370', name: 'Lithuania', format: '0600 00000' },
  { iso: 'LU', code: '+352', name: 'Luxembourg', format: '621 000 000' },

  { iso: 'MO', code: '+853', name: 'Macao', format: '6600 0000' },
  { iso: 'MG', code: '+261', name: 'Madagascar', format: '032 00 000 00' },
  { iso: 'MW', code: '+265', name: 'Malawi', format: '0991 00 00 00' },
  { iso: 'MY', code: '+60', name: 'Malaysia', format: '012-000 0000' },
  { iso: 'MV', code: '+960', name: 'Maldives', format: '771-0000' },
  { iso: 'ML', code: '+223', name: 'Mali', format: '65 00 00 00' },
  { iso: 'MT', code: '+356', name: 'Malta', format: '9696 0000' },
  { iso: 'MR', code: '+222', name: 'Mauritania', format: '22 00 00 00' },
  { iso: 'MU', code: '+230', name: 'Mauritius', format: '5250 0000' },
  { iso: 'MX', code: '+52', name: 'Mexico', format: '000 000 0000' },
  { iso: 'MD', code: '+373', name: 'Moldova', format: '0621 00 000' },
  { iso: 'MC', code: '+377', name: 'Monaco', format: '06 00 00 00 00' },
  { iso: 'MN', code: '+976', name: 'Mongolia', format: '8800 0000' },
  { iso: 'ME', code: '+382', name: 'Montenegro', format: '067 000 000' },
  { iso: 'MA', code: '+212', name: 'Morocco', format: '0650-000000' },
  { iso: 'MZ', code: '+258', name: 'Mozambique', format: '82 000 0000' },
  { iso: 'MM', code: '+95', name: 'Myanmar', format: '09 000 0000' },

  { iso: 'NA', code: '+264', name: 'Namibia', format: '081 000 0000' },
  { iso: 'NP', code: '+977', name: 'Nepal', format: '098-0000000' },
  { iso: 'NL', code: '+31', name: 'Netherlands', format: '06 00000000' },
  { iso: 'NZ', code: '+64', name: 'New Zealand', format: '021 000 000' },
  { iso: 'NI', code: '+505', name: 'Nicaragua', format: '8000 0000' },
  { iso: 'NE', code: '+227', name: 'Niger', format: '93 00 00 00' },
  { iso: 'KP', code: '+850', name: 'North Korea', format: '0192 000 0000' },
  { iso: 'MK', code: '+389', name: 'North Macedonia', format: '070 000 000' },
  { iso: 'NO', code: '+47', name: 'Norway', format: '400 00 000' },

  { iso: 'OM', code: '+968', name: 'Oman', format: '9200 0000' },

  { iso: 'PK', code: '+92', name: 'Pakistan', format: '0300 0000000' },
  { iso: 'PA', code: '+507', name: 'Panama', format: '6000-0000' },
  { iso: 'PG', code: '+675', name: 'Papua New Guinea', format: '7000 0000' },
  { iso: 'PY', code: '+595', name: 'Paraguay', format: '0961 000000' },
  { iso: 'PE', code: '+51', name: 'Peru', format: '900 000 000' },
  { iso: 'PH', code: '+63', name: 'Philippines', format: '0917 000 0000' },
  { iso: 'PL', code: '+48', name: 'Poland', format: '000 000 000' },
  { iso: 'PT', code: '+351', name: 'Portugal', format: '910 000 000' },

  { iso: 'QA', code: '+974', name: 'Qatar', format: '3300 0000' },

  { iso: 'RO', code: '+40', name: 'Romania', format: '0712 000 000' },
  { iso: 'RU', code: '+7', name: 'Russia', format: '000 000-00-00' },
  { iso: 'RW', code: '+250', name: 'Rwanda', format: '0788 000 000' },

  { iso: 'KN', code: '+1869', name: 'Saint Kitts and Nevis', format: '000-0000' },
  { iso: 'LC', code: '+1758', name: 'Saint Lucia', format: '000-0000' },
  { iso: 'VC', code: '+1784', name: 'Saint Vincent and the Grenadines', format: '000-0000' },
  { iso: 'WS', code: '+685', name: 'Samoa', format: '72 00000' },
  { iso: 'SM', code: '+378', name: 'San Marino', format: '66 66 12 12' },
  { iso: 'ST', code: '+239', name: 'Sao Tome and Principe', format: '981 0000' },
  { iso: 'SA', code: '+966', name: 'Saudi Arabia', format: '050 000 0000' },
  { iso: 'SN', code: '+221', name: 'Senegal', format: '77 000 00 00' },
  { iso: 'RS', code: '+381', name: 'Serbia', format: '060 0000000' },
  { iso: 'SC', code: '+248', name: 'Seychelles', format: '2 510 000' },
  { iso: 'SL', code: '+232', name: 'Sierra Leone', format: '025 000000' },
  { iso: 'SG', code: '+65', name: 'Singapore', format: '8100 0000' },
  { iso: 'SK', code: '+421', name: 'Slovakia', format: '0912 000 000' },
  { iso: 'SI', code: '+386', name: 'Slovenia', format: '031 000 000' },
  { iso: 'SB', code: '+677', name: 'Solomon Islands', format: '740 0000' },
  { iso: 'SO', code: '+252', name: 'Somalia', format: '7 000 0000' },
  { iso: 'ZA', code: '+27', name: 'South Africa', format: '071 000 0000' },
  { iso: 'KR', code: '+82', name: 'South Korea', format: '010-0000-0000' },
  { iso: 'SS', code: '+211', name: 'South Sudan', format: '0977 000 000' },
  { iso: 'ES', code: '+34', name: 'Spain', format: '600 00 00 00' },
  { iso: 'LK', code: '+94', name: 'Sri Lanka', format: '071 000 0000' },
  { iso: 'SD', code: '+249', name: 'Sudan', format: '091 000 0000' },
  { iso: 'SR', code: '+597', name: 'Suriname', format: '741-0000' },
  { iso: 'SE', code: '+46', name: 'Sweden', format: '070-000 00 00' },
  { iso: 'CH', code: '+41', name: 'Switzerland', format: '078 000 00 00' },
  { iso: 'SY', code: '+963', name: 'Syria', format: '0944 000 000' },

  { iso: 'TW', code: '+886', name: 'Taiwan', format: '0912 000 000' },
  { iso: 'TJ', code: '+992', name: 'Tajikistan', format: '917 000 000' },
  { iso: 'TZ', code: '+255', name: 'Tanzania', format: '0621 000 000' },
  { iso: 'TH', code: '+66', name: 'Thailand', format: '081 000 0000' },
  { iso: 'TL', code: '+670', name: 'Timor-Leste', format: '7700 0000' },
  { iso: 'TG', code: '+228', name: 'Togo', format: '90 00 00 00' },
  { iso: 'TO', code: '+676', name: 'Tonga', format: '770 0000' },
  { iso: 'TT', code: '+1868', name: 'Trinidad and Tobago', format: '000-0000' },
  { iso: 'TN', code: '+216', name: 'Tunisia', format: '20 000 000' },
  { iso: 'TR', code: '+90', name: 'Turkey', format: '0500 000 00 00' },
  { iso: 'TM', code: '+993', name: 'Turkmenistan', format: '65 000000' },
  { iso: 'TV', code: '+688', name: 'Tuvalu', format: '90 0000' },

  { iso: 'UG', code: '+256', name: 'Uganda', format: '0712 000000' },
  { iso: 'UA', code: '+380', name: 'Ukraine', format: '050 000 0000' },
  { iso: 'AE', code: '+971', name: 'United Arab Emirates', format: '050 000 0000' },
  { iso: 'GB', code: '+44', name: 'United Kingdom', format: '07700 000000' },
  { iso: 'US', code: '+1', name: 'United States', format: '(000) 000-0000' },
  { iso: 'UY', code: '+598', name: 'Uruguay', format: '094 000 000' },
  { iso: 'UZ', code: '+998', name: 'Uzbekistan', format: '90 000 00 00' },

  { iso: 'VU', code: '+678', name: 'Vanuatu', format: '590 0000' },
  { iso: 'VA', code: '+379', name: 'Vatican City', format: '06 698 00000' },
  { iso: 'VE', code: '+58', name: 'Venezuela', format: '0412-0000000' },
  { iso: 'VN', code: '+84', name: 'Vietnam', format: '090 000 00 00' },

  { iso: 'YE', code: '+967', name: 'Yemen', format: '0712 000 000' },

  { iso: 'ZM', code: '+260', name: 'Zambia', format: '095 0000000' },
  { iso: 'ZW', code: '+263', name: 'Zimbabwe', format: '071 000 0000' },
];

export const DEFAULT_COUNTRY = COUNTRY_CODES[0];

/** Look up a country by ISO alpha-2 code (used when only the code is known,
 *  e.g. restoring a previously-picked entry among countries sharing a dial code). */
export function countryByIso(iso: string): CountryOption | undefined {
  return COUNTRY_CODES.find((c) => c.iso === iso);
}

// Format strings like Nigeria's "080 0000 0000" or Kenya's "0712 000000" are
// human-readable EXAMPLE numbers, not pure templates — the '8', '7', '1', '2'
// are real example digits, not placeholder characters. Treating only literal
// '0' as a placeholder (the previous approach) left those example digits
// hardcoded into the display no matter what the user actually typed. Every
// digit character in the format string is a placeholder position; only
// non-digits (spaces, dashes, parens) are literal separators.

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

// Generic cross-country validity check for a national number (raw digits,
// no leading zero stripped, no country code). Nigeria gets the exact,
// stricter regex from regionConfig.ts wherever that matters (network-prefix
// aware); every other country is checked against a reasonable digit-count
// range instead of a hand-authored exact pattern per country, since we
// don't have a verified format template for all ~195 countries in this list
// — a range still rejects obvious garbage (empty, 2 digits, 20 digits)
// without falsely rejecting a real number this codebase can't format exactly.
export function isPlausibleNationalNumber(digits: string, country: CountryOption): boolean {
  const max = maxDigitsFor(country);
  const min = Math.max(4, max - 2);
  return digits.length >= min && digits.length <= max;
}

// Combines a selected country's dial code with the raw national-number
// digits into a single E.164 string — the single shared implementation used
// everywhere a phone number is collected (signup, profile settings,
// checkout) so a display-formatted or locally-prefixed value never reaches
// the backend. Strips any leading zeros from the national number first —
// critical for countries like Nigeria where the local convention is a
// leading trunk-prefix 0 (e.g. "080..."), which must NOT be carried into
// the E.164 form (+234080... is wrong; +23480... is correct). Harmless for
// countries with no such convention.
export function buildE164(nationalDigits: string, countryCode: string): string {
  const digits = nationalDigits.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  return countryCode + digits;
}
