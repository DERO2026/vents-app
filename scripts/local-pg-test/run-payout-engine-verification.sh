#!/usr/bin/env bash
# Real-execution verification of the earnings withdrawal engine after
# migration 0202 (payout engine safety). Covers the confirmed defects from
# docs/money-flow-audit.md:
#
#   P0-1  a payout whose Paystack transfer may exist cannot be cancelled,
#         and a transfer that succeeds after a legacy cancel takes the
#         returned money back instead of paying twice;
#   P0-2  a reversal after success returns the money to the balance, once;
#   P0-3  one fixed transfer reference per request, kept across releases,
#         unique across requests; marking a transfer as sent fails loudly;
#   P1-6  the ledger explains balance + pending after every step
#         (admin_earnings_reconciliation reports no issue).
#
# Builds the same throwaway schema as run-representative-rewards-verification.sh
# (live payout functions), applies 0201 and 0202, and adds verbatim copies
# of the two live functions 0202 does not replace (fail_organizer_payout,
# admin_reject_organizer_payout; production, 2026-10-30). No network, no
# Paystack: Paystack outcomes are the RPC calls the webhook would make.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files.
#
# Usage: scripts/local-pg-test/run-payout-engine-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_payout_engine"
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

OUT=$(mktemp); ERR=$(mktemp)
cleanup() { rm -f "$OUT" "$ERR"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ORG="00000000-0000-0000-0000-0000000000a1"
ORG2="00000000-0000-0000-0000-0000000000a2"
ADMIN="00000000-0000-0000-0000-0000000000b1"
ADMIN2="00000000-0000-0000-0000-0000000000b3"
SUB="00000000-0000-0000-0000-0000000000b2"
OTHER="00000000-0000-0000-0000-0000000000c1"
BANK="00000000-0000-0000-0000-0000000000d1"
BANK2="00000000-0000-0000-0000-0000000000d2"

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
# balance/pending/withdrawn for an organizer
wallet() { val "SELECT balance_kobo || '/' || pending_kobo || '/' || total_withdrawn_kobo FROM public.organizer_wallets WHERE organizer_id = '$1';"; }
req_status() { val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '$1';"; }
# Ledger, pending and open requests all agree for every wallet.
reconciled() { val "$(as "$ADMIN" "SELECT count(*) FILTER (WHERE cardinality(issues) > 0) FROM public.admin_earnings_reconciliation();")"; }
request() { val "$(as "$1" "SELECT public.request_organizer_payout($2, '$3', '$4');")"; }
# After 0203 a request is claimable only once two admins authorized it:
# ADMIN2 requests the authorization, ADMIN approves it (maker-checker), then
# the claim runs. Skipped when already authorized or no longer pending.
authorize() {
  if [ "$(val "SELECT (status = 'pending' AND approved_by IS NULL)::text FROM public.organizer_withdrawal_requests WHERE id = '$1';")" = "true" ]; then
    local amt ar; amt=$(val "SELECT amount_kobo FROM public.organizer_withdrawal_requests WHERE id = '$1';")
    ar=$(val "$(as "$ADMIN2" "SELECT public.request_admin_action('authorize_withdrawal', 'withdrawal', '$1', 'test', '{\"amount_kobo\": $amt}'::jsonb)->>'id';")")
    "${PSQL[@]}" -q -c "$(as "$ADMIN" "SELECT public.approve_admin_action('$ar');")" >/dev/null
  fi
}
claim() { authorize "$1"; val "$(as "$ADMIN" "SELECT claimed::text FROM public.admin_claim_payout_for_processing('$1');")"; }
ref_for() { echo "payout_$(echo "$1" | tr -d '-')"; }
srv() { val "SELECT status FROM public.$1;"; }   # server-side (webhook) call, as the DB owner

echo "== Building throwaway database $DB_NAME =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null

# Live helpers and the two live payout functions 0202 does not replace.
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null

echo "== Applying 0202 =="
"${PSQL[@]}" -q -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
pass "0202 applies on top of 0201 and the live payout functions"
# 0203 (earnings policies) on top, so the engine is tested as it ships.
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null 2>&1
"${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0203_earnings_policies.sql" >/dev/null
pass "0203 applies on top of 0202"
"${PSQL[@]}" -q -c "GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid), public.admin_mark_payout_processing(uuid,text,text), public.admin_release_payout_claim(uuid,text), public.admin_cancel_processing_payout(uuid,text) TO authenticated;"

"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org One', 'org1@example.test'), ('$ORG2', 'user', true, 'Org Two', 'org2@example.test'),
  ('$ADMIN', 'admin', false, 'Admin', 'a@example.test'), ('$ADMIN2', 'admin', false, 'Admin Two', 'a2@example.test'), ('$SUB', 'sub-admin', false, 'Sub', 's@example.test'),
  ('$OTHER', 'user', false, 'Other', 'o@example.test');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active)
VALUES ('$BANK', '$ORG', 'Test Bank', '000', '0000000001', 'ORG ONE', 'RCP_test_1', true),
       ('$BANK2', '$ORG2', 'Test Bank', '000', '0000000002', 'ORG TWO', 'RCP_test_2', true);
-- Earnings already credited the normal way (wallet + matching ledger row).
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo) VALUES ('$ORG', 1000000, 1000000), ('$ORG2', 300000, 300000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description)
VALUES ('$ORG', 'credit', 1000000, 'ticket sales'), ('$ORG2', 'credit', 300000, 'bookings');
SQL
expect_value "starting point: every wallet reconciles" "$(reconciled)" "0"

