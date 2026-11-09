# VENTS Monetization Implementation Master Checklist

This tracker covers the original 12-part VENTS monetization checklist supplied on 2026-10-30, corrected to the owner's **final business model of 2026-11-09**. That model is the authoritative source: see `docs/business-model.md`. Where the two disagree, `docs/business-model.md` wins.

Legend:
- `[x]` built and tested in the repository;
- `[~]` partially built;
- `[ ]` not built.

**Built is not live.** Nothing below is live in production unless it says so. Migrations 0201–0210 are unapplied, and getvents.com serves an older build, until the owner authorises the release window (runbook W4–W6f, W7).

## Approved model (2026-11-09)

### Event tickets: two VENTS platform fees and nothing else
- **Attendee service fee:** 1.5% per ticket, added at checkout.
- **Organizer platform deduction:** 3.5% per ticket, deducted from the organizer's ticket revenue.
- **No commission of any kind.** There is no organizer, representative, recruiter or referral commission, and nobody receives a percentage of ticket sales.

| Ticket | Attendee pays | Organizer receives | VENTS keeps |
|---|---|---|---|
| ₦20,000 | ₦20,300 | ₦19,300 | ₦1,000 |
| ₦70,000 | ₦71,050 | ₦67,550 | ₦3,500 |

### Promo codes
- Platform-level and funded by VENTS.
- The fee is calculated on the full face value, and the organizer's settlement never drops. Example: ₦20,000 with ₦2,000 off means the attendee pays ₦18,300 and the organizer gets ₦19,300.

### Service-provider bookings
- The existing **5%** booking fee is unchanged, and kept separate from ticket fees.

### Representatives
- **Reward:** a **fixed ₦50,000** per qualifying organizer, once per organizer, paid by VENTS into the representative's **withdrawable earnings wallet**. Never the spend-only VENTS Wallet or VENTS Cents.
- **Qualifying requires all of the following:**
  - the organizer is attributed to the representative (by an accepted invitation, or the referral link used at registration);
  - the organizer holds an approved verification;
  - the organizer publishes a **paid** event after the attribution;
  - the event is not cancelled, its date has passed and it has settled;
  - the organizer confirms the referral;
  - two different VENTS admins confirm the event took place and approve the reward.
- **Never qualifies:** a **free** event, or a click, sign-up, verification or event creation on its own.
- **Payment:** made once recognised VENTS ticket profit covers it. Withdrawal needs two-admin approval.
- **The retired 10% programme** was never paid. Its history is kept for audit, and no commission split can be recorded again (0210).

## Original checklist: all revenue streams

### 1. Ticketing fees
- [x] **Attendee service fee, 1.5% per ticket** (0208 `ticket_fee_buyer_charge_kobo`, `ticket_fee_quote`). Tested: fee suite 64/64.
  - Supersedes the earlier 4%-attendee proposal. 0208 removes the 4% + 5% model entirely.
  - **Production still charges the legacy 5% attendee fee** until 0203 + 0208 are applied.
- [x] **Organizer platform deduction, 3.5% per ticket** (0208 `ticket_fee_organizer_deduction_kobo`; settlement credits face − deduction into the 48 h hold, 0203).
  - Supersedes the earlier "5% organizer commission".
  - **Production still credits organizers the full face** until the release.
- [x] **Combined VENTS ticket revenue, 5%** (1.5% + 3.5%). Reported by `ticket_fee_quote` as `vents_platform_fees_kobo`; VENTS-funded promo discounts are reported separately (`vents_funded_discount_kobo`).
- [x] **Checkout shows the selected ticket, quantity, subtotal, attendee service fee, promo and total payable.**
  - Paystack starts only if the server amount equals the quote shown.
  - Payment confirmation recomputes the amount on the server.
- [~] Ticket transfer fee: 7.5%, ₦500 minimum, ₦5,000 maximum. A transfer fee exists in the app; audit its edge cases.
- [ ] Refund administration fee: ₦500–₦1,000 proposed. Not approved; needs a policy and legal review first.
- [ ] Expedited organizer payout: ₦500–₦1,500 proposed optional service. Not approved.

### 2. Event promotions and advertising
- [~] Trending: 3 days ₦75,000; 7 days ₦150,000; 14 days ₦275,000; 30 days ₦500,000.
  - The source price table matches.
  - Verify billing, fulfilment and expiry in production.
- [~] Featured: 3 days ₦150,000; 7 days ₦250,000.
  - The source also offers 14- and 30-day tiers that the master list doesn't include; reconcile them.
- [ ] Sponsored event campaigns: negotiated pricing, campaign workflow and fulfilment.
- [ ] Sponsored discovery/category placements: ₦25,000–₦75,000 proposed.
- [ ] Brand sponsorships and advertising partnerships: negotiated contracts.

### 3. Service marketplace fees
- [x] **Existing 5% service-provider booking fee: kept unchanged** (owner decision 2026-11-09).
- [ ] Customer 2% booking fee plus provider 5% platform fee (earlier proposal). **Not adopted.** The existing 5% booking fee stays.
- [ ] Cancellation/no-show penalties: ₦2,000–₦5,000 proposed. Needs a policy and dispute handling first.
- [ ] Paid service-provider promotion: ₦10,000–₦25,000/month proposed.

