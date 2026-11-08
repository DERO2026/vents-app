#!/usr/bin/env bash
# Release-stack verification: the exact window order and the full rollback.
#   apply  0201 -> 0202 -> 0203 -> 0205 -> 0206 -> 0207 -> 0208 -> 0209 (W4-W6e)
#   undo   R1e (0209) -> R1d (0208) -> R1c (0207) -> R1b (0206) -> R1a (0205)
#          must return every function, constraint and column to the
#          post-0203 state exactly; then the whole stack re-applies and a
#          second run of each migration changes nothing.
# Same throwaway local database setup as run-earnings-policy-verification.sh.
#           recovered from later earnings; never a negative balance;
#   rule 3  a withdrawal needs two different admins, neither the organizer,
#           and is paid only to the bank recipient that was authorized;
#   and the ledger explains available + pending + on hold after each step.
#
# Builds the 0201 + 0202 stack used by run-payout-engine-verification.sh,
# loads the live ticket/booking money functions (live-money-functions.sql,
# md5-verified against production), creates legacy rows, then applies 0203.
# No network, no Paystack: Paystack outcomes are the RPC calls the webhook
# and API make.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files.
#
# Usage: scripts/local-pg-test/run-earnings-policy-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_release_stack"
SOCKET_DIR="/var/run/postgresql"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then die "\$$var is set. Unset it; this test only connects to the local Unix socket."; fi
done
if env | grep -qiE 'supabase\.(co|com)|pooler\.|rds\.amazonaws\.com|neon\.tech|render\.com'; then
  die "an environment variable references a hosted database host."
fi
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z_]+$ ]] || die "database name '$DB_NAME' is not a local test name."
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || die "no local PostgreSQL socket at $SOCKET_DIR (start it: pg_ctlcluster 16 main start)."
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }
PSQL=(pg -d "$DB_NAME")
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || die "connection is not a local, non-Supabase PostgreSQL server ($server_check)."

