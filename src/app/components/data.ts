export function formatPrice(amount: number): string {
  if (amount === 0) return 'Free';
  return `₦${amount.toLocaleString()}`;
}
