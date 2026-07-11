# VENTS — Global Architecture & Security Audit

**Date:** 2026-07-11
**Type:** Read-only audit — no code was modified, no PRs opened, no hotfixes applied.
**Method:** Three parallel read-only research passes (auth/endpoint security, React re-renders/memory leaks, UI/brand consistency) plus direct inspection of live database schema, indexes, RLS policies, and function bodies via `npx @insforge/cli db query`. The two most severe security findings below were independently re-verified against the live DB function definitions and calling code before being included.

Severity scale: **Critical** (active exploit, real money/data at risk) → **High** (clear exploit path or user-visible failure) → **Medium** (real but bounded impact, or scaling risk) → **Low** (hygiene/polish).

---

## 1. Critical Security

### [Critical] `purchase_ticket` RPC trusts the client for payment status — fabricates real, withdrawable money
- **Where:** `public.purchase_ticket(p_event_id, p_ticket_type, p_quantity, p_payment_ref, p_payment_status default 'paid')` (SECURITY DEFINER), called from [App.tsx:1088-1094](src/app/App.tsx:1088)
- **Confirmed directly** against the live function body: it accepts `p_payment_status` from the caller (client default is `'paid'`, sent unconditionally by `handleCheckoutSuccess`), inserts an `active` ticket, and — if `p_payment_status = 'paid'` — immediately calls `credit_organizer_wallet()` with the full ticket price in kobo.
- **Exploit:** any authenticated user can call this RPC directly (own valid JWT, no admin needed) with a fabricated `p_payment_ref`, skipping Paystack entirely. This doesn't just grant a free ticket — it injects real, payout-eligible Naira into the organizer's wallet for a sale that never happened.
- **Context:** a correct, amount-verified alternative already exists — `confirm_ticket_payment`, driven by the Paystack-HMAC-verified webhook in `api/webhook/paystack.ts` (added in `migrations/20260703072058_confirm-ticket-payment-rpc.sql`), which checks the paid amount before flipping status. `purchase_ticket` appears to predate that fix and was never retired.
- **Direction (not applied):** `purchase_ticket` should always insert `payment_status = 'pending'` for priced tickets regardless of what the client sends, and rely exclusively on the webhook-driven `confirm_ticket_payment` to mark paid + credit the wallet.