echo "== Request, claim and the fixed reference (P0-3) =="
R1=$(request "$ORG" 200000 "$BANK" "k1")
expect_value "a withdrawal moves available money to pending" "$(wallet "$ORG")" "800000/200000/0"
expect_value "the same idempotency key does not create a second request" "$(request "$ORG" 200000 "$BANK" "k1")" "$R1"
expect_value "after a request every wallet still reconciles" "$(reconciled)" "0"
expect_value "only one admin claim wins" "$(claim "$R1")/$(claim "$R1")" "true/false"
expect_value "claiming sets the request's fixed transfer reference" \
  "$(val "SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$R1';")" "$(ref_for "$R1")"
expect_value "the SQL reference matches the API helper's format" \
  "$(val "SELECT public.payout_transfer_reference('$R1');")" "$(ref_for "$R1")"
expect_error "marking a transfer with another reference is refused" "does not belong to this payout request" \
  "$(as "$ADMIN" "SELECT public.admin_mark_payout_processing('$R1', 'payout_${R1}_123', 'TRF_x');")"
expect_ok "marking the transfer with the fixed reference works" \
  "$(as "$ADMIN" "SELECT public.admin_mark_payout_processing('$R1', '$(ref_for "$R1")', 'TRF_1');")"
expect_error "a different transfer code cannot overwrite the recorded one" "already has a different transfer" \
  "$(as "$ADMIN" "SELECT public.admin_mark_payout_processing('$R1', '$(ref_for "$R1")', 'TRF_other');")"
expect_error "two requests can never share a transfer reference" "organizer_withdrawal_requests_reference_once" \
  "INSERT INTO public.organizer_withdrawal_requests (organizer_id, amount_kobo, bank_account_id, paystack_reference) VALUES ('$ORG', 1, '$BANK', '$(ref_for "$R1")');"

echo "== Cancel can no longer pay twice (P0-1) =="
expect_error "a request with a Paystack transfer cannot be cancelled" "A Paystack transfer may exist" \
  "$(as "$ADMIN" "SELECT * FROM public.admin_cancel_processing_payout('$R1', 'stuck');")"
RC=$(request "$ORG2" 50000 "$BANK2" "c1"); claim "$RC" >/dev/null
expect_error "a claimed request with no code yet (outcome unknown) cannot be cancelled either" "A Paystack transfer may exist" \
  "$(as "$ADMIN" "SELECT * FROM public.admin_cancel_processing_payout('$RC', 'stuck');")"
