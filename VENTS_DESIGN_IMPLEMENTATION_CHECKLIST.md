# VENTS Design Implementation — Master Checklist

**Source of truth:** `/tmp/vents_design/stripped.html` (Claude Design export, ~67 marked screens A1-TB2) plus two follow-up design docs the user supplied directly in-conversation: `VENTS Ticket Security and Media Upload.dc.html` (ticket/QR states, check-in scanner states, event image upload/cropper, 6-step Create/Edit Event workflow) and `VENTS Redesign.dc.html`/`Canvas.dc.html` (logo assets, general design-system audit). Those two files are not in the repo — re-obtain from the user if a future session needs to re-read them directly rather than relying on this summary.

**Rule for every future session:** EXPORTED DESIGN → REAL REACT SCREEN → RENDER (via `qa-harness/`, the only way to render real components without live Supabase credentials in this sandbox) → DIRECT VISUAL COMPARISON → FIX → RENDER AGAIN → VERIFY. Never mark something MATCH because a component/function exists or the anatomy is merely similar — only because a rendered screenshot was actually compared against the export's actual markup/copy/layout. Never fabricate data or UI not backed by real Supabase schema/RLS. Preserve all backend/payment/wallet/booking/auth/security/RLS logic — UI-only changes unless a screen genuinely requires wiring existing functionality differently.

## Verified DONE this session (real screenshot comparison, not source-reading)