### 4. Organizer subscriptions (proposed, not built)
- [ ] Starter (free), Pro ₦10,000/month, Business ₦25,000/month.
- [ ] Billing, renewal, cancellation, expiry and plan access controls.

### 5. Service-provider subscriptions (proposed, not built)
- [ ] Basic (free), Professional ₦5,000/month, Premium ₦15,000/month.
- [ ] Billing, renewal, cancellation, expiry and access controls.

### 6. Vendor marketplace (proposed, not built)
- [ ] Basic listing (free), premium ₦5,000/month, featured ₦10,000–₦25,000/month, sponsored category ₦25,000–₦75,000/month.
- [ ] A 5% platform fee on eligible vendor sales (proposal).
- [ ] Vendor payments, orders, refunds and fee records.

### 7. VENTS Wallet and payouts
- [~] Wallet deposits: ₦0 VENTS fee; account for payment-processing cost.
- [ ] Wallet withdrawal fee (₦50–₦100) and wallet-to-wallet transfer (₦0–₦50). Proposals, not approved.
- [x] Earnings ledger, holds, recovery and two-admin withdrawals for organizers, providers and representative rewards (0202, 0203, 0205–0207). Built and tested; not applied.
- [x] Server-side idempotency for purchases, settlement, reward credits and payouts. Proven by the local suites.

### 8. Additional paid event services (proposed, not built)
- [ ] Poster design, custom ticket branding, promotion consultation, photography bookings (5% platform fee proposed), corporate services, brand campaigns.

### 9. Future marketplace expansion (proposed, not built)
- [ ] Transportation, studio, equipment and venue bookings; premium analytics; further categories.

### 10. VENTS Work: representative reward (fixed ₦50,000, no commission)
- [x] Fixed ₦50,000 per qualifying organizer, once per organizer (0201; the `base_reward_kobo` CHECK).
- [x] Attribution:
  - one representative per organizer, by an accepted invitation or the referral link used at registration (0201, 0209);
  - self-referral, representative-to-representative and duplicate attempts refused and audited.
- [x] Referral from both sides (0209, 0210 and the app):
  - **Representative:** link, code and share; their own name and @username; referred organizers with @username and status; the reward steps.
  - **Organizer:** "who invited me" before sign-up, and "Your VENTS Representative" afterwards.
- [x] Qualification:
  - verified organizer, a paid event that took place (not cancelled, past, settled);
  - organizer confirmation, then two-admin approval recording that the event took place;
  - free events never qualify.
- [x] Funding from recognised VENTS ticket profit, with reservation so concurrent claims cannot overspend. Credited to the withdrawable earnings wallet; two-admin withdrawals.
- [x] Monthly counts by calendar month (Lagos time). At 9+ qualifying organizers, management *may* approve a higher next-month rate through dual control; nothing increases automatically.
- [x] Transport and support expenses tracked separately with dual-control approval; never mixed into rewards.
- [x] The retired 10% programme:
  - nothing was ever accrued or paid;
  - rewards stay blocked until management records the reconciliation;
  - 0210 makes new commission splits impossible and keeps the old values as history.
- [ ] **Owner decision:** record the reconciliation, including what to tell the two representatives who accepted under the old programme.
- [ ] **Release:** apply 0201–0210 and promote the build (owner authorisation).

### 11. Admin and financial controls
- [~] Central fee configuration. Ticket fees live only in the database (0208), and the app has no fee rates (a test enforces this). Other streams still hard-code their prices.
- [~] Admin enable/disable of products. Kill switches exist for purchases, payouts, sign-ups and more.
- [x] Ledger recording gross, attendee fee, organizer deduction, net and fee model per ticket sale (0203/0208).
- [ ] Revenue reporting by stream (ticketing, promotions, marketplace, subscriptions).
- [~] Representative reward and expense administration (VENTS Earn admin). Reports are basic.
- [x] Fee breakdown shown to the user before payment (tickets).
- [ ] Terms, cancellation and refund disclosures; legal review.

### 12. Testing, release and deployment
- [x] Local suites: all 24 database suites, plus vitest 343 files / 3,162 tests on the business-model change.
- [ ] Owner-authorised release window. Its own runbook step requires a verified backup (now automated by the daily backup workflow; first real run pending).
- [ ] Production verification after release with authoritative evidence. A code change is not production activation.

## Corrections made on 2026-11-09

- **Ticket fees:** the "agreed 4% attendee fee + 5% organizer commission" was replaced by **1.5% attendee service fee + 3.5% organizer platform deduction**.
- **Representative conditions:**
  - "Genuine free events may qualify after review" → **free events never qualify**;
  - "organizer and event-admin approval" → **organizer confirmation plus two VENTS admins confirming the event took place**;
  - "paid through the VENTS Wallet" → **the withdrawable earnings wallet**.
- **The invite no longer sends a 10000-basis-point split.** PR #81's change would have sent one; with 0210 applied that call would be refused. `main` sends none.
- **"Commission" wording:** in proposals for marketplace fees, it is renamed "platform fee", so it is never confused with a referral commission.
