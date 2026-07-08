export function formatPrice(amount: number | null | undefined): string {
  if (!amount) return 'Free';
  return `₦${amount.toLocaleString?.() || amount}`;
}