expect_value "nothing moved" "$(wallet "$ORG")/$(req_status "$R1")" "800000/200000/0/processing"
expect_error "a transfer that exists cannot be released back to pending" "no Paystack transfer can be released" \
  "$(as "$ADMIN" "SELECT public.admin_release_payout_claim('$R1', 'retry');")"

echo "== Completion is once, by code or reference =="
expect_value "transfer.success completes the request" "$(srv "complete_organizer_payout('TRF_1')")" "completed"
expect_value "withdrawn money leaves pending and counts as withdrawn" "$(wallet "$ORG")" "800000/0/200000"
expect_value "a repeated success (webhook retry, Reconcile) changes nothing" \
  "$(srv "complete_organizer_payout('$(ref_for "$R1")')")/$(wallet "$ORG")" "already_completed/800000/0/200000"
expect_value "exactly one payout ledger row" "$(val "SELECT count(*) FROM public.organizer_transactions WHERE withdrawal_request_id = '$R1' AND type = 'payout';")" "1"
expect_error "the ledger itself refuses a second payout row for the request" "organizer_transactions_payout_once" \
  "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, withdrawal_request_id) VALUES ('$ORG', 'payout', 200000, '$R1');"
expect_value "after completion every wallet reconciles" "$(reconciled)" "0"

echo "== Reversal after success returns the money (P0-2) =="
expect_value "transfer.reversed after success reverses the payout" "$(srv "reverse_organizer_payout('TRF_1', 'bank reversed')")" "reversed"
expect_value "the money is back in the available balance and no longer counted as withdrawn" "$(wallet "$ORG")/$(req_status "$R1")" "1000000/0/0/reversed"
expect_value "a repeated reversal changes nothing" "$(srv "reverse_organizer_payout('TRF_1', 'again')")/$(wallet "$ORG")" "already_finalized/1000000/0/0"
expect_value "a late success after the reversal changes nothing" "$(srv "complete_organizer_payout('TRF_1')")/$(wallet "$ORG")" "already_completed/1000000/0/0"
expect_value "one reversal ledger row" "$(val "SELECT count(*) FROM public.organizer_transactions WHERE withdrawal_request_id = '$R1' AND type = 'payout_reversal';")" "1"
expect_value "after the reversal every wallet reconciles" "$(reconciled)" "0"

echo "== Reversal or failure before success =="
R2=$(request "$ORG" 100000 "$BANK" "k2"); claim "$R2" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ADMIN" "SELECT public.admin_mark_payout_processing('$R2', '$(ref_for "$R2")', 'TRF_2');")" >/dev/null
expect_value "a reversal before success is a failure: money back to available" \
  "$(srv "reverse_organizer_payout('TRF_2', 'reversed early')")/$(wallet "$ORG")/$(req_status "$R2")" "failed/1000000/0/0/failed"
expect_value "a success after the failure is flagged for review and moves no money" \
  "$(srv "complete_organizer_payout('TRF_2')")/$(wallet "$ORG")/$(req_status "$R2")" "needs_review/1000000/0/0/failed"

echo "== Release: only with Paystack confirming nothing was sent =="
R3=$(request "$ORG" 50000 "$BANK" "k3"); claim "$R3" >/dev/null
expect_ok "a claim with no transfer code can be released" "$(as "$ADMIN" "SELECT public.admin_release_payout_claim('$R3', 'Paystack: not found');")"
expect_value "release keeps the fixed reference, so a retry cannot pay twice" \
  "$(req_status "$R3")/$(val "SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$R3';")" "pending/$(ref_for "$R3")"
expect_value "re-claiming reuses the same reference" \
  "$(claim "$R3")/$(val "SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$R3';")" "true/$(ref_for "$R3")"
expect_value "the transfer can be completed by its reference alone" \
  "$(srv "complete_organizer_payout('$(ref_for "$R3")')")/$(wallet "$ORG")" "completed/950000/0/50000"

