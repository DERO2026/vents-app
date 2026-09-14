# VENTS Redesign — Implementation Checkpoint

Tracks implementing the approved design artifact (`VENTS Redesign.dc.html`,
32 mobile screens + 3 desktop layouts + 2 tablet examples, all repo-grounded
per `VENTS_REDESIGN_CHECKPOINT.md`) into the real `DERO2026/vents-app` code.
This is a SEPARATE, later-stage checkpoint from that design-side one — that
file tracks what was *designed*; this one tracks what has actually been
*built* into working, typechecked, tested React/TypeScript.

## Status: FOUNDATION + 3 UNITS MIGRATED (3 of ~35 units)

Do not read this as "redesign implemented." It is not. The tokens
foundation plus one shared component and one screen are done and verified;
everything else in the priority list below is not started.

## Done this pass

- [x] **Audited the artifact** (`VENTS Redesign.dc.html` §02) and extracted
  the canonical design-system values (colors, type scale, spacing, radii,
  status-badge colors) into `src/lib/ventsDesignTokens.ts` — new file,
  typechecks clean, not yet imported anywhere.
- [x] **Confirmed the token-drift problem is real, not theoretical**: grepped
  the live codebase and found `#020005` hardcoded inline 81 times across
  `src/app/components/*.tsx`, plus at least two other divergent palettes
  (`servicesDesignTokens.ts`'s own `#020005`/`#A855F7` set, and a third
  variant in Wallet-related screens). This is exactly finding A11 from the
  design audit ("terminology drifts across surfaces") — verified against
  real code, not assumed.
- [x] **`src/app/components/shared/Button.tsx`** (PrimaryButton/SecondaryButton)
  migrated to `ventsColors`/`ventsTypography` — solid accent fill + glow per
  §02's button spec, glass secondary. 4 consumers checked
  (`ConfirmDialog.tsx`, `EventDetailsScreen.tsx`, `EventMap.tsx`,
  `ReportModal.tsx`) — none touch financial logic. Typecheck clean, full
  suite 429/429 passing (same pre-existing unrelated `ticketToken.test.ts`
  env failure as before, untouched by this change).
