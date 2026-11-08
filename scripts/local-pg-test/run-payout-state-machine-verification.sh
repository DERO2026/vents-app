#!/usr/bin/env bash
# Verifies migration 0205 (one payout state machine, immutable payout
# details, deletion protection, admin integrity report, undo) on a LOCAL
# throwaway database:
#   - the July 2026 "launch sweep" statement, extracted VERBATIM from
#     migrations/20260713100000_admin-stats-and-payout-cleanup.sql,
#     reproduces the incident on production's code and is refused after
#     0201 -> 0202 -> 0203 -> 0205;
#   - final states stay final; owner, amount, reference and transfer code
#     are immutable; payout history cannot be deleted;
#   - the transitions the real 0202/0203 functions use still work (the
#     full engine is also run under 0205 by run-payout-engine-verification.sh
#     and run-earnings-policy-verification.sh);
#   - applying 0205 moves no money; undo_0205.sql restores 0202's guard.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_payout_state_machine"
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
cleanup() { pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
val() { "${PSQL[@]}" -tA -c "$1" 2>/dev/null | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', expected '$3')"; fi; }
run() { "${PSQL[@]}" -c "$1" 2>&1; }
expect_error() {  # name, expected substring, sql
  local out; out=$(run "$3")
  if [[ "$out" == *"$2"* ]]; then pass "$1"; else fail "$1 (expected error containing '$2', got: $(echo "$out" | tail -1))"; fi
}
expect_ok() {
  local out; out=$(run "$2"); if [[ "$out" != *ERROR* ]]; then pass "$1"; else fail "$1 ($(echo "$out" | grep ERROR | head -1))"; fi
}
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
apply_file() {  # file [extra SET]
  "${PSQL[@]}" -q -1 -c "${2:-SELECT 1;}" -f - <"$1" 2>&1 | grep -E 'ERROR' | head -1
}

ORG="00000000-0000-0000-0000-0000000005a1"
OTHER="00000000-0000-0000-0000-0000000005a2"
ADMIN="00000000-0000-0000-0000-0000000005ad"
BANK="00000000-0000-0000-0000-0000000005b1"
IDS=(3aa0f8ff-d652-48cb-a06f-82a99d434dbe f9fda363-8e24-45af-8d2a-74dd7edb61aa 6ad1272d-14b8-41d9-8267-7ce8c0b3b4e8 56b084bb-21df-4f23-9c90-02a5087f9642)
TS=(1783681361539 1783681476919 1783681779407 1783683296950)
SWEEP_SQL="$REPO_ROOT/migrations/20260713100000_admin-stats-and-payout-cleanup.sql"
SWEEP=$(awk '/^UPDATE public.organizer_withdrawal_requests w/,/;$/' "$SWEEP_SQL")
[ -n "$SWEEP" ] || die "could not extract the sweep statement from $SWEEP_SQL"

pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
for f in schema-representative-rewards.sql schema-live-payout-extras.sql schema-earnings-policies.sql live-money-functions.sql; do
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/$f" >/dev/null 2>&1
done
"${PSQL[@]}" -q -f - <"$REPO_ROOT/supabase/rollback/sources/complete_organizer_payout.prod-2026-10-30.sql" >/dev/null

"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, username, email) VALUES
  ('$ORG', 'user', true, 'Test organizer', 'testerboy', 'o@example.test'),
  ('$OTHER', 'user', false, 'Other', 'other', 'x@example.test'),
  ('$ADMIN', 'admin', false, 'Admin', 'admin1', 'a@example.test');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active)
VALUES ('$BANK', '$ORG', 'Test bank', '999992', '0000000000', 'TEST', 'RCP_t', true);
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo) VALUES ('$ORG', 60000, 40000, 100000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG', 'credit', 100000, 'sales');
SQL
for i in 0 1 2 3; do
  "${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, transfer_code, paystack_reference, created_at)
    VALUES ('${IDS[$i]}', '$ORG', 10000, 'processing', '$BANK', 'TRF_sm_$i', 'payout_${IDS[$i]}_${TS[$i]}', '2026-07-10 11:00:00+00');"
done

echo "== On production's code: the sweep reproduces the incident =="
expect_value "0205 refuses to run before 0202/0203" "$(apply_file "$MIG/0205_payout_cancelled_transfer_safety.sql" | grep -c 'apply 0202 first')" "1"
expect_ok "the July sweep (verbatim) runs on production's code" "$SWEEP"
expect_value "...and cancels all four in-flight paid transfers, moving nothing" \
  "$(val "SELECT count(*) FROM public.organizer_withdrawal_requests WHERE status = 'cancelled' AND transfer_code IS NOT NULL;")/$(val "SELECT balance_kobo || '/' || pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")" \
  "4/60000/40000"

echo "== 0201 -> 0202 -> 0203 -> 0205 =="
expect_value "0201 applies" "$(apply_file "$MIG/0201_vents_earn_representative_rewards.sql")" ""
expect_value "0202 applies" "$(apply_file "$MIG/0202_payout_engine_safety.sql" "SET vents.migration_local_test = 'on';")" ""
expect_value "0203 applies" "$(apply_file "$MIG/0203_earnings_policies.sql")" ""
SNAP_SQL="SELECT (SELECT string_agg(id || ':' || status || ':' || coalesce(transfer_code,''), ',' ORDER BY id) FROM public.organizer_withdrawal_requests) || '|' || (SELECT string_agg(organizer_id || ':' || balance_kobo || ':' || pending_kobo || ':' || total_withdrawn_kobo, ',') FROM public.organizer_wallets) || '|' || (SELECT count(*) FROM public.organizer_transactions);"
BEFORE=$(val "$SNAP_SQL")
expect_value "0205 applies (no md5 / body dependency on 0203)" "$(apply_file "$MIG/0205_payout_cancelled_transfer_safety.sql")" ""
expect_value "applying 0205 changed no request, wallet or ledger row" "$(val "$SNAP_SQL")" "$BEFORE"
expect_value "0205 is idempotent" "$(apply_file "$MIG/0205_payout_cancelled_transfer_safety.sql")" ""
expect_value "one guard, not two: 0202's transfer guard is replaced; the no-delete trigger exists" \
  "$(val "SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.organizer_withdrawal_requests'::regclass AND NOT tgisinternal AND tgname LIKE 'organizer_withdrawal%';")/$(val "SELECT count(*) FROM pg_proc WHERE proname = 'organizer_withdrawal_transfer_guard';")" \
  "organizer_withdrawal_requests_guard,organizer_withdrawal_requests_no_delete/0"
expect_value "complete_organizer_payout is untouched by 0205 (no [0205] marker)" \
  "$(val "SELECT (prosrc LIKE '%[0205]%')::text FROM pg_proc WHERE oid = 'public.complete_organizer_payout(text)'::regprocedure;")" "false"

echo "== Integrity report =="
expect_value "admins see the four incident requests: transfer on a cancelled request, funds not returned" \
  "$(val "$(as "$ADMIN" "SELECT count(*) FROM public.admin_payout_integrity_report() WHERE issue = 'transfer_on_cancelled_request_funds_not_returned';")")" "4"
expect_error "a non-admin cannot read it" "Admin access required" "$(as "$OTHER" "SELECT * FROM public.admin_payout_integrity_report();")"
expect_error "anon cannot execute it" "permission denied" "SET ROLE anon; SELECT * FROM public.admin_payout_integrity_report();"
expect_error "clients cannot call the guard or evidence helpers" "permission denied" \
  "$(as "$OTHER" "SELECT public.payout_cancel_returned_funds('${IDS[0]}');")"

echo "== The July sweep can no longer run =="
S1="00000000-0000-0000-0000-0000000005c1"; S2="00000000-0000-0000-0000-0000000005c2"; S3="00000000-0000-0000-0000-0000000005c3"
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, transfer_code, paystack_reference) VALUES
  ('$S1', '$ORG', 10000, 'processing', '$BANK', 'TRF_s1', 'payout_s1'),
  ('$S2', '$ORG', 10000, 'processing', '$BANK', NULL, 'payout_s2'),
  ('$S3', '$ORG', 10000, 'pending', '$BANK', NULL, NULL);"
