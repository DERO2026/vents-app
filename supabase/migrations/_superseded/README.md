# Superseded migrations: never apply

Files here were written as migrations but must **not** be applied. They are
kept, byte for byte, for history and for the local tests that still exercise
them. Supabase tooling reads only the top level of `supabase/migrations/`,
so nothing in this folder is picked up by filename order.

| File | Never applied to production | Superseded by | Why it must not be applied |
|---|---|---|---|
| `0192_platform_fee_accounting_foundation.sql` (sha256 `b157d102…0ff84`) | Yes (checked read-only 2026-10-30: no `tickets.qualifying_status`; absent from the migration history) | 0201 (reward eligibility), 0203 (fees, holds, dispute holds) | Its full `CREATE OR REPLACE` of `confirm_ticket_payment` and `credit_organizer_wallet` makes 0203 refuse to apply (before 0203), or **silently removes 0203's fee model and 48-hour hold** (after 0203, once `completed_at` is made `IF NOT EXISTS`). Proven in `scripts/local-pg-test/run-migration-order-verification.sh`. Its per-ticket fee allocation counts only the buyer fee, so it understates revenue under the 4% + 5% model. |

If per-ticket revenue accounting is wanted, write a **new** migration after
0203 that patches the post-0203 function bodies by anchor with md5 pins (as
0203 does), never a full replacement. See
`docs/migration-apply-plan-0192-0203.md` §4.
