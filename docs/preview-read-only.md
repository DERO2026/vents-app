# Vercel Preview: read-only against production data

Vercel Preview deployments of this project use the **production** Supabase
project (`slrtjxtzhowhwhebjprv`); there is no separate Preview database. So
every Preview build runs **read-only**, and its server functions refuse
anything that moves money, writes privileged data or messages real people.
Production is unchanged: the production build is byte-for-byte identical to
the build before these safeguards were added (checked 2026-10-30, all 42
output files).

Both layers switch off by themselves if Preview is ever pointed at a
different Supabase project with test Paystack keys.

## Server guard (`api/_lib/previewGuard.ts`)

Active only when `VERCEL_ENV === 'preview'` and the deployment is not
positively configured with another Supabase project. In practice that means:

- `VITE_SUPABASE_URL` or `PROJECT_ADMIN_DATABASE_URL` is production, missing
  or unrecognisable;
- the two point at different projects;
- or `PAYSTACK_SECRET_KEY` is a live key.

Refused with `503 { error, preview_read_only: true }` before any external
call:

| Entry point | What it would have done |
|---|---|
| `webhook/paystack` (verify, verify-deposit, webhook) | Confirm tickets, wallet deposits, transfer fees, AI subscriptions, payouts, refunds |
| `promotions/activate` | Paid promotion |
| `wallet/admin-payout-action`, `wallet/reconcile-payouts` | Paystack transfers, payout state |
| `wallet/refund-ticket` | Paystack refunds |
| `wallet/save-bank`, `wallet/resolve-account` | Paystack recipients, bank lookups |
| `push/send`, `notify/status-email` | Real push, email and SMS |
| `extract-events` (POST) | AI assistant tools and paid AI calls |
| `cron/run` | Defence only; Vercel runs crons on Production only |

Backstops: `projectAdminDb.ts` refuses before opening a connection, and
`mailer.ts` and `pushDelivery.ts` send nothing.

## Browser guard (`src/lib/previewReadOnly.ts`)

Compiled in only when `__VENTS_PREVIEW_READ_ONLY__` is true (see
`src/lib/previewMode.ts` and `vite.config.ts`). A blocked call makes no
request and returns the client's normal `{ data: null, error }`.

- **Tables:** `insert`, `update`, `upsert` and `delete` are blocked; reads work.
- **RPCs:** only the 47 functions in `PREVIEW_ALLOWED_RPCS` run. Each was
  checked against its live production definition for direct and indirect
  writes, transitively through every function it calls.
  - Some functions look like reads but write, so they stay blocked:
    - `get_my_wallet` creates a wallet row;
    - `get_my_vc_balance` expires VENTS Cents and debits the balance;
    - `heartbeat_presence` updates the last-active time;
    - four functions write rate-limit rows.
- **Storage:** uploads, replacements, moves, copies, removals and bucket
  changes are blocked, including the two direct verification-document
  uploads. Public URLs and downloads work.
- **Accounts:** signing in to an existing account and signing out work.
  Sign-up, codes, password reset, email/phone changes and account deletion
  are blocked.
- **Paystack:** checkout refuses to open.
- **PostHog:** not started on any Preview build.
- **Banner:** "PREVIEW · READ ONLY · PRODUCTION DATA" across the top. It
  ignores taps.

This prevents accidental writes during review. It is not a security
boundary: the anon key is public, so RLS and the server guard remain the
enforcement.

## Tests

- `api/_lib/previewGuard.test.ts`: every entry point above returns 503 with
  no `fetch` and no Postgres connection; production requests pass through.
- `src/lib/previewReadOnly.test.ts`: uses a real Supabase client with
  `fetch` spied. It checks:
  - every app RPC that is not on the allowlist is blocked with no request;
  - writes, storage and account changes are blocked;
  - reads still work;
  - the wiring and the banner.
- `src/lib/previewReadOnly.preview-build.test.ts` (run by
  `vitest.preview.config.ts` as part of `npm test`): the real `supabase.ts`
  and `paystack.ts`, compiled as a Preview build.
