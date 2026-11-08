// VENTS ticket pricing (owner instruction 2026-11-08; migration 0208, fee
// model 'v3_15_35'). Client-side mirror for display and pre-checks only --
// the database computes and enforces every amount
// (public.ticket_fee_buyer_charge_kobo / ticket_fee_commission_kobo), per
// ticket, by the fee model recorded on the ticket.
//
//   attendee pays       face + 1.5% service fee      (shown at checkout)
//   organizer receives  face - 3.5% commission       (shown when pricing tickets)
//   VENTS keeps         5% of the ticket price in total
//
// Every amount is computed per ticket in kobo (half-up) and multiplied by
// the quantity, exactly like ticket_fee_buyer_charge_kobo, so the checkout
// total equals what Paystack or the VENTS Wallet is charged to the kobo.
// Tickets bought under older models keep their recorded amounts.
import { REGION } from './regionConfig';

export const TICKET_SERVICE_FEE_RATE = 0.015;
export const TICKET_ORGANIZER_COMMISSION_FRACTION = 0.035;
export const TICKET_SERVICE_FEE_LABEL = 'Service fee (1.5%)';
export const TICKET_ORGANIZER_COMMISSION_LABEL = 'VENTS commission (3.5%)';

// Approximate fee-inclusive multiplier (no promo), for reconstructing a
// subtotal from a stored total where the per-ticket split is not available.
export const TICKET_BUYER_MULTIPLIER = 1 + TICKET_SERVICE_FEE_RATE;

/** One ticket's face value in kobo. */
export function ticketFaceKobo(unitPriceNaira: number): number {
  return Math.round(Math.max(0, Number(unitPriceNaira) || 0) * 100);
}

/** 1.5% attendee service fee on one ticket (kobo, half-up), as round(F * 15 / 1000). */
export function ticketServiceFeeKobo(faceKobo: number): number {
  return Math.round((Math.max(0, faceKobo) * 15) / 1000);
}

/** 3.5% organizer commission on one ticket (kobo, half-up), as ticket_fee_commission_kobo. */
export function organizerCommissionKobo(faceKobo: number): number {
  return Math.round((Math.max(0, faceKobo) * 35) / 1000);
}

/** What the organizer receives for one ticket before any other adjustment. */
export function organizerNetKobo(faceKobo: number): number {
  return Math.max(0, faceKobo) - organizerCommissionKobo(faceKobo);
}

export interface TicketCheckoutKobo {
  faceKobo: number;
  serviceFeeKobo: number;
  discountKobo: number;
  totalKobo: number;
}

/** Checkout breakdown for `quantity` tickets at `unitPriceNaira`, as ticket_fee_buyer_charge_kobo. */
export function ticketCheckoutKobo(unitPriceNaira: number, quantity: number, discountPct = 0): TicketCheckoutKobo {
  const qty = Math.max(0, Math.floor(quantity) || 0);
  const face = ticketFaceKobo(unitPriceNaira);
  const fee = ticketServiceFeeKobo(face);
  const discount = Math.round((face * Math.max(0, discountPct || 0)) / 100);
  return {
    faceKobo: qty * face,
    serviceFeeKobo: qty * fee,
    discountKobo: qty * discount,
    totalKobo: qty * Math.max(0, face + fee - discount),
  };
}

/** Naira amount from kobo with kobo shown only when there are any: ₦10,150 / ₦1,016.02. */
export function formatKobo(kobo: number): string {
  const value = Math.max(0, Math.round(kobo)) / 100;
  const hasKobo = Math.round(kobo) % 100 !== 0;
  return `${REGION.currencySymbol}${value.toLocaleString('en-NG', {
    minimumFractionDigits: hasKobo ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
