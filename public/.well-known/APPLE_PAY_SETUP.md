# Apple Pay domain verification — NOT YET DONE

This file documents exactly what's left to make Apple Pay work on
getvents.com. It is deliberately a `.md` file, not the real verification
file — the real file has to come from Paystack's own dashboard, and nobody
should fabricate its contents.

## What's still needed (manual, dashboard-side)

1. In the Paystack Dashboard, enable international payments and Apple Pay
   for this merchant account (per Paystack's own support docs, Apple Pay
   must be turned on for the account before any domain can be registered).
2. In Dashboard → Apple Pay settings, register each exact domain tickets
   will be sold from (at minimum `getvents.com`; register `www.getvents.com`
   separately too if that's also a real checkout-facing hostname — Apple
   verifies per exact hostname, not per root domain).
3. For each registered domain, download the verification file Paystack's
   dashboard generates. Its real name and byte contents come from that
   download — nobody should type one out by hand.
4. Place that downloaded file at
   `public/.well-known/apple-developer-merchantid-domain-association`
   in this repo (same directory as this README), commit it, and deploy.
   `vercel.json` already has a `headers` rule forcing
   `Content-Type: application/text` for exactly that path, per Paystack's
   own documented requirement that the file be served with that content
   type or the customer's payment can fail — so once the real file lands
   here, no further vercel.json change should be needed.
5. Back in the Paystack Dashboard, click "Verify" for the domain. This is
   the one step that actually confirms it worked — nothing in this repo,
   and no claim in any report, substitutes for that dashboard confirmation
   actually succeeding.
6. Repeat per subdomain if ticket checkout is ever served from one (e.g. a
   dedicated checkout subdomain) — Apple's verification is per exact
   hostname serving the page, not per top-level domain.

## What's already done (code-side, this change)

- The app now loads `@paystack/inline-js` v2 (via npm, bundled), which is
  the version Paystack's own docs show Apple Pay / Google Pay examples
  against — the previous `v1/inline.js` CDN script had no documented
  wallet support.
- `apple_pay` and `google_pay` are included in the default Paystack
  `channels` list, but **only on web builds** — never inside the Capacitor
  native app (see `src/lib/paystack.ts`'s `defaultChannels()` and its
  comment for why: the native WebView's origin is `https://localhost`,
  which can never pass Apple's/Google's domain verification regardless of
  what's registered for `getvents.com`).
- Paystack's own hosted checkout iframe decides, per visiting
  browser/device, whether to actually render either wallet button —
  listing the channels here only makes both *eligible*; nothing in this
  codebase renders a wallet button of its own.

## Until step 5 above is done

Apple Pay will not appear for web customers even though the code supports
it — Paystack's checkout correctly hides an unverified wallet rather than
offering one that would fail. This is expected and correct, not a bug.
