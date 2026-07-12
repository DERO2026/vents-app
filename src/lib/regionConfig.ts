// Single source of truth for the region-specific constants scattered across
// this codebase (currency symbol/code, phone format, locale, service fee,
// support contact, timezone offset). VENTS currently launches Nigeria-only,
// and that assumption goes deeper than this file — Paystack bank lookups
// are hardcoded to country=nigeria (api/wallet/banks.ts), Sendchamp SMS is
// Nigeria/Africa-only, CAC business verification has no non-Nigerian
// equivalent, and the wallet/ticket schema itself uses kobo-denominated
// column names (amount_kobo, balance_kobo, ...) across ~10 migrations.
// Consolidating the app-layer constants here doesn't solve multi-region
// support by itself, but it turns "change the phone regex in 3 files" into
// "change it in 1" and gives a real multi-region effort a single place to
// start from instead of a codebase-wide grep.
export const REGION = {
  currencySymbol: '₦',
  currencyCode: 'NGN',
  locale: 'en-NG',
  phoneCountryCode: '+234',
  // Nigerian mobile numbers: +234 then a network prefix (7/8/9), then 0/1,
  // then 8 more digits.
  phoneRegex: /^\+234[789][01]\d{8}$/,
  serviceFeePercent: 5,
  timezoneOffset: '+01:00',
  supportWhatsApp: '+2349030737368',
} as const;
