# VENTS Monetization Implementation Master Checklist

This checklist tracks the monetization scope from the VENTS Revenue Streams conversation against the current application code. It is the working implementation tracker; each original checklist item still needs to be matched here before the roadmap can be called complete.

## Confirmed product directions

- VENTS Earn (representatives/recruiters and partner earnings)
- VENTS Unlock
- VENTS Split
- VENTS Circle
- Representative compensation was changed from a percentage commission to **₦50,000 per organizer onboarded**. The exact qualification event for earning/releasing this amount still needs to be confirmed before payout logic is implemented.
- Cross-cutting requirement: make the revenue streams valuable to users and close obvious fraud, self-referral, collusion, retry, and reversal paths with server-side controls.

## VENTS Earn

### Shipped foundation

- [x] Recruiter registration and profile foundation (`0193`, merged in code)
- [x] Organizer/provider partnership invitations and accept/decline/withdraw/revoke flows (`0193`, merged in code)
- [x] Authorization, row-level access, rate limits, and admin suspension controls (`0193`, `0196`, merged in code)
- [x] Representatives screen and invitation notifications (merged in code)
- [x] Platform-fee accounting and qualification-state groundwork (`0192`, merged in code)
- [ ] Verify which VENTS Earn foundation migrations have been applied in production.

### Remaining implementation

- [ ] Replace the old percentage/`commission_split_bps` compensation model with the agreed fixed ₦50,000 organizer-onboarding reward.
- [ ] Confirm what qualifies an organizer as “onboarded” and when the reward becomes payable; include a fraud-resistant hold/reversal policy.
- [ ] Add an immutable earnings ledger with idempotency, source attribution, reversals, and reconciliation.
- [ ] Implement admin review and payout authorization using the existing maker-checker pattern where required.
- [ ] Decide whether recruiter rewards use a recruiter-specific ledger/wallet or extend organizer payout infrastructure; existing `request_organizer_payout` is organizer-scoped.
- [ ] Implement payout destination, payout status, failure/retry, and audit history, with idempotency and the existing payout kill switch respected.
- [ ] Update recruiter/representative earnings UI to show earned, pending, reversed, and paid amounts accurately.
- [ ] Verify the complete earning and payout lifecycle before production release.

## VENTS Unlock

- [ ] Recover the agreed product rules and user benefits from the original checklist.
- [ ] Audit existing code and schema against those rules.
- [ ] Implement the agreed user experience, accounting, authorization, fraud controls, and admin operations.

## VENTS Split

- [ ] Recover the agreed split participants, calculation rules, and settlement behavior from the original checklist.
- [ ] Audit existing code and schema against those rules.
- [ ] Implement the agreed user experience, accounting, authorization, fraud controls, and admin operations.

## VENTS Circle

- [ ] Recover the agreed Circle product rules and revenue model from the original checklist.
- [ ] Audit existing code and schema against those rules.
- [ ] Implement the agreed user experience, accounting, authorization, fraud controls, and admin operations.

## Additional monetization ideas

- [ ] Match every original item from the VENTS Revenue Streams chat to this tracker; do not infer omitted products or mark the roadmap complete until all original items are accounted for.

## Audit notes

- Migration `0193_vents_earn_foundation.sql` explicitly scopes itself to partnerships and invitations; it does not calculate or pay commission.
- Migration `0192_platform_fee_accounting_foundation.sql` adds accounting and qualification groundwork, not recruiter payout logic.
- `RepresentativesScreen.tsx` still contains 10% commission copy and sends `10000` basis points. This conflicts with the later fixed ₦50,000 direction and must be reconciled before rollout.
- The repository also contains a VENTS Design Implementation checklist, which is separate from this monetization checklist.
- Existing bank-account and withdrawal flows are scoped to organizer wallets; recruiter earnings need an explicit role and ledger design before using them.
