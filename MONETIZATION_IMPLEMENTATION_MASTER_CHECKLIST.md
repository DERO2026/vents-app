# VENTS Monetization Implementation Master Checklist

This is the canonical implementation tracker for the original 12-part VENTS monetization checklist supplied in the VENTS Revenue Streams conversation on 2026-10-30. Each numbered item below is accounted for; `[ ]` means implementation or verification remains open, and `[~]` means the repository contains partial groundwork that does not yet satisfy the full requirement.

## Confirmed product directions

- Revenue streams: ticketing fees; event promotions and advertising; service marketplace fees; organizer subscriptions; service-provider subscriptions; vendor marketplace; VENTS Wallet and payouts; additional paid event services; future marketplace expansion; VENTS Work representative compensation; admin and financial controls; testing, release and deployment.
- Representative compensation was changed from a percentage commission to **₦50,000 per qualifying organizer onboarded**. The user has now specified that the organizer must host an event that is not cancelled, and both organizer and event admin approval are required before payment. Genuine free events may qualify after verification.
- Cross-cutting requirement: make the revenue streams valuable to users and close obvious fraud, self-referral, collusion, retry, and reversal paths with server-side controls.

## Original checklist: all revenue streams

### 1. Ticketing fees

- [~] Attendee service fee — 4% per ticket — existing agreed model; audit current calculation, rounding, disclosure, and production behavior.
- [~] Organizer commission — 5% per ticket — existing agreed model; audit calculation and net settlement.
- [~] Combined gross ticket fee revenue — 9% (4% attendee + 5% organizer); verify both sides are represented correctly and are not double counted.
- [~] Ticket transfer fee — 7.5%, ₦500 minimum, ₦5,000 maximum; audit current transfer implementation and edge cases.
- [ ] Refund administration fee — ₦500–₦1,000 proposed; settle policy and legal review before implementation.
- [ ] Expedited organizer payout — ₦500–₦1,500 proposed optional service; verify cost and disclose before charging.

### 2. Event promotions and advertising

- [~] Trending: 3 days ₦75,000; 7 days ₦150,000; 14 days ₦275,000; 30 days ₦500,000 — previously agreed; audit existing promotion activation, billing, duration, expiry, and rendering.
- [~] Featured: 3 days ₦150,000; 7 days ₦250,000 — previously agreed; audit existing feature path and billing.
- [ ] Sponsored event campaigns — negotiated pricing, campaign workflow and fulfillment.
- [ ] Sponsored discovery/category placements — ₦25,000–₦75,000 proposed; define inventory, measurement, and billing.
- [ ] Brand sponsorships and advertising partnerships — negotiated contracts and operational tracking.

### 3. Service marketplace fees

- [ ] Customer booking fee — 2% proposed.
- [ ] Service-provider commission — 5% proposed.
- [ ] Cancellation/no-show penalties — ₦2,000–₦5,000 proposed; define clear policy and dispute handling first.
- [ ] Photography and other completed service commissions — 5% proposed.
- [ ] Paid service-provider promotion — ₦10,000–₦25,000/month proposed.

### 4. Organizer subscriptions

- [ ] Starter Organizer — Free; basic event creation and ticket management.
- [ ] Pro Organizer — ₦10,000/month; advanced analytics, reports and team tools.
- [ ] Business Organizer — ₦25,000/month; advanced operations and multiple-event tools.
- [ ] Subscription billing, renewal, cancellation, expiry, and plan access controls.

### 5. Service-provider subscriptions

- [ ] Basic provider — Free; standard profile and discovery.
- [ ] Professional provider — ₦5,000/month; enhanced portfolio and analytics.
- [ ] Premium provider — ₦15,000/month; extra visibility and advanced insights.
- [ ] Subscription management, billing, renewal, cancellation, expiry, and access controls.

### 6. Vendor marketplace

- [ ] Basic vendor listing — Free; standard listing.
- [ ] Premium vendor listing — ₦5,000/month proposed.
- [ ] Featured vendor placement — ₦10,000–₦25,000/month proposed.
- [ ] Sponsored category placement — ₦25,000–₦75,000/month proposed.
- [ ] Commission on eligible vendor sales — 5% proposed.
- [ ] Vendor payments, orders, refunds, and commission records.

### 7. VENTS Wallet and payouts

- [~] Wallet deposits — ₦0 VENTS fee initially; account for payment-processing cost.
- [ ] Wallet withdrawal fee — ₦50–₦100 proposed; verify actual payout costs.
- [ ] Wallet-to-wallet transfer — ₦0–₦50 proposed.
- [~] Wallet ledger and transaction history — audit existing wallet records for complete, immutable accounting.
- [~] Payout reconciliation, failed transfers, refunds, and reversal handling — audit existing payout lifecycle.
- [~] Prevent double charging and duplicate transactions — security requirement; verify all monetization flows use server-side idempotency.

### 8. Additional paid event services

- [ ] Event poster design — ₦5,000–₦20,000 per design proposed.
- [ ] Custom ticket branding — ₦5,000–₦15,000 per event proposed.
- [ ] Event promotion consultation — ₦10,000–₦50,000 proposed.
- [ ] Photography bookings — 5% commission proposed.
- [ ] Corporate event services and partnerships — negotiated pricing.
- [ ] Brand-sponsored campaigns — negotiated pricing.

### 9. Future marketplace expansion

