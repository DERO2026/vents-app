// VENTS ticket pricing (approved 2026-10-30; migration 0203). Client-side
// mirror for display only -- the database computes and enforces every
// amount (public.ticket_fee_buyer_multiplier / ticket_fee_commission_kobo),
// per ticket, by the fee model recorded on the ticket.
//
//   buyer pays          face + 4% service fee (before any promo discount)
//   organizer receives  face - 5% commission
//
// Tickets bought before 0203 keep the legacy model (buyer paid face + 5%,
// organizer received face); their history is shown as recorded.

export const TICKET_SERVICE_FEE_RATE = 0.04;
export const TICKET_ORGANIZER_COMMISSION_FRACTION = 0.05;
export const TICKET_SERVICE_FEE_LABEL = 'Service fee (4%)';

// Buyer-facing multiplier on the face value, as in create_pending_purchase.
export const TICKET_BUYER_MULTIPLIER = 1 + TICKET_SERVICE_FEE_RATE;

export function ticketServiceFee(subtotal: number): number {
  return Math.round(subtotal * TICKET_SERVICE_FEE_RATE);
}

// ticket_fee_commission_kobo: round(face_kobo * 5 / 100).
export function organizerCommissionKobo(faceKobo: number): number {
  return Math.round(Math.max(0, faceKobo) * TICKET_ORGANIZER_COMMISSION_FRACTION);
}

export function organizerNetKobo(faceKobo: number): number {
  return Math.max(0, faceKobo) - organizerCommissionKobo(faceKobo);
}
