// Money formatting for ticket amounts. Fee RATES are not defined in the app:
// every fee amount shown comes from the database (src/lib/ticketQuote.ts ->
// public.ticket_fee_quote, migration 0208), which uses the same functions that
// charge, settle and refund.
import { REGION } from './regionConfig';

/** Naira amount from kobo with kobo shown only when there are any: ₦10,150 / ₦1,016.02. */
export function formatKobo(kobo: number): string {
  const value = Math.max(0, Math.round(kobo)) / 100;
  const hasKobo = Math.round(kobo) % 100 !== 0;
  return `${REGION.currencySymbol}${value.toLocaleString('en-NG', {
    minimumFractionDigits: hasKobo ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