TMP=$(mktemp -d); OUT="$TMP/out"; ERR="$TMP/err"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ORG="00000000-0000-0000-0000-0000000003a1"
ORG_ADMIN="00000000-0000-0000-0000-0000000003a2"
PROV="00000000-0000-0000-0000-0000000003a3"
BUYER="00000000-0000-0000-0000-0000000003b1"
BUYER2="00000000-0000-0000-0000-0000000003b2"
ADMIN_A="00000000-0000-0000-0000-0000000003c1"
ADMIN_B="00000000-0000-0000-0000-0000000003c2"
SUB="00000000-0000-0000-0000-0000000003c3"
EVENT="00000000-0000-0000-0000-0000000003e1"
E_R2="00000000-0000-0000-0000-0000000003e3"
E_PROMO="00000000-0000-0000-0000-0000000003e4"
E_W1="00000000-0000-0000-0000-0000000003e5"
E_S2="00000000-0000-0000-0000-0000000003e6"
E_B1="00000000-0000-0000-0000-0000000003e7"
E_B2="00000000-0000-0000-0000-0000000003e8"
E_B3="00000000-0000-0000-0000-0000000003e9"
ORG3="00000000-0000-0000-0000-0000000003a4"
EVENT2="00000000-0000-0000-0000-0000000003e2"
BANK="00000000-0000-0000-0000-0000000003d1"
BANK_OA="00000000-0000-0000-0000-0000000003d2"
SP_ID="00000000-0000-0000-0000-0000000003f1"

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
expect_error() {
  if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an exception, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error)"; cat "$ERR" >&2; fi
}
# available/pending/on hold
wallet() { val "SELECT balance_kobo || '/' || pending_kobo || '/' || on_hold_kobo FROM public.organizer_wallets WHERE organizer_id = '$1';"; }
# Ledger = available + pending + on hold, pending = open requests, on hold = open holds, for every wallet.
reconciled() { val "$(as "$ADMIN_A" "SELECT count(*) FILTER (WHERE ledger_gap_kobo <> 0 OR pending_gap_kobo <> 0 OR hold_gap_kobo <> 0 OR 'negative_balance' = ANY(issues)) FROM public.admin_earnings_reconciliation();")"; }
buy() {  # buy <user> <event> <n attendees> [promo] -> payment_ref
  local att; att=$(python3 -c "import json,sys; print(json.dumps([{'name': 'A%d' % i} for i in range(int(sys.argv[1]))]))" "$3")
  val "$(as "$1" "SELECT public.create_pending_purchase('$2', 'Regular', '$att'::jsonb, ${4:-NULL})->>'payment_ref';")"
}
amount_of() { val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$1';"; }
# Paystack webhook / verify (server), as api/_lib/finalizePaystackPayment.ts does it:
# finalize the pending purchase (idempotent), then confirm the payment.
confirm() {
  "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$1');" >/dev/null 2>&1 || true
  val "SELECT public.confirm_ticket_payment('$1', $2);"
}
hold_of() { val "SELECT amount_kobo || '/' || refunded_kobo || '/' || released_kobo FROM public.earnings_holds WHERE source_key = '$1';"; }
# Time travel for an event (test-only owner write): it ended <ago> ago, and
# its sales were made before that end (default: just over 48 hours ago).
end_event() {
  local ago="${2:-48 hours 1 minute}"
  "${PSQL[@]}" -q -c "UPDATE public.events SET event_date = now() - interval '$ago' - interval '3 hours', end_date = now() - interval '$ago' WHERE id = '$1';
    UPDATE public.earnings_holds SET event_end_at_sale = now() - interval '$ago' WHERE event_id = '$1';"
}
# Time travel for a completed booking: completed <ago> ago (the stamp is
# trigger-protected, so the test disables it for this one write).
complete_ago() {
  "${PSQL[@]}" -q -c "ALTER TABLE public.service_bookings DISABLE TRIGGER service_bookings_stamp_completion;
    UPDATE public.service_bookings SET completed_at = now() - interval '${2:-48 hours 1 minute}' WHERE id = '$1';
    ALTER TABLE public.service_bookings ENABLE TRIGGER service_bookings_stamp_completion;"
}
blockers() { val "SELECT string_agg(b, ',' ORDER BY b) FROM public.earnings_holds h, jsonb_array_elements_text(public.earnings_hold_state(h.id)->'blockers') b WHERE h.source_key = '$1';"; }
settle() { val "$(as "$1" "SELECT public.settle_my_earnings()::text;")"; }
first_ticket() { val "SELECT id FROM public.tickets WHERE payment_ref = '$1' ORDER BY id LIMIT 1;"; }
request_admin() { val "$(as "$1" "SELECT public.request_admin_action('$2', 'withdrawal', '$3', 'test', '$4'::jsonb)->>'id';")"; }
approve() { as "$1" "SELECT public.approve_admin_action('$2');"; }
claim() { val "$(as "$ADMIN_A" "SELECT claimed::text FROM public.admin_claim_payout_for_processing('$1');")"; }

echo "== Building throwaway database $DB_NAME =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
# Local stubs, not production bodies: 0202's drift guard is relaxed only
# with this setting on a vents_local_pg_* database.
"${PSQL[@]}" -q -c "SET vents.migration_local_test = 'on';" -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.confirm_ticket_payment_via_wallet(text),
  public.refund_ticket(uuid,text), public.cancel_service_booking(uuid,text), public.get_event_analytics(uuid),
  public.admin_claim_payout_for_processing(uuid), public.complete_service_booking(uuid) TO authenticated;
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test'), ('$ORG_ADMIN', 'admin', true, 'Org Admin', 'oa@example.test'),
  ('$PROV', 'user', false, 'Provider', 'p@example.test'),
  ('$BUYER', 'user', false, 'Buyer', 'b@example.test'), ('$BUYER2', 'user', false, 'Buyer Two', 'b2@example.test'),
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test'), ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test'),
  ('$SUB', 'sub-admin', false, 'Sub', 's@example.test'), ('$ORG3', 'user', true, 'Org Three', 'o3@example.test');
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EVENT', '$ORG', 'Concert', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_R2', '$ORG', 'Concert night 2', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_PROMO', '$ORG', 'Promo night', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_W1', '$ORG', 'Wallet night', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_S2', '$ORG', 'Second season', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_B1', '$ORG3', 'Blockers 1', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_B2', '$ORG3', 'Blockers 2', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_B3', '$ORG3', 'Reported', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$EVENT2', '$ORG_ADMIN', 'Admin gig', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 5000}]');
INSERT INTO public.promo_codes (code, discount_percentage) VALUES ('TEN', 10);
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES
  ('$BANK', '$ORG', 'Bank', '000', '0000000001', 'ORG', 'RCP_org', true),
  ('$BANK_OA', '$ORG_ADMIN', 'Bank', '000', '0000000002', 'ORG ADMIN', 'RCP_oa', true);