### [Critical] `users` table RLS lets any Sub-Admin (or Admin) suspend/ban/soft-delete Root or another Admin
- **Where:** RLS policy `admin_update_users` on `public.users` — `USING (is_admin())`, `WITH CHECK (is_admin())`, independently confirmed via `pg_policy` this session. `is_admin()` returns true for both `'admin'` and `'sub-admin'`.
- Only the `role` column is protected cross-account (`check_user_role_update` trigger + `admin_set_user_role`'s explicit Root/Sub-Admin guards, added in `migrations/20260711130026_add-subadmin-rbac-and-audit-upgrade.sql`). Nothing protects `status`, `banned_until`, `deleted_at`, or `is_verified`.
- **Frontend proof:** [AdminDashboardScreen.tsx:1070](src/app/components/AdminDashboardScreen.tsx:1070) (unban), `:1084` (ban), `:1105` (soft-delete), `:1122` (reinstate), `:1137` (verify toggle) all issue raw `.from('users').update(...)` calls with no `ROOT_UID` check and no target-role check — only the role dropdown (`handleRoleChange`) has that guard.
- **Exploit:** a Sub-Admin — a tier explicitly designed to be lower-trust than full Admin — can suspend or soft-delete Root or another Admin's account directly via the REST API, contradicting the "Root is immutable" design established earlier this session.
- **Direction (not applied):** add a target-role check (RLS policy or trigger) mirroring `admin_set_user_role`'s logic: block Sub-Admins from writing any column on rows where the target is `admin`/`sub-admin`/Root, and block *everyone* (including full Admin) from touching Root's `status`/`banned_until`/`deleted_at`.

### [High] `verify_entry_pass` accepts an unsigned, bare ticket UUID — the HMAC signature is optional, and the app leaks the plaintext ID anyway
- **Where:** `public.verify_entry_pass` only verifies the HMAC signature when the input contains a `.` (`IF strpos(p_ticket_id, '.') > 0`); a bare UUID is accepted with no signature check at all.
- **Compounding leak:** [QRTicket.tsx:94](src/app/components/QRTicket.tsx:94) (WhatsApp/native share text), the downloaded ticket PNG, and the plaintext ID printed under the QR code all expose the raw ticket UUID — so anyone who sees a forwarded screenshot or share message has a fully valid, unsigned "credential" to walk in with.
- **Direction (not applied):** once a signed token has ever been minted for a ticket, reject bare-UUID scans for it; stop displaying/sharing the raw ticket ID as plaintext.

### [High] `api/extract-events.ts` is an unauthenticated proxy to the paid Anthropic API
- No `Authorization` check at all (unlike every sibling under `api/wallet/`/`api/notify/`). Accepts unbounded `text` from any anonymous caller and forwards it to `api.anthropic.com` using the server's own API key.
- **Exploit:** unauthenticated cost/rate-limit abuse against the project's Anthropic budget.
- **Direction (not applied):** require a valid InsForge bearer token and cap input length.

### [Medium] Wallet endpoints check that an `Authorization` header is *present*, never that it's valid
- **Where:** `api/wallet/resolve-account.ts:13-14` and `api/wallet/save-bank.ts:11-12` — both check `if (!authHeader) return 401` and never validate the token before making real, billable Paystack calls (`bank/resolve`, and for `save-bank.ts`, transfer-recipient creation).
- **Exploit:** a bogus non-empty `Authorization` header is enough to spam Paystack account-resolution lookups and create junk transfer recipients on the live Paystack account, with no real VENTS session.
- **Direction (not applied):** validate the token against InsForge before any Paystack call, as `admin-approve-payout.ts` already does.

### [Medium] Duplicate `admin_credit_vents_cents` overloads — one mints VC with no funding source
- Two live overloads exist: one debits an admin wallet to fund the credit (correct), one mints VC unbacked. [AdminDashboardScreen.tsx:732](src/app/components/AdminDashboardScreen.tsx:732) calls the **unbacked** overload — every admin VC grant today creates currency with no offsetting debit.
- **Direction (not applied):** drop the stale/unbacked overload; keep one canonical, funded signature.

### [Medium] `set_signup_role` / `promote_to_organizer` let any user self-assign the `organizer` role, unvetted, at any time
- Not obviously a bug — CAC/organizer verification is a separate trust badge layered on top — but it means the `organizer` role itself (event creation, payouts, check-in scanning access) carries no vetting at the DB layer. Flagged as Medium given its adjacency to the financial surface above; worth a deliberate product decision rather than an unreviewed default.

### [Low] Live third-party API keys committed to git instead of platform secrets
- `vercel.json` and `.env.production` commit `VITE_PAYSTACK_PUBLIC_KEY` (live), `VITE_POSTHOG_KEY`, `VITE_SENDCHAMP_PUBLIC_KEY` (live), and the InsForge anon key. All are `VITE_`-prefixed (bundle-exposed by design) or intentionally-public keys, so this isn't a secret leak — but it means none of them can be rotated without a code change, and they're visible in git history indefinitely. No genuine secret (Paystack *secret* key, Resend key, Anthropic key) was found committed anywhere.
- **Direction (not applied):** move to Vercel dashboard env vars even for "public" keys, for rotation hygiene.

### [Low] Static, repo-visible HMAC signing key for ticket tokens
- `generate_ticket_token`/`verify_entry_pass` use the literal string `'vents-ticket-hmac-v1'` as the HMAC key. Not exploitable on its own (ticket IDs are unguessable UUIDs), but combined with the bare-UUID bypass above, the signature currently adds no real protection, and a migration-committed key can't be rotated without re-signing every outstanding ticket.

### [Low] "Reject organizer" button is broken (functional bug, not a vulnerability)
- [AdminDashboardScreen.tsx:2111](src/app/components/AdminDashboardScreen.tsx:2111) tries to set `role` via a raw table update, which the `check_user_role_update` trigger correctly rejects — confirming the defense-in-depth works, but the feature itself silently fails (`flash(false, error.message)`). Should route through `admin_set_user_role(p_user_id, 'attendee')` instead.

### Verified NOT vulnerable (checked because they matched the audit's suspicion list)
- `verify_entry_pass`'s `p_organizer_id` param is checked against `auth.uid()` — can't be used to scan on another organizer's behalf.
- `admin_set_user_role` itself is sound (Root hard-blocked, Sub-Admin/admin-tier target blocked, `'sub-admin'` assignment restricted to Root) — the gap is purely the table-level RLS side-door (Critical finding #2 above).
- `admin_debit_vents_cents`, `admin_hide_event`, `admin_reinstate_event`, `cleanup_orphaned_records`, `admin_health_ping` all correctly gate on `is_admin()`.
- Refresh tokens live in `sessionStorage` (not `localStorage`), consistently; no token values are ever logged.
- CORS `*` on `api/wallet/*`/`api/notify/*` is not exploitable for token theft since auth is header-bearer (not cookie-based) and every RPC independently re-validates `is_admin()`.

---

## 2. Performance Downgrades

### [High] Admin Console user search is unbounded *and* undebounced — every keystroke triggers a full unbounded table scan
- **Where:** `loadUsers()` in [AdminDashboardScreen.tsx:804-827](src/app/components/AdminDashboardScreen.tsx:804) has no `.limit()`/`.range()` at all, and its search input ([:1420](src/app/components/AdminDashboardScreen.tsx:1420)) updates `searchQuery` on every `onChange` — which is a dependency of `loadUsers`, re-firing the full leading-and-trailing-wildcard `ILIKE` query (`full_name.ilike.%x%,username.ilike.%x%,email.ilike.%x%`) on every character typed.
- **Compounding DB-level issue (confirmed directly):** those `ILIKE '%...%'` searches — also used in [ExploreScreen.tsx:130](src/app/components/ExploreScreen.tsx:130) and [HomeScreen.tsx:762](src/app/components/HomeScreen.tsx:762) for organizer search — have a leading wildcard, so none of the existing btree indexes on `username`/`email` can help; Postgres must sequentially scan the full `users`/`public_profiles` table for every search, on every keystroke, admin-console-wide.
- **Contrast:** [ExploreScreen.tsx:120-136](src/app/components/ExploreScreen.tsx:120) already debounces its own people-search correctly (300ms `setTimeout` + cleanup) — the pattern exists in the codebase, just wasn't applied to the admin console.
- **Direction (not applied):** debounce the admin search input the same way ExploreScreen does; add `.range()`/`.limit()` pagination (mirroring `admin_logs`'s existing `.limit(100)`); if free-text name/email search needs to stay fast at scale, add the `pg_trgm` extension + a GIN index on `username`/`full_name` rather than relying on btree.

### [High] Blob/ObjectURL leak on Event Details, amplified by a 1-second full-tree re-render
- **Where:** [EventDetailsScreen.tsx:638-673](src/app/components/EventDetailsScreen.tsx:638) builds an ICS calendar Blob + `URL.createObjectURL` inline in JSX on every render, with no `revokeObjectURL` anywhere in the file — and [EventDetailsScreen.tsx:101-139](src/app/components/EventDetailsScreen.tsx:101) (`useCountdown`, used at `:346`) ticks state every 1000ms directly in the top-level (1289-line, non-memoized) component, re-rendering — and re-leaking — the whole tree once a second.
- **User-visible symptom:** unbounded memory growth the longer a user leaves an event-details page open; worst on long-lived, memory-constrained Android WebViews (this app's primary target per the Capacitor wrapper).
- **Direction (not applied):** memoize the ICS blob (`useMemo` keyed on event id/date) and revoke the previous URL via a ref + cleanup effect; isolate the ticking countdown into its own small memoized child so a tick doesn't re-render the whole screen.

### [High] Stale closure silently disables the 18+ content filter for every logged-in user
- **Where:** [App.tsx:745-912](src/app/App.tsx:745) — `fetchEvents` is a `useCallback` with an **empty dependency array** whose body reads `currentUser?.date_of_birth` from closure ([:757](src/app/App.tsx:757)) to compute age for the `is_18_plus` exclusion. Because the callback is created once at first render — before auth hydrates and `currentUser` is still `null` — it permanently closes over `null`, so the age always defaults to 99 and the 18+ filter never actually applies, for the life of the tab.
- **Notable:** the exact same pitfall was already solved for `blockedIds` via a ref (`blockedIdsRef`, [App.tsx:615-620](src/app/App.tsx:615)) but the fix was never mirrored for the date-of-birth read.
- **Direction (not applied):** add a `dobRef`/`currentUserRef` updated via a small effect, and read from the ref inside `fetchEvents` instead of the stale closure — same pattern already proven elsewhere in this file.

### [Medium] Two independent 15s polling loops (plus an existing 8s chat poll) run for the entire session, duplicating existing realtime infrastructure
- **Where:** [App.tsx:244-262](src/app/App.tsx:244) (maintenance-mode/app-config poll) and [App.tsx:264-285](src/app/App.tsx:264) (currentUser role-sync poll, added this session) are both correctly cleaned up (no leak) but run indefinitely regardless of active screen, each on its own 15s DB round-trip — stacking with `ConversationScreen.tsx`'s own 8s fallback poll while a chat is open.
- **Notable:** the codebase already has a working realtime pattern (`insforge.realtime`, used for admin stats and DMs) that these two newer polls don't use.
- **Direction (not applied):** merge the two App.tsx polls into one combined fetch, or replace with a realtime subscription + a much longer safety-net poll (minutes, not seconds).

### [Medium] Unbounded lists with no pagination/virtualization: Admin Deleted-Users tab, Attendee list
- `loadDeletedUsers()` ([AdminDashboardScreen.tsx:830-840](src/app/components/AdminDashboardScreen.tsx:830)) has the same no-`.limit()` gap as `loadUsers`. [AttendeeListScreen.tsx:45-54](src/app/components/AttendeeListScreen.tsx:45) loads every ticket for an event with no `.limit()`/`.range()` and renders with a plain `.map()` — will visibly jank for a large/sold-out event, which is exactly this app's target use case (nightlife/festival entry at volume).
- **Direction (not applied):** paginate both (50-100 rows/page or infinite scroll); consider `react-window` if any list can realistically exceed a few hundred rows (not currently used anywhere in the codebase).

### [Medium] Missing index on a newly-added, sibling-inconsistent foreign key: `tickets.scanner_id`
- Confirmed directly via `pg_indexes`: `tickets.event_id`, `tickets.user_id`, and `tickets.payment_ref` are all indexed, but `scanner_id` (added this session for `verify_entry_pass`) is not — its sibling column `checkins.scanned_by` *is* indexed. Low volume today; worth closing before check-in-by-scanner reporting queries are built on top of it.
- `organizer_transactions.withdrawal_request_id` is similarly a foreign key with no supporting index at all (only `organizer_id` is indexed on that table).

### [Low] Over-fetching on the primary "My Tickets" query
- [App.tsx:653-656](src/app/App.tsx:653) selects `'*, events(*)'` — every column of both `tickets` and its joined `events` row (including the full `ticket_types` jsonb blob and description text) for every ticket a user owns, when the UI only renders a handful of fields. Harmless at current scale; worth trimming to named columns as ticket volume grows.

### [Low] Object URLs never revoked on signup avatar upload
- [AuthScreen.tsx:189-201](src/app/components/AuthScreen.tsx:189) creates object URLs for avatar preview/crop but never revokes them — the same class of leak already fixed elsewhere in the codebase (`CreateEventScreen.tsx`, `SettingsScreen.tsx` both explicitly revoke on replacement). `AuthScreen` is the one screen that missed the fix.

### [Low] Minor `useCallback` dependency churn
- `goBack` ([App.tsx:214-234](src/app/App.tsx:214)) lists `userRole` as a dependency but never reads it — harmless today (no screens are memoized yet) but causes needless identity churn on an `onBack` prop passed to nearly every screen.

### Verified NOT a problem (checked because they matched the audit's suspicion list)
- `CheckinScannerScreen.tsx` html5-qrcode lifecycle, `ConversationScreen.tsx` voice-recorder/audio-element cleanup (this project's previously-fixed leak), and `ExploreScreen.tsx`'s people-search debounce are all correctly implemented — no regression.
- No N+1 query patterns found in a repo-wide sweep for per-item DB calls inside loops; the codebase consistently batches with `.in(...)` after collecting IDs (e.g. Reports-tab user/event enrichment, wallet stat aggregation).

---

## 3. UX Debt

*(Full file-and-line citations from the UI-consistency pass; representative highlights below — see the audit source for the complete list of ~25 items.)*

### Emoji-as-functional-icon (should be lucide-react icons instead)
- **[High, systemic]** The entire category/state iconography system (`categories.ts`, reused in `HomeScreen.tsx`, `StateSelectScreen.tsx`) is emoji-based (🎵💻🍔🎤…), while every other icon surface in the app has moved to lucide-react — the single largest remaining surface of this pattern.
- **[High]** `TicketPurchase.tsx:13-17` payment-method icons are emoji despite `CreditCard` being imported and unused; `AuthScreen.tsx:857,954,1039` use 52px emoji as hero/status icons despite `Lock`/`Mail`/`ShieldCheck` being imported and used elsewhere in the same file; `CreateEventScreen.tsx:130`'s access-denied gate uses a 🔒 emoji where `CheckinScannerScreen.tsx:178`'s identical gate uses a real `Shield` icon.
- **[Medium]** `SettingsScreen.tsx:1240`/`ReportModal.tsx:64` use a bare `✓` glyph as a success icon instead of the `CheckCircle` component already used for the same concept in `QRTicket.tsx`.

### Color palette drift from documented Midnight Neon tokens
- **[High]** `BottomNav.tsx` (visible on nearly every screen) uses an entirely different palette — flat gray background, a violet-to-magenta active gradient, and a muted-gray inactive color — none of which match the app-wide Midnight Neon tokens used everywhere else.
- **[High]** `BadgeChip.tsx`'s tier colors (flat "metal" bronze/silver/gold/platinum hexes) and `QRTicket.tsx`'s hand-rolled amber ticket-tier pill are two incompatible definitions of "premium/gold" for the same underlying concept.
- **[Medium]** Two independently hand-rolled avatar-color-hashing palettes (`AttendeeListScreen.tsx`, `ExploreScreen.tsx`) mean the same user's initials avatar renders a different color depending which screen shows it.

### Typography inconsistency
- **[High]** Roughly half of all screen-header titles explicitly set `Space Grotesk`; the other half (including `QRTicket.tsx`, the recently-redesigned flagship pass) silently fall back to the body Inter font — no shared header component/token.
- **[Medium]** The same "app-bar title" role renders at seven different size/weight combinations across screens (17px/700 through 28px/800) with no evident 2-3-tier scale.

### Spacing/radius inconsistency
- **[Medium]** `ManageEventsScreen.tsx` status boxes use 10px radius against the file's own 12px input standard and the app's 12-24px scale.
- **[Low]** Status-pill background alpha values (0.07/0.08/0.1/0.12) vary across screens for the same "status chip" concept.

### Component duplication/drift
- **[Medium]** Destructive-confirmation UX is implemented three different ways (full-page two-step flow in Settings, bottom-sheet modal in ReportModal, no confirmation at all in Notifications "clear all") with no shared confirm-dialog primitive.
- **[Medium]** "Success/submitted" state has three independent visual treatments (real `CheckCircle` + banner in `QRTicket.tsx`; bare `✓` glyph + centered text in `ReportModal.tsx`; bare `✓` glyph + full-page layout in `SettingsScreen.tsx`) that all mean the same thing and share no component.
- **[Low-Medium]** The tier/VIP badge concept is implemented twice — the shared `BadgeChip` component for VC tiers, and a separate hand-rolled pill in `QRTicket.tsx` for ticket tiers — reinforcing the color-drift finding above.

---

## Summary

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 2 | 2 | 3 | 3 |
| Performance | – | 3 | 3 | 3 |
| UX Debt | – | 4 | 5 | 3 |

The two Critical security findings (`purchase_ticket` unverified payment, and the `users` RLS gap letting Sub-Admins alter Admin/Root accounts) were independently re-verified against live database function definitions and RLS policies during this audit and should be treated as the top priority — both represent real, currently-live exploit paths, not theoretical risk.