echo "== Legacy: a transfer that succeeds after the request was cancelled (P0-1) =="
R4=$(request "$ORG2" 100000 "$BANK2" "legacy"); claim "$R4" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ADMIN" "SELECT public.admin_mark_payout_processing('$R4', '$(ref_for "$R4")', 'TRF_4');")" >/dev/null
# What the pre-0202 cancel did: status cancelled, money back to available.
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET status = 'cancelled' WHERE id = '$R4'; UPDATE public.organizer_wallets SET balance_kobo = balance_kobo + 100000, pending_kobo = pending_kobo - 100000 WHERE organizer_id = '$ORG2';"
before=$(wallet "$ORG2")
expect_value "the late success completes the request and takes the returned money back" \
  "$(srv "complete_organizer_payout('TRF_4')")/$(wallet "$ORG2")" "completed/$((${before%%/*} - 100000))/50000/100000"
expect_value "no recovery shortfall when the money was still available" \
  "$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'payout_recovery_shortfall';")" "0"
R5=$(request "$ORG2" 100000 "$BANK2" "legacy2"); claim "$R5" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ADMIN" "SELECT public.admin_mark_payout_processing('$R5', '$(ref_for "$R5")', 'TRF_5');")" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET status = 'cancelled' WHERE id = '$R5'; UPDATE public.organizer_wallets SET balance_kobo = 30000, pending_kobo = pending_kobo - 100000 WHERE organizer_id = '$ORG2';"
expect_value "when the money was already spent, only what is available is taken back, never below zero" \
  "$(srv "complete_organizer_payout('TRF_5')")/$(val "SELECT balance_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG2';")" "completed/0"
expect_value "the shortfall is recorded for an admin" \
  "$(val "SELECT (details->>'shortfall_kobo') FROM public.admin_logs WHERE action = 'payout_recovery_shortfall';")" "70000"

echo "== Reject, permissions and grants =="
R6=$(request "$ORG" 10000 "$BANK" "k6")
expect_error "a sub-admin cannot reject" "Super Admin access required" "$(as "$SUB" "SELECT public.admin_reject_organizer_payout('$R6', 'no');")"
expect_ok "a super admin rejects a pending request" "$(as "$ADMIN" "SELECT public.admin_reject_organizer_payout('$R6', 'duplicate');")"
expect_value "rejected money is back in available" "$(wallet "$ORG")" "950000/0/50000"
expect_error "a non-admin cannot claim" "Admin access required" "$(as "$OTHER" "SELECT * FROM public.admin_claim_payout_for_processing('$R6');")"
expect_value "clients cannot call the reversal" \
  "$(val "SELECT has_function_privilege('authenticated', 'public.reverse_organizer_payout(text,text)', 'EXECUTE')::text || '/' || has_function_privilege('anon', 'public.reverse_organizer_payout(text,text)', 'EXECUTE')::text;")" "false/false"
expect_value "a non-admin sees nothing in the reconciliation report" \
  "$(val "$(as "$OTHER" "SELECT count(*) FROM public.admin_earnings_reconciliation();")")" "0"
expect_error "a reversal is an allowed ledger type; nonsense is not" "organizer_transactions_type_check" \
  "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo) VALUES ('$ORG', 'bonus', 1);"
expect_error "a withdrawal status outside the state machine is refused" "organizer_withdrawal_requests_status_check" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'paid' WHERE id = '$R6';"

echo "== Ledger and balances at the end =="
expect_value "ORG's ledger explains balance + pending exactly" \
  "$(val "$(as "$ADMIN" "SELECT ledger_gap_kobo || '/' || pending_gap_kobo || '/' || cardinality(issues) FROM public.admin_earnings_reconciliation() WHERE organizer_id = '$ORG';")")" "0/0/0"
expect_value "no wallet is negative" "$(val "SELECT count(*) FROM public.organizer_wallets WHERE balance_kobo < 0 OR pending_kobo < 0;")" "0"
expect_value "the report flags a wallet whose ledger does not match" \
  "$("${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET balance_kobo = balance_kobo + 1 WHERE organizer_id = '$ORG';" >/dev/null; val "$(as "$ADMIN" "SELECT array_to_string(issues, ',') FROM public.admin_earnings_reconciliation() WHERE organizer_id = '$ORG';")")" "ledger_does_not_match_balance"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES PAYOUT ENGINE CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