INSERT INTO public.service_providers (id, user_id) VALUES ('$SP_ID', '$PROV');
SQL

"${PSQL[@]}" -q -c "ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();"
STATE_SQL="SELECT md5(string_agg(p.oid::regprocedure::text || ':' || p.prosrc, '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT md5(string_agg(conrelid::regclass::text || conname || pg_get_constraintdef(oid), '|' ORDER BY conrelid::regclass::text, conname)) FROM pg_constraint WHERE connamespace = 'public'::regnamespace) || '/' || (SELECT md5(string_agg(table_name || '.' || column_name || COALESCE(column_default, ''), '|' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema = 'public') || '/' || (SELECT md5(string_agg(tgrelid::regclass::text || tgname, '|' ORDER BY tgrelid::regclass::text, tgname)) FROM pg_trigger WHERE NOT tgisinternal) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
apply() { expect_ok "$1 applies" "$(cat "$MIG/$1.sql")"; }
undo() { expect_ok "undo_$1 ($2) runs" "SET vents.rollback_confirm = 'undo-$1'; $(cat "$REPO_ROOT/supabase/rollback/undo_$1.sql")"; }

echo "== Apply in window order (0201, 0202 already applied by setup) =="
apply 0203_earnings_policies
POST_0203=$(val "$STATE_SQL")
apply 0205_payout_cancelled_transfer_safety
apply 0206_earnings_adjustment
apply 0207_withdrawal_bank_reassignment
apply 0208_ticket_fee_1_5_3_5
apply 0209_representative_referral_links
FULL=$(val "$STATE_SQL")
expect_value "P1 after the window: every new object exists" \
  "$(val "SELECT (to_regprocedure('public.get_my_representative_rewards()') IS NOT NULL AND to_regprocedure('public.admin_earnings_reconciliation()') IS NOT NULL AND to_regprocedure('public.earnings_release_delay()') IS NOT NULL AND to_regprocedure('public.organizer_withdrawal_requests_guard()') IS NOT NULL AND to_regclass('public.earnings_adjustments') IS NOT NULL AND to_regclass('public.withdrawal_bank_reassignments') IS NOT NULL AND to_regprocedure('public.ticket_fee_buyer_charge_kobo(numeric,integer,numeric,text)') IS NOT NULL AND to_regprocedure('public.claim_representative_referral(text)') IS NOT NULL)::text;")" "true"
expect_value "new tickets are sold at 1.5% + 3.5%" "$(val "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='tickets' AND column_name='fee_model';")" "'v3_15_35'::text"

echo "== Every migration is idempotent on the full stack =="
for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment 0208_ticket_fee_1_5_3_5 0209_representative_referral_links; do
  "${PSQL[@]}" -q -c "$(cat "$MIG/$m.sql")" >/dev/null 2>"$ERR" || { fail "$m second run errored"; cat "$ERR" >&2; }
done
expect_value "a second run of 0203-0209 changes nothing" "$(val "$STATE_SQL")" "$FULL"

echo "== Full rollback in reverse order R1e -> R1a =="
undo 0209 R1e
undo 0208 R1d
undo 0207 R1c
undo 0206 R1b
expect_ok "undo_0205 (R1a) runs" "SET vents.rollback_confirm = 'undo-0205'; $(cat "$REPO_ROOT/supabase/rollback/undo_0205.sql")"
expect_value "after R1e..R1a the database is exactly the post-0203 state" "$(val "$STATE_SQL")" "$POST_0203"

echo "== Re-apply after a rollback =="
for m in 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment 0208_ticket_fee_1_5_3_5 0209_representative_referral_links; do apply "$m"; done
expect_value "re-applied stack equals the first full apply" "$(val "$STATE_SQL")" "$FULL"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES RELEASE STACK CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
