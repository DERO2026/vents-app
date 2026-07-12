import { REGION } from '../../lib/regionConfig';

export function formatPrice(amount: number | null | undefined): string {
  if (!amount) return 'Free';
  return `${REGION.currencySymbol}${amount.toLocaleString?.() || amount}`;
}