expect_error "the verbatim sweep is refused (a Paystack transfer exists)" "a Paystack transfer exists" "$SWEEP"
expect_value "...atomically: nothing it touched changed" \
  "$(val "SELECT string_agg(status, ',' ORDER BY id) FROM public.organizer_withdrawal_requests WHERE id IN ('$S1', '$S2', '$S3');")" "processing,processing,pending"
expect_error "a processing request with only a reference (transfer may exist) cannot be cancelled" "may exist" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'cancelled' WHERE id = '$S2';"
expect_error "nor rejected" "may exist" "UPDATE public.organizer_withdrawal_requests SET status = 'rejected' WHERE id = '$S2';"
expect_error "a request with a transfer code cannot return to pending" "cannot be set to pending" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'pending' WHERE id = '$S1';"
expect_ok "a claim released before any transfer code (reference only) may return to pending, as admin_release_payout_claim does" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'pending' WHERE id = '$S2';"
expect_ok "a pending request without a transfer can still be cancelled or rejected" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'rejected' WHERE id = '$S3';"

echo "== Final states stay final =="
F="00000000-0000-0000-0000-00000005f0"
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id) VALUES
  ('${F}01', '$ORG', 100, 'failed', '$BANK'), ('${F}02', '$ORG', 100, 'rejected', '$BANK'), ('${F}03', '$ORG', 100, 'reversed', '$BANK'),
  ('${F}04', '$ORG', 100, 'completed', '$BANK'), ('${F}05', '$ORG', 100, 'cancelled', '$BANK'), ('${F}06', '$ORG', 100, 'completed', '$BANK'),
  ('${F}07', '$ORG', 100, 'pending', '$BANK');"
