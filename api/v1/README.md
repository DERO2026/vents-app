# /api/v1

Versioned mirror of the endpoints under `api/`. Each file here is a thin
`export { default } from '../../<path>.js'` re-export of its unversioned
sibling — one implementation, two routes.

Why: Vercel serves every file under `api/` as its own route, so a mobile
client that shipped with `/api/wallet/banks` baked in keeps working forever
even after we start changing behavior under `/api/v1/wallet/banks`. Going
forward, new frontend/mobile code should call the `/v1` path; the
unversioned paths stay frozen as a back-compat alias for clients already in
the wild. When a breaking change is needed, it lands as `/api/v2/...` and
`/api/v1/...` gets frozen the same way.

The Paystack webhook (`api/webhook/paystack.ts`) is intentionally not
versioned here — it's a server-to-server callback with a URL configured on
Paystack's side, not a client API surface.