- [ ] Transportation bookings — commission per completed booking.
- [ ] Studio rentals — booking commission.
- [ ] Equipment rentals — booking commission.
- [ ] Venue bookings — commission per reservation.
- [ ] Premium organizer analytics and business tools.
- [ ] Additional marketplace categories and commissions.

### 10. VENTS Work — Representative compensation

- [ ] ₦50,000 per qualifying organizer onboarded; replaces old 10% commission model.
- [ ] Representative referral attribution: record recruiter against each organizer.
- [ ] Qualifying event verification: event must be hosted and not cancelled.
- [ ] Organizer and event admin approval required before payment.
- [ ] Genuine free events may qualify, subject to verification rules.
- [ ] Fraud and duplicate prevention: no duplicate or fraudulent payouts.
- [ ] Approved rewards become withdrawable through VENTS Wallet after approval.
- [ ] Monthly performance tracking by qualifying organizers per calendar month.
- [ ] At 9+ qualifying organizers in a month, management may approve a higher rate for the following month; define the approval workflow and effective rate before enabling.
- [ ] Approved transport/support expenses tracked separately and require approval.
- [ ] Reconcile existing 10% commitments and balances before activating the new payout model.

### 11. Admin and financial controls

- [ ] Central fee and pricing configuration; eliminate conflicting hardcoded rates.
- [ ] Authorized admin controls to enable/disable fee products.
- [~] Transaction ledger and audit trail recording gross amount, fee, net amount, and status across each revenue stream.
- [ ] Revenue reporting by stream: ticketing, promotions, marketplace, subscriptions, and more.
- [ ] Representative earnings and payout reports, including approvals and expenses.
- [~] Refunds, reversals, and failed-payment handling with accurate balances.
- [~] Role-based permissions and database security for financial records.
- [ ] User-facing fee breakdowns before payment.
- [ ] Terms, cancellation, and refund disclosures; review applicable legal requirements.

### 12. Testing, release, and deployment

- [ ] Audit current production code and deployed schema before changes; identify existing fee logic and state.
- [ ] Test every percentage/fixed fee, including minimums, maximums, and rounding.
- [ ] Test payment verification and idempotency; prove no duplicate charges or payouts.
- [ ] Test subscriptions, expiry, renewals, and access control.
- [ ] Test refunds, cancellations, and failed payouts; verify ledger accuracy.
- [ ] Run relevant regression and security tests; preserve existing app features.
- [ ] Commit and push implementation changes with reviewable Git history.
- [ ] Merge/deploy as appropriate; do not treat a code change as production activation.
- [ ] Verify production behavior after release using authoritative runtime/database evidence.

## Existing VENTS Earn code / VENTS Work checklist scope

### Shipped foundation

- [x] Recruiter registration and profile foundation (`0193`, merged in code)
- [x] Organizer/provider partnership invitations and accept/decline/withdraw/revoke flows (`0193`, merged in code)
- [x] Authorization, row-level access, rate limits, and admin suspension controls (`0193`, `0196`, merged in code)
- [x] Representatives screen and invitation notifications (merged in code)
- [x] Platform-fee accounting and qualification-state groundwork (`0192`, merged in code)
- [ ] Verify which VENTS Earn foundation migrations have been applied in production.

### Remaining implementation

- [~] Replace the old percentage/`commission_split_bps` compensation model with the agreed fixed ₦50,000 organizer-onboarding reward. The Representative screen now shows the fixed reward and no longer promises revenue commission; the database/API legacy split field and invite notification wording still need removal.
- [~] Qualification rule is now specified: hosted, not-cancelled event plus organizer and event-admin approval; genuine free events may qualify after verification. Implement authoritative event verification, approval audit, fraud-resistant holds, and reversal policy.
- [ ] Add an immutable earnings ledger with idempotency, source attribution, reversals, and reconciliation.
- [ ] Implement admin review and payout authorization using the existing maker-checker pattern where required.
- [ ] Decide whether recruiter rewards use a recruiter-specific ledger/wallet or extend organizer payout infrastructure; existing `request_organizer_payout` is organizer-scoped.
- [ ] Implement payout destination, payout status, failure/retry, and audit history, with idempotency and the existing payout kill switch respected.
- [~] Update recruiter/representative earnings UI to reflect the agreed fixed reward. The screen now states that eligibility/payout rules remain under verification and does not show balances; earned, pending, reversed, and paid amounts require the ledger and payout lifecycle first.
- [ ] Verify the complete earning and payout lifecycle before production release.

## Checklist reconciliation

- [x] The complete 12-section master checklist supplied by the user is represented above, including every amount, proposal qualifier, security requirement, and release gate.
- [ ] Audit each item against the current source, migration history, and production state; identify existing, partial, missing, and unsafe implementations with evidence.

## Audit notes

- Migration `0193_vents_earn_foundation.sql` explicitly scopes itself to partnerships and invitations; it does not calculate or pay commission.
- Migration `0192_platform_fee_accounting_foundation.sql` adds accounting and qualification groundwork, not recruiter payout logic.
- `RepresentativesScreen.tsx` still contains 10% commission copy and sends `10000` basis points. This conflicts with the later fixed ₦50,000 direction and must be reconciled before rollout.
- The repository also contains a VENTS Design Implementation checklist, which is separate from this monetization checklist.
- Existing bank-account and withdrawal flows are scoped to organizer wallets; recruiter earnings need an explicit role and ledger design before using them.
