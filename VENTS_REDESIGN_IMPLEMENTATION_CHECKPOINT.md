# VENTS Redesign — Implementation Checkpoint

Tracks implementing the approved design artifact (`VENTS Redesign.dc.html`,
32 mobile screens + 3 desktop layouts + 2 tablet examples, all repo-grounded
per `VENTS_REDESIGN_CHECKPOINT.md`) into the real `DERO2026/vents-app` code.
This is a SEPARATE, later-stage checkpoint from that design-side one — that
file tracks what was *designed*; this one tracks what has actually been
*built* into working, typechecked, tested React/TypeScript.

## Status: FOUNDATION LAID, SCREEN MIGRATION NOT STARTED

Do not read this as "redesign implemented." It is not. One real,
verified piece of groundwork is done; the ~32-screen migration is not.

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

## Explicitly NOT done (the actual redesign work)

Every item below is genuine, real, and remains — nothing here should be
implied "basically done":

- **Zero of the ~32 mobile screens have been migrated to the new design.**
  Landing, Signup, Login, Verification, Home, Search, Filters, Event
  Details, Checkout, Payment, Someone Else Pays, My Tickets, QR, Wallet
  (x3), Services (all 5), Chats/Notifications, Profile, and all 6
  business/creator screens (Creator Studio, Provider services mgmt, Event
  mgmt, KYC, Create/Edit Event, Sales Analytics, Promotions, Provider
  Bookings) are all still on their current, pre-redesign styling.
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

## Recommended next-session order (not yet started)

1. Migrate the shared/reused primitives first (buttons, chips, status
   badges, PickerSheet, cards) to `ventsDesignTokens` — one shared change
   that every screen downstream benefits from, same principle as this
   session's tokens-file step.
2. Non-financial, low-risk screens next (Landing, Signup/Login static
   chrome, Notifications, Chats list) to prove the pattern holds visually
   before touching anything money-related.
3. Financial/high-stakes screens last, each with its existing test suite
   re-run immediately after (Checkout, Wallet, Services booking/refund,
   ticket purchase) — never batch these with the low-risk screens.
4. Desktop/tablet layouts only after their mobile counterparts are done
   and verified, per screen.

## Repo state

- Branch: `main` (already promoted this session; migration `0077` and all
  prior application code live in Production — unrelated to this redesign
  effort, do not conflate the two).
- New file this pass: `src/lib/ventsDesignTokens.ts` (uncommitted).
- No other files changed.