- A2 CountrySelectScreen, B1 HomeScreen (hero card + carousels — was hidden by thin harness fixture data, not missing UI), C1 EventDetailScreen (fixed: tab-strip/description order was wrong — now matches export), C3 Checkout, D1 MyTickets, D2 QRTicket (light backing), C6 PaymentSuccess (icon/QR styling), CS1/CS2 Creator Studio (fixed: revenue "Free"-for-zero bug), F1 Wallet (fixed: missing logo watermark), PD1-3 SettingsScreen incl. new PD2 Connected Accounts (real migration-backed), SV1 ServicesHomeScreen, CH3 Notifications, PMG1 ServiceProviderSetupScreen, PV3 ServiceProviderVerificationScreen, B3 FilterSheet (chip styling literally matches export's exact hex values), S2 PaymentFailedScreen, S5 expired payment request, S6 TicketRefundScreen, SA1/SA2 SalesAnalytics, PK1-3 pickers (bottom-sheet PickerSheet, inline PhoneInput/state dropdown).
- Real bug fixed independent of the mockup: `EventMap.tsx` was auto-opening an unstyled white Google InfoWindow popup on load, clashing with the dark theme — now only opens on marker tap.
- QA harness extended to ~35 routes and several real fixture/shim bugs fixed along the way (documented in commit history, not restated here since the user does not want harness-repair framed as redesign progress).

## NOT yet verified/implemented at real rendered-pixel rigor — this is the actual remaining scope, in the user's specified batch order

### Batch 1 — AUTH + ONBOARDING
- A3 SignUpScreen: real screen has 3 extra real fields vs. the export (photo upload, username, date of birth) — legitimate real requirements (username is used app-wide, DOB backs existing 18+ gating), not fabricated, but never pixel-compared beyond field-list read. Password strength indicator below the fold, unconfirmed.
- A4/A5 VerifyScreen (signup OTP) and the separate forgot-password OTP branch in `AuthScreen.tsx` — both were substantially rebuilt earlier in this overall project (confirmed by the user on their own phone at the time) but NOT re-verified against the export in this session's rigorous screenshot-comparison pass.
- Login screen — screenshotted once (`auth-login` harness route) but never actually reviewed against export copy/layout.
- LG1 login destination, A1 Landing — read/confirmed earlier in the broader project, not re-verified this pass.

### Batch 2 — SERVICES + BOOKING
- SV2 ServiceCategoryScreen — confirmed renders (screenshot taken), never compared to export markup in detail.
- SV3 ServiceProviderProfileScreen — real code has hero image + Services list + Book&Pay CTA (richer than export), but organizes content as one continuous scroll instead of the export's Services/About/Reviews tab strip. Real structural deviation, not yet fixed.
- SV4 BookingSheet — never independently rendered/verified this session (booking flow lives inline in SV3, not a separate sheet route in the harness).
- SV5 ServiceBookingsScreen, PB1/PB2 provider bookings — screenshotted earlier in the broader project, not re-verified this pass.
- PMG1/PV1-3 provider setup/management/verification — confirmed via screenshot this session but not deep-compared line-by-line to export copy.

### Batch 3 — CHAT + SEARCH
- CH1 ExploreScreen (Chats tab), CH2 Message Requests overlay, PS1 People/Messages search split — CH1 confirmed rendering; CH2 and PS1 never independently screenshotted/compared this session (PS1's underlying logic was read and looks correct — search-active state shows a labeled PEOPLE section above MESSAGES — but never seen rendered with an actual active search query).
- `InboxScreen.tsx` — a second, differently-styled Messages/Requests chat UI exists in the codebase and is completely unreachable from any button in the real app (dead code). Needs a decision: delete it, or determine if it was meant to replace the reachable ExploreScreen chat view.
- B2/B4 Search screens — built substantially earlier in this project (result-count header, filter chip, availability badges for B4; Recent/Browse-categories empty state for B2) and confirmed via harness screenshot in an earlier part of this session, but not re-verified in this final rigorous pass.

### Batch 4 — TICKET + SCANNER
- D2 QRTicket — light backing fixed and verified; other states (transfer flow's own screen if distinct from the modal, receipt) not independently re-verified this pass.
- Ticket Scanner (`CheckinScannerScreen.tsx`) — confirmed the code implements every named denial state from the design doc (EXPIRED, WRONG EVENT, REFUNDED, CANCELLED, INVALID, already-scanned, offline/timeout) via reading `scanner/ticketValidation.ts`, and confirmed the camera-unavailable fallback renders correctly. **Never visually verified the actual scanning/verdict-color full-screen states** (valid=green/invalid=red/etc.) since this sandbox has no camera to trigger them — needs either a mocked camera stream in the harness or live-device testing.
- Ticket transfer — confirmed functional (real modal, real RPC), never pixel-compared to any export screen (none exists for it beyond an IA label, confirmed earlier).

### Batch 5 — DESKTOP + TABLET
- Only spot-checked: `settings` and `organizer-dashboard` at 1440×900 (both looked correct, grid layouts triggered properly). ManageEventsScreen desktop (DT1) was reviewed earlier and deliberately left as a card grid instead of a literal data table, per explicit user sign-off. Nothing else has been rendered at 834×1112 (tablet) or 1440×900 (desktop) this session. EventDetailsScreen documents a "media-left/sticky-purchase-panel-right" desktop split in comments — never rendered/confirmed.

## Known code-level issues to fix regardless of which batch picks them up
- `CreateEventScreen.tsx` has 4 steps; the newer design doc specifies 6 (details → cover image → schedule/location → tickets → settings → preview/publish). This is a real, large restructuring of a ~2000-line revenue-critical file — do not rush it; read the whole file first.
- `InboxScreen.tsx` dead-code question (see Batch 3 above).

## Environment constraint (applies to every future session)
This sandbox has no live Supabase credentials — the real `App.tsx` cannot boot end-to-end (`supabaseUrl is required` at import time). All rendering must go through `qa-harness/` (`npx vite --config qa-harness/vite.harness.config.ts --port 5199`, then `node qa-harness/screenshot.mjs <screen-key> <width> <height> <out.png>`), which mounts the real, unmodified screen components with a fixture Supabase shim (`qa-harness/fakeSupabase.ts`). Screens/states needing a real network call the shim doesn't cover will need either a new fixture row or an honest note that they're unverifiable here.
