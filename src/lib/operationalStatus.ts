// Maps the server-side emergency kill-switch error codes (raised by
// create_pending_purchase/purchase_ticket, create_service_booking,
// request_organizer_payout, initiate_wallet_deposit when their operation is
// disabled -- see 0124_emergency_kill_switches.sql) to a friendly,
// VENTS-branded message. The backend is the security mechanism; this is
// purely presentation -- it never decides whether an operation proceeds.
const DISABLED_OPERATION_MESSAGES: Record<string, string> = {
  purchases_disabled: 'Ticket purchases are temporarily unavailable while we perform maintenance. Please try again later.',
  bookings_disabled: 'Service bookings are temporarily unavailable while we perform maintenance. Please try again later.',
  deposits_disabled: 'Wallet top-ups are temporarily unavailable while we perform maintenance. Please try again later.',
  payouts_disabled: 'Withdrawals are temporarily unavailable while we perform maintenance. Please try again later.',
};

export function friendlyOperationalError(message: string | null | undefined): string | null {
  if (!message) return null;
  const code = Object.keys(DISABLED_OPERATION_MESSAGES).find((k) => message.includes(k));
  return code ? DISABLED_OPERATION_MESSAGES[code] : null;
}