- [x] **`src/app/components/WelcomeScreen.tsx`** (Landing, priority #2)
  migrated: background, ambient glow, ink colors, both CTA buttons now use
  the token module. `VentsLogo.tsx` deliberately left untouched — it is
  already a faithful CSS reconstruction of the real mark (custom purple-bar
  "E", white V/N/T/S), not a placeholder; swapping it for the supplied
  raster PNG would be a quality regression (blurry at small sizes, extra
  network request) for zero benefit, so this was a considered decision, not
  a skipped step. Typecheck clean, no test references this screen directly,
  full suite still 429/429.
- [x] **`src/app/components/CountrySelectScreen.tsx`** (A2, onboarding step)
  migrated against the artifact's actual A2 mockup (line ~444 of the .dc.html),
  not just colors: 44×44 glass back button (up from 36×36 solid), 30px/800
  title (up from 26px), elevated (`#1A1724`) 50px-tall search bar (up from a
  flat `#131629` bar), 64px/16px-radius list rows with the accent-tinted
  selected state and a checkmark shown only when selected (matches the
  mockup exactly — unselected rows have no radio circle at all, a real
  layout simplification, not just a recolor), solid-accent CTA button.
  Two things deliberately NOT copied from the mockup: (1) a "Step 1 of 3"
  label — no verified source for the exact step count in this flow, adding
  it would be fabricating flow state; (2) the mockup's subtitle copy
  ("sets your currency and what shows up first on Home") — this screen's
  own code comment says explicitly it does neither (no currency/event
  filtering exists anywhere in the RLS layer), so the mockup's copy is
  inaccurate and the original, correct copy was kept. `CountryMark`
  (flag icon) also kept — real functional value the mockup's low-fidelity
  rows simply didn't render, not something to remove. Typecheck clean, no
  direct test coverage (pure presentational), full suite 429/429.

## Explicitly NOT done (the actual redesign work)

Every item below is genuine, real, and remains — nothing here should be
implied "basically done":

- **1 of ~32 mobile screens migrated (WelcomeScreen/Landing).** Signup,
  Login, Verification, Home, Search, Filters, Event Details, Checkout,
  Payment, Someone Else Pays, My Tickets, QR, Wallet (x3), Services (all
  5), Chats/Notifications, Profile, and all 6 business/creator screens
  (Creator Studio, Provider services mgmt, Event mgmt, KYC, Create/Edit
  Event, Sales Analytics, Promotions, Provider Bookings) are all still on
  their current, pre-redesign styling.
- **Zero desktop layouts implemented** (Creator Studio sidebar+grid,
  ManageEventsScreen table, SalesAnalyticsScreen stat-grid — all designed,
  none built).
- **Zero tablet-breakpoint work implemented.**
- **Zero UI states (loading/empty/error/success/disabled/refund) migrated.**
- **The logo assets have not been wired in anywhere** — `assets/vents-logo*.png`
  exist in the supplied upload but no component references them yet.
- **No regression testing of any screen's redesign** — because no screen has
  been redesigned yet, there is nothing to regress-test.

## Why not attempted in one pass

The codebase has ~150 files using hardcoded inline `style={{ background:
'#020005', ... }}` throughout, with zero visual-regression test coverage.
A find-and-replace across that surface risks silently breaking real,
financially-sensitive screens (checkout, wallet, refunds) in ways the
existing unit/security test suite would not catch — those tests verify
business logic, not pixel output. Screen-by-screen migration, each one
manually verified against its real functional test coverage plus a visual
check, is the only responsible way to do this at this codebase's current
maturity — not a batch replace.

## Priority order (per user's numbered list) — progress

1. Shared design-system primitives/tokens — **tokens file done; Button.tsx
   done; still pending: chips, status badges (`ventsStatusColors` exists in
   the tokens file but is not wired into any component yet), PickerSheet,
   card primitive.**
2. Landing / onboarding / auth — **WelcomeScreen done. NEXT UP:
   `AuthScreen.tsx` (2426 lines — large, read it fully before editing;
   covers Signup/Login/Verification in one file) and
   `CountrySelectScreen.tsx` (221 lines, smaller, could go first as a
   warm-up).**
3. Home / Search / Filters — not started (`HomeScreen.tsx`, `ExploreScreen.tsx`)
4. Event Details — not started
5. Ticket selection / Checkout / Payment / Success / Failure — not started
   (financial — extra care, re-run `walletPayments.security.test.ts` etc.
   after any touch)
6. Someone Else Pays — not started
7. My Tickets / Ticket Detail / QR / Transfers — not started
8. Wallet / Deposit / Transaction Detail — not started (financial)
9. Services discovery / Provider Profile / Service Detail — not started
10. Service Booking / Checkout / Payment / Confirmation — not started (financial)
11. Booking History / Cancellation / Refund — not started (financial —
    this is `ServiceBookingsScreen.tsx`, touched functionally this session
    for the 0077 refund UI; redesign pass must not disturb that logic)
12. Chats / Requests / People Search — not started
13. Notifications — not started
14. Profile — not started
15. Organizer Dashboard suite — not started
16. Service Provider Dashboard suite — not started
17. Creator Studio — not started
18. Desktop layouts — not started
19. Tablet layouts — not started
20. Global UI states — not started
21. Final responsive/visual consistency pass — not started

Rule holding throughout: financial/security-critical screens (5, 6, 8, 10,
11) get their existing test file re-run immediately after any touch, never
batched with low-risk screens.

## Repo state

- Branch: `main` (already promoted this session; migration `0077` and all
  prior application code live in Production — unrelated to this redesign
  effort, do not conflate the two).
- New file this pass: `src/lib/ventsDesignTokens.ts` (uncommitted).
- No other files changed.