expect_error "failed -> processing is refused" "final status cannot change" "UPDATE public.organizer_withdrawal_requests SET status = 'processing' WHERE id = '${F}01';"
expect_error "rejected -> pending is refused" "final status cannot change" "UPDATE public.organizer_withdrawal_requests SET status = 'pending' WHERE id = '${F}02';"
expect_error "reversed -> completed is refused" "final status cannot change" "UPDATE public.organizer_withdrawal_requests SET status = 'completed' WHERE id = '${F}03';"
expect_error "completed -> failed is refused" "final status cannot change" "UPDATE public.organizer_withdrawal_requests SET status = 'failed' WHERE id = '${F}04';"
expect_error "cancelled -> pending is refused" "final status cannot change" "UPDATE public.organizer_withdrawal_requests SET status = 'pending' WHERE id = '${F}05';"
expect_error "pending -> reversed is refused" "only a completed request can be reversed" "UPDATE public.organizer_withdrawal_requests SET status = 'reversed' WHERE id = '${F}07';"
expect_ok "completed -> reversed is allowed (reverse_organizer_payout)" "UPDATE public.organizer_withdrawal_requests SET status = 'reversed' WHERE id = '${F}06';"
expect_ok "cancelled -> completed is allowed (a late Paystack success, complete_organizer_payout)" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'completed' WHERE id = '${F}05';"

echo "== Payout details are immutable =="
expect_error "the amount cannot change" "owner and amount cannot be changed" "UPDATE public.organizer_withdrawal_requests SET amount_kobo = 1 WHERE id = '$S1';"
expect_error "the owner cannot change" "owner and amount cannot be changed" "UPDATE public.organizer_withdrawal_requests SET organizer_id = '$OTHER' WHERE id = '$S1';"
expect_error "the transfer code cannot be cleared" "cannot be changed or cleared" "UPDATE public.organizer_withdrawal_requests SET transfer_code = NULL WHERE id = '$S1';"
expect_error "the reference cannot be changed" "cannot be changed or cleared" "UPDATE public.organizer_withdrawal_requests SET paystack_reference = 'payout_other' WHERE id = '$S2';"
expect_error "on an incident row too: its code cannot be cleared to hide it" "cannot be changed or cleared" \
  "UPDATE public.organizer_withdrawal_requests SET transfer_code = NULL WHERE id = '${IDS[3]}';"
expect_ok "the bank account link may still be nulled (ON DELETE SET NULL when a bank row is removed)" \
  "UPDATE public.organizer_withdrawal_requests SET bank_account_id = NULL WHERE id = '${F}04';"
expect_ok "admin notes and timestamps may change" "UPDATE public.organizer_withdrawal_requests SET admin_note = 'reviewed', updated_at = now() WHERE id = '$S1';"

echo "== Two-admin authorization cannot be forged or erased =="
FA="00000000-0000-0000-0000-0000000005fa"
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id) VALUES ('$FA', '$ORG', 100, 'pending', '$BANK');"
AQ=$(val "WITH x AS (INSERT INTO public.admin_action_requests (action_type, target_type, target_id, requested_by, payload) VALUES ('authorize_withdrawal', 'withdrawal', '$FA', '$OTHER', '{}') RETURNING id) SELECT id FROM x;")
expect_error "a raw UPDATE cannot record an authorization (no approving super admin session)" "can only be recorded by approve_admin_action" \
  "UPDATE public.organizer_withdrawal_requests SET approval_request_id = '$AQ', approval_requested_by = '$OTHER', approved_by = '$ADMIN', approved_at = now(), approved_recipient_code = 'RCP_t' WHERE id = '$FA';"
expect_error "...not even with a super admin session, if the requester is the approver" "can only be recorded by approve_admin_action" \
  "SET test.uid='$ADMIN'; UPDATE public.organizer_withdrawal_requests SET approval_request_id = '$AQ', approval_requested_by = '$ADMIN', approved_by = '$ADMIN', approved_at = now(), approved_recipient_code = 'RCP_t' WHERE id = '$FA';"
