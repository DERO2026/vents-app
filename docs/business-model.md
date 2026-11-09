# VENTS business model (authoritative)

Owner decision, 2026-11-09. This page overrides any older document, migration comment or UI text that disagrees with it.

## 1. Event ticket fees: two VENTS platform fees, no commission

| Fee | Rate | Who pays | Where |
|---|---|---|---|
| Attendee service fee | 1.5% of each ticket's face value | The attendee, added at checkout | `ticket_fee_buyer_charge_kobo` |
| Organizer platform deduction | 3.5% of each ticket's face value | The organizer, deducted from ticket revenue before settlement | `ticket_fee_organizer_deduction_kobo` |

VENTS keeps both fees as platform revenue.

**There is no commission of any kind.** Nobody receives a percentage of ticket sales: not the organizer, a representative or a recruiter, and there is no referral commission. The retired 10% representative commission programme (0193) was never paid. 0201 retired it, and 0210 makes it impossible to record a commission split again.

Every amount is computed **per ticket, in kobo, rounded half-up**, then multiplied by the quantity (fee model `v3_15_35`, migration 0208).

| Ticket | Attendee pays | Organizer deduction | Organizer receives | VENTS keeps |
|---|---|---|---|---|
| ₦20,000 | ₦20,300 | ₦700 | ₦19,300 | ₦1,000 |
| ₦70,000 | ₦71,050 | ₦2,450 | ₦67,550 | ₦3,500 |
| ₦70,000 × 2 | ₦142,100 | ₦4,900 | ₦135,100 | ₦7,000 |

The database is the only place these numbers are calculated:
- **Checkout, event page and Create Event:** shown from `ticket_fee_quote`.
- **Before payment:** checkout refuses to open Paystack if the server's amount differs from the quote it displayed.
- **After payment:** payment confirmation recomputes the amount on the server.

The 4% + 5% model (`v2_4_5`) that 0203 introduced never sells: 0208 removes it. The legacy 5% attendee fee (`legacy_5`) applies only to tickets bought before the release.

## 2. Promo codes: funded by VENTS

- Promo codes are platform-level; organizers cannot create them.
- The attendee service fee is calculated on the **full** face value.
- The discount comes off what the attendee pays.
- The organizer's settlement is never reduced.

Example: a ₦20,000 ticket with a ₦2,000 promo.

| Item | Amount |
|---|---|
| Attendee pays | ₦18,300 (₦20,000 + ₦300 − ₦2,000) |
| Organizer receives | ₦19,300 |
| VENTS platform fees | ₦1,000 |
| Discount VENTS funds | ₦2,000 |

`ticket_fee_quote` reports this split as `vents_platform_fees_kobo` and `vents_funded_discount_kobo`.

## 3. Service-provider bookings: unchanged

Bookings keep their existing **5%** booking fee, computed separately (`service_bookings.fee_kobo`). The ticket fees above never apply to bookings.

## 4. Representative reward: fixed ₦50,000 per qualifying organizer

It is a fixed reward paid by VENTS, never a commission or revenue share. There is at most one per organizer. It is credited to the representative's **withdrawable earnings wallet**, never the spend-only VENTS Wallet or VENTS Cents.

A reward becomes payable only after **all** of the following (0201, 0209):

1. **Attributed.** The organizer is genuinely attributed to the representative (section 5).
2. **Verified.** The organizer holds an approved organizer verification.
3. **Paid event.** The organizer creates and publishes a **paid** event after the attribution. Free events never qualify.
4. **Event took place.** The event is live, not deleted, hidden or cancelled, and its date has passed. The settlement hold has elapsed, and there are no pending payments, purchases or refunds.
5. **Organizer confirms.** The organizer confirms the referral.
6. **Two admins approve.** Two different VENTS admins approve, neither of them the representative or the organizer. The approval records that **the event took place** (`event_verified`).
7. **Programme open.** Management has recorded the reconciliation of the retired 10% programme.
8. **Funded and paid.** The reward is funded from recognised VENTS profit, then credited to the representative's wallet while payouts are enabled.
9. **Two-admin withdrawal.** Withdrawal follows the existing two-admin payout approval.

A link click, a registration, a verification or an event alone earns nothing.

Reward states:

| State | Meaning |
|---|---|
| `pending_organizer` | Waiting for the organizer to confirm |
| `pending_review` | Two admins are reviewing |
| `approved` | Approved |
| `funded` | Available to add to the earnings wallet |
| `credited` | Paid (withdrawals are tracked by the wallet) |
| `rejected` | Not approved |
| `reversed` | Taken back by VENTS |

## 5. The referral, from both sides

Attribution policy, enforced on the server:
- **One representative per organizer, ever.** It is created by the first **accepted** invitation, or by the referral link used **at registration**.
- **Link limits.** A link only attributes a new account (within 72 hours of creating it). It never attributes an existing organizer, the representative themself, or another representative.
- **Never changed by the client.** The attribution is never reassigned, overwritten or set from the client.
- **Audited.** Duplicate and self-referral attempts are refused and audited.

**Representative**
- Link and code (`get_my_representative_referral`), with copy and native share.
- Their own name and @username as organizers will see them.
- Each organizer they referred, with @username, source, verification, qualifying-event state and reward state.
- The six reward steps.

**Organizer**
- **Before registering:** "<Name> · @username invited you to VENTS". This comes from the server (`get_representative_referral_preview`), never from the URL.
- **After registering:** "Your VENTS Representative" in VENTS Work (`get_my_representative_connection`):
  - the connection state: established (permanent), pending (unanswered invitation) or connecting;
  - their events and why each does not qualify yet;
  - reward confirmations;
  - the same six steps;
  - a statement that being referred costs them nothing.

**Admin**
- Attributions, claims and the event-occurrence confirmation in VENTS Earn admin.
- Every action goes through two-admin dual control and is written to the append-only `earn_audit_log`.

## 6. What is not live

None of this is in production until the owner authorises the release window: migrations 0201 → 0210 (runbook W4–W6f), then promoting the `main` build (W7). Production still charges the legacy 5% attendee fee with no organizer deduction. Production's Settings → Representatives screen still shows the retired 10% text until the new build is deployed.
