# Supabase Auth email templates — reference copies

These files are **not automatically applied** — Supabase Auth's mailer
templates live in the project's hosted config
(`mailer_templates_confirmation_content` / `mailer_subjects_confirmation`,
set via the Management API or the Dashboard at
Authentication → Emails → Confirm sign up), not in this repo. They're
saved here purely as a version-controlled reference, the same reasoning
as why the SQL migrations in `supabase/migrations/` are committed even
though they were applied via a direct database connection rather than a
build step reading these files.

If the live template ever needs to be restored or diffed against a known-
good version, this is that reference. To re-apply a file here, PATCH
`https://api.supabase.com/v1/projects/<ref>/config/auth` with
`mailer_templates_confirmation_content` set to the file's contents.

## confirm-signup.html

The single VENTS-branded confirmation email — contains both the OTP code
(`{{ .Token }}`) and a "Verify Account" button. The button links to
`{{ .SiteURL }}/?verify_email={{ .Email }}` (VENTS's own domain, resumes
the in-app OTP screen) rather than `{{ .ConfirmationURL }}` (Supabase's
own domain), deliberately, to avoid ever exposing the raw Supabase
project URL to the user.

The VENTS wordmark ("V" + three purple bars for "E" + "NTS") is built
from nested HTML tables rather than the app's real `VentsLogo.tsx`
component, since email clients don't support flexbox/CSS custom
properties reliably. One structural note if this is ever edited: **each
bar must sit in its own independent nested `<table>`**, not share a
single table's rows — HTML's table auto-layout algorithm normalizes a
column's width to its widest row, so a shared table would silently
render the intentionally-shorter middle bar at the same width as the
other two.

Subject line (`mailer_subjects_confirmation`): "Confirm your VENTS
account".

## reset-password.html

The VENTS-branded password-recovery email — same layout/wordmark as
`confirm-signup.html`, contains the OTP code (`{{ .Token }}`, consumed by
`AuthScreen.tsx`'s forgot-password Step 1 via `supabase.auth.verifyOtp({type:
'recovery'})`) and a "Reset Password" button. The button links to
`{{ .SiteURL }}/?reset_email={{ .Email }}` (same reasoning as
`confirm-signup.html`'s button — VENTS's own domain, never the raw Supabase
project URL) rather than `{{ .ConfirmationURL }}`. `App.tsx`'s `reset_email`
query-param handler resumes straight to the forgot-password OTP screen (never
re-requests a code — the one in this email is still valid) and, on a mobile
browser, best-effort hands off to the `vents://reset?email=...` scheme the
native app's `appUrlOpen` listener already handles, with this same web page
as the fallback if the app isn't installed — mirrors the `vents://verify`
handoff already wired up for `confirm-signup.html`.

Applies to a different config key than `confirm-signup.html`:
`mailer_templates_recovery_content` (Authentication → Emails → Reset
Password), not `mailer_templates_confirmation_content`. Subject line
(`mailer_subjects_recovery`): "Reset your VENTS password".

**This file did not previously exist in the repo** — the live recovery
template was apparently edited directly in the Supabase Dashboard at some
point (it already sends an 8-digit code, matching `AuthScreen.tsx`'s
`EMAIL_OTP_LENGTH`), with no committed reference copy. If the live dashboard
template doesn't already match this file, it must be manually re-applied
there (see "To re-apply a file here" above, using
`mailer_templates_recovery_content` instead of `_confirmation_content`) —
this repo change alone does not update it.