expect_error "...nor without a matching pending authorize_withdrawal request" "can only be recorded by approve_admin_action" \
  "SET test.uid='$ADMIN'; UPDATE public.organizer_withdrawal_requests SET approval_request_id = gen_random_uuid(), approval_requested_by = '$OTHER', approved_by = '$ADMIN', approved_at = now(), approved_recipient_code = 'RCP_t' WHERE id = '$FA';"
expect_error "a pending request cannot be moved to processing without authorization" "needs two-admin authorization" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'processing' WHERE id = '$FA';"
expect_ok "the approving super admin, for the request's own pending authorize_withdrawal, can record it (what execute_withdrawal_authorization does)" \
  "SET test.uid='$ADMIN'; UPDATE public.organizer_withdrawal_requests SET approval_request_id = '$AQ', approval_requested_by = '$OTHER', approved_by = '$ADMIN', approved_at = now(), approved_recipient_code = 'RCP_t' WHERE id = '$FA';"
expect_error "once recorded, the authorization cannot be cleared" "cannot be changed or cleared" \
  "UPDATE public.organizer_withdrawal_requests SET approved_by = NULL, approval_request_id = NULL, approval_requested_by = NULL, approved_at = NULL, approved_recipient_code = NULL WHERE id = '$FA';"
expect_error "...or re-pointed to another recipient" "cannot be changed or cleared" \
  "UPDATE public.organizer_withdrawal_requests SET approved_recipient_code = 'RCP_attacker' WHERE id = '$FA';"
expect_ok "an authorized pending request may move to processing (0203's claim)" "UPDATE public.organizer_withdrawal_requests SET status = 'processing', paystack_reference = 'payout_fa' WHERE id = '$FA';"

echo "== Payout history cannot be deleted =="
expect_error "a request with a transfer code cannot be deleted" "payout history" "DELETE FROM public.organizer_withdrawal_requests WHERE id = '${IDS[0]}';"
expect_error "a request with only a reference cannot be deleted" "payout history" "DELETE FROM public.organizer_withdrawal_requests WHERE id = '$S2';"
expect_error "a completed request cannot be deleted" "payout history" "DELETE FROM public.organizer_withdrawal_requests WHERE id = '${F}04';"
expect_error "a failed request cannot be deleted" "payout history" "DELETE FROM public.organizer_withdrawal_requests WHERE id = '${F}01';"
expect_ok "a rejected request that never reached Paystack can be deleted" "DELETE FROM public.organizer_withdrawal_requests WHERE id = '${F}02';"

echo "== Late Paystack success for an incident request, under 0205 =="
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET pending_kobo = 10000 WHERE organizer_id = '$ORG';"  # owed to the open S1
expect_value "complete_organizer_payout moves nothing and returns needs_review" \
  "$(val "SELECT status FROM public.complete_organizer_payout('payout_${IDS[0]}_${TS[0]}');")/$(val "SELECT balance_kobo || '/' || pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")/$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '${IDS[0]}';")" \
  "needs_review/60000/10000/cancelled"
expect_value "the integrity report now also shows the recorded exception" \
  "$(val "$(as "$ADMIN" "SELECT count(*) FROM public.admin_payout_integrity_report() WHERE request_id = '${IDS[0]}' AND issue = 'exception_paid_after_cancel_unresolved';")")" "1"
expect_value "a duplicate webhook adds nothing" \
  "$(val "SELECT status FROM public.complete_organizer_payout('TRF_sm_0');")/$(val "SELECT count(*) FROM public.payout_exceptions WHERE request_id = '${IDS[0]}';")" "needs_review/1"

echo "== Undo 0205 =="
UNDO="$REPO_ROOT/supabase/rollback/undo_0205.sql"
expect_value "undo refuses without explicit confirmation" "$(apply_file "$UNDO" | grep -c "undo_0205 refused")" "1"
expect_value "undo applies with confirmation" "$(apply_file "$UNDO" "SET vents.rollback_confirm = 'undo-0205';")" ""
expect_value "...restoring 0202's transfer guard and removing 0205's objects" \
  "$(val "SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.organizer_withdrawal_requests'::regclass AND NOT tgisinternal AND tgname LIKE 'organizer_withdrawal%';")/$(val "SELECT count(*) FROM pg_proc WHERE proname IN ('admin_payout_integrity_report', 'organizer_withdrawal_requests_guard', 'organizer_withdrawal_requests_no_delete', 'payout_cancel_returned_funds');")" \
  "organizer_withdrawal_transfer_guard/0"
expect_error "after undo the sweep is still refused (0202's guard)" "a Paystack transfer exists" "$SWEEP"
expect_value "undo moved no money" "$(val "SELECT balance_kobo || '/' || pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")" "60000/10000"
expect_value "0205 re-applies after undo" "$(apply_file "$MIG/0205_payout_cancelled_transfer_safety.sql")" ""

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES PAYOUT STATE MACHINE CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
