#!/usr/bin/env bash
# AZ-10 / D4 (P4): migration 0234, two-admin refund of payments captured
# without a ticket (ticket purchases and, through 0233, transfer fees).
#
#   request    admins and sub-admins can request; users can't; amount > 0 and
#              never above what Paystack captured; reason required; one at a
#              time;
#   approval   a different Super Admin approves in Admin Actions; requester,
#              sub-admins and users can't; double and concurrent approvals
#              give one approval; details changed after the request, an old
#              request or a rejected request are refused; both admins and
#              times are recorded;
#   execution  nothing can be sent to Paystack before approval; exactly one
#              claim (also concurrently); one refund id; a definitive Paystack
#              rejection is retryable with the same approvals;
#   webhook    refund.processed resolves the exception (idempotent);
#              refund.failed keeps it open and owed, and a new two-admin
#              request is needed;
#   hand close single-admin resolve can't close a refund in progress;
#   grants     webhook functions are server-only; list is admins-only;
#   migration  second-run refusal; approve_admin_action gains exactly one
#              branch; gated undo refuses mid-refund and restores the exact
#              previous functions and maker-checker.
#
# Paystack is never called: the refund API's calls are replayed as
# api/wallet/refund-ticket.ts makes them (start -> [Paystack] -> attach or
# revert), and the webhook's as api/webhook/paystack.ts makes them.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
UNDO="$REPO_ROOT/supabase/rollback/undo_0234.sql"
DB_NAME="vents_local_pg_payment_exception_refund"
SOCKET_DIR="/var/run/postgresql"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL BACKUP_DB_URL \
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
chmod 777 "$TMP"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ADMIN_A="00000000-0000-0000-0000-000000000b01"
ADMIN_B="00000000-0000-0000-0000-000000000b02"
SUB="00000000-0000-0000-0000-000000000b03"
ROOT="c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832"
USER="00000000-0000-0000-0000-000000000c01"
BUYER="00000000-0000-0000-0000-000000000c02"
ORG="00000000-0000-0000-0000-000000000a01"
EV="00000000-0000-0000-0000-0000000f0e01"

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
as_pa() { printf "SET ROLE project_admin; %s" "$1"; }
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
expect_error() {
  if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an exception, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error)"; cat "$ERR" >&2; fi
}
# shellcheck source=lib-money-stack.sh
. "$SCRIPT_DIR/lib-money-stack.sh"

new_exc() {  # new_exc <reference> <amount_kobo> -> id (a ticket payment captured with no matching order)
  val "$(as_pa "SELECT public.record_payment_exception('$1', NULL, 'not_found', 'sold out between paying and finalizing', $2, NULL, 'webhook');")"
}
request() { val "$(as "$1" "SELECT (public.admin_request_payment_exception_refund('$2', $3, \$r\$$4\$r\$))->>'id';")"; }
approve() { "${PSQL[@]}" -tA -c "$(as "$1" "SELECT (public.approve_admin_action('$2'))->>'status';")" 2>"$ERR" | tail -n1; }
state() { val "SELECT status || '/' || COALESCE(refund_status, '-') FROM public.payment_exceptions WHERE id = '$1';"; }
start() { val "$(as "$1" "SELECT public.start_payment_exception_refund('$2', 'refund')::text;")"; }

echo "== Building throwaway database $DB_NAME =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
build_ticket_stack
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email, username) VALUES
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test', 'admin_a'), ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test', 'admin_b'),
  ('$SUB', 'sub-admin', false, 'Sub', 's@example.test', 'sub'), ('$ROOT', 'admin', true, 'VENTS Admin', 'root@example.test', 'vents'),
  ('$USER', 'user', false, 'User', 'u@example.test', 'user'), ('$BUYER', 'user', false, 'Buyer', 'b@example.test', 'buyer'),
  ('$ORG', 'user', true, 'Org', 'o@example.test', 'org');
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EV', '$ORG', 'Refund night', now() + interval '20 days', 'live', '[{"name": "Regular", "price": 10000}]');
SQL
expect_ok "0233 applies (prerequisite)" "$(cat "$MIG/0233_transfer_fee_payment_attempts.sql")"
"${PSQL[@]}" -tA -c "SELECT pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);" > "$TMP/approve_pre"
"${PSQL[@]}" -tA -c "SELECT pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);" > "$TMP/request_pre"

echo "== Applying 0234 =="
expect_ok "0234 applies" "$(cat "$MIG/0234_payment_exception_two_admin_refund.sql")"
expect_error "0234 refuses a second run" "already applied" "$(cat "$MIG/0234_payment_exception_two_admin_refund.sql")"
"${PSQL[@]}" -tA -c "SELECT pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);" > "$TMP/approve_post"
expect_value "approve_admin_action gains exactly the one refund branch (2 lines), nothing else changes" \
  "$(diff "$TMP/approve_pre" "$TMP/approve_post" | grep -c '^>')/$(diff "$TMP/approve_pre" "$TMP/approve_post" | grep -c '^<' || true)" "2/0"

E1=$(new_exc VENTS-ref-0001 1000000)

echo "-- requesting --"
expect_error "an ordinary user can't request a refund" "Admin access required" "$(as "$USER" "SELECT public.admin_request_payment_exception_refund('$E1', 1000000, 'refund please');")"
expect_error "zero is refused" "greater than zero" "$(as "$SUB" "SELECT public.admin_request_payment_exception_refund('$E1', 0, 'refund please');")"
expect_error "more than Paystack captured is refused" "cannot exceed the amount Paystack captured" "$(as "$SUB" "SELECT public.admin_request_payment_exception_refund('$E1', 1000001, 'refund please');")"
expect_error "a reason is required" "reason of at least 5" "$(as "$SUB" "SELECT public.admin_request_payment_exception_refund('$E1', 1000000, 'no');")"
expect_error "nothing can be sent to Paystack before any approval" "not been approved by two admins" "$(as "$ROOT" "SELECT public.start_payment_exception_refund('$E1', 'x');")"
Q1=$(request "$SUB" "$E1" 1000000 "Sold out after payment; buyer asked for money back")
expect_value "a sub-admin files the request" "$(state "$E1")" "open/requested"
expect_value "it waits in Admin Actions" "$(val "SELECT status || '/' || action_type FROM public.admin_action_requests WHERE id = '$Q1';")" "pending/refund_payment_exception"
expect_error "a second request while one is waiting is refused" "already waiting for a second admin" \
  "$(as "$ADMIN_A" "SELECT public.admin_request_payment_exception_refund('$E1', 1000000, 'another request');")"
expect_error "still nothing can be sent to Paystack" "not been approved by two admins" "$(as "$ROOT" "SELECT public.start_payment_exception_refund('$E1', 'x');")"
expect_error "a single admin can't close it by hand while it waits" "in progress" "$(as "$ADMIN_A" "SELECT public.admin_resolve_payment_exception('$E1', 'refunded manually');")"

echo "-- approving --"
expect_error "a sub-admin can't approve" "Super Admin access required" "$(as "$SUB" "SELECT public.approve_admin_action('$Q1');")"
expect_error "an ordinary user can't approve" "Super Admin access required" "$(as "$USER" "SELECT public.approve_admin_action('$Q1');")"
E2=$(new_exc VENTS-ref-0002 500000)
Q2=$(request "$ADMIN_A" "$E2" 500000 "Amount mismatch refund")
expect_error "the requester can't approve their own refund" "Cannot approve your own request" "$(as "$ADMIN_A" "SELECT public.approve_admin_action('$Q2');")"
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_B" "BEGIN; SELECT (public.approve_admin_action('$Q1'))->>'status'; SELECT pg_sleep(1.5); COMMIT;")" >"$TMP/a1" 2>&1 || true ) &
sleep 0.4
( "${PSQL[@]}" -tA -c "$(as "$ROOT" "SELECT (public.approve_admin_action('$Q1'))->>'status';")" >"$TMP/a2" 2>&1 || true ) &
wait
expect_value "two Super Admins approving at once: exactly one approval" "$(cat "$TMP/a1" "$TMP/a2" | grep -c '^approved$' || true)" "1"
expect_value "...the other is refused as already approved" "$(cat "$TMP/a1" "$TMP/a2" | grep -c 'Request already approved' || true)" "1"
expect_value "the exception is approved" "$(state "$E1")" "open/approved"
expect_value "both admins and times are recorded" \
  "$(val "SELECT (refund_requested_by = '$SUB')::text || '/' || (refund_approved_by = '$ADMIN_B')::text || '/' || (refund_requested_at IS NOT NULL AND refund_approved_at IS NOT NULL)::text || '/' || refund_amount_kobo FROM public.payment_exceptions WHERE id = '$E1';")" \
  "true/true/true/1000000"
expect_error "a duplicate approval is refused" "Request already approved" "$(as "$ROOT" "SELECT public.approve_admin_action('$Q1');")"
"${PSQL[@]}" -q -c "UPDATE public.payment_exceptions SET refund_amount_kobo = 400000 WHERE id = '$E2';"
expect_error "details changed after the request are refused at approval" "changed after the request" "$(as "$ADMIN_B" "SELECT public.approve_admin_action('$Q2');")"
expect_value "...and nothing is approved" "$(state "$E2")" "open/requested"
"${PSQL[@]}" -q -c "UPDATE public.payment_exceptions SET refund_amount_kobo = 500000 WHERE id = '$E2'; UPDATE public.admin_action_requests SET requested_at = now() - interval '8 days' WHERE id = '$Q2';"
expect_error "a request older than 7 days can't be approved" "older than 7 days" "$(as "$ADMIN_B" "SELECT public.approve_admin_action('$Q2');")"
"${PSQL[@]}" -q -c "$(as "$ADMIN_B" "SELECT public.reject_admin_action('$Q2', 'old request');")" 2>/dev/null || \
  "${PSQL[@]}" -q -c "UPDATE public.admin_action_requests SET status = 'rejected' WHERE id = '$Q2';"
expect_value "the admin list shows the request was rejected" \
  "$(val "$(as "$SUB" "SELECT refund_status || '/' || refund_request_status FROM public.admin_list_payment_exceptions('open', 50, 0) WHERE id = '$E2';")")" "requested/rejected"
expect_ok "a rejected request no longer blocks closing it by hand (checked in a rolled-back transaction)" \
  "BEGIN; $(as "$ADMIN_B" "SELECT public.admin_resolve_payment_exception('$E2', 'checking the rule only');") ROLLBACK;"
Q2B=$(request "$ADMIN_A" "$E2" 500000 "Amount mismatch refund, refiled")
expect_value "after the second admin rejects, a new request can be filed" "$(state "$E2")/$(val "SELECT status FROM public.admin_action_requests WHERE id = '$Q2B';")" "open/requested/pending"

echo "-- sending to Paystack and the webhook --"
expect_error "an ordinary user can't send it" "Super Admin access required" "$(as "$USER" "SELECT public.start_payment_exception_refund('$E1', 'x');")"
expect_error "a sub-admin can't send it" "Super Admin access required" "$(as "$SUB" "SELECT public.start_payment_exception_refund('$E1', 'x');")"
( "${PSQL[@]}" -tA -c "$(as "$ROOT" "BEGIN; SELECT public.start_payment_exception_refund('$E1', 'x')->>'status'; SELECT pg_sleep(1.5); COMMIT;")" >"$TMP/s1" 2>&1 || true ) &
sleep 0.4
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_A" "SELECT public.start_payment_exception_refund('$E1', 'x')->>'status';")" >"$TMP/s2" 2>&1 || true ) &
wait
expect_value "two clicks on 'Send refund': exactly one claim" "$(cat "$TMP/s1" "$TMP/s2" | grep -c '^refund_pending$' || true)" "1"
expect_value "...the other is refused" "$(cat "$TMP/s1" "$TMP/s2" | grep -c 'already sent to Paystack' || true)" "1"
expect_value "the claim carries exactly the approved amount and the captured reference" \
  "$(val "SELECT refund_status || '/' || refund_amount_kobo FROM public.payment_exceptions WHERE id = '$E1';")" "refund_pending/1000000"
expect_ok "the Paystack refund id is recorded" "$(as "$ROOT" "SELECT public.attach_payment_exception_refund_id('$E1', 'RF_E1');")"
expect_error "a second refund id is refused" "No refund in flight without an id" "$(as "$ROOT" "SELECT public.attach_payment_exception_refund_id('$E1', 'RF_OTHER');")"
expect_error "a refund with an id can't be reverted by hand" "Only a refund in flight without a Paystack refund id" "$(as "$ROOT" "SELECT public.admin_revert_payment_exception_refund('$E1', 'x');")"
expect_value "refund.processed resolves the exception" "$(val "$(as_pa "SELECT status FROM public.finalize_payment_exception_refund('RF_E1');")")" "finalized"
expect_value "...status resolved/refunded" "$(state "$E1")" "resolved/refunded"
expect_value "...with both admins in the resolution note" "$(val "SELECT (resolution_note LIKE '%$SUB%' AND resolution_note LIKE '%$ADMIN_B%')::text FROM public.payment_exceptions WHERE id = '$E1';")" "true"
expect_value "a webhook replay is idempotent" "$(val "$(as_pa "SELECT status FROM public.finalize_payment_exception_refund('RF_E1');")")" "already_finalized"
expect_value "an unrelated refund id is not found (webhook moves on)" "$(val "$(as_pa "SELECT status FROM public.finalize_payment_exception_refund('RF_unknown');")")" "not_found"
expect_value "the refunded exception can't start again" "$(start "$ROOT" "$E1" | jq -r '.status')" "already_refunded"

echo "-- definitive Paystack rejection, then refund.failed --"
expect_value "second admin approves E2" "$(approve "$ADMIN_B" "$Q2B")" "approved"
expect_value "claim" "$(start "$ROOT" "$E2" | jq -r '.status')" "refund_pending"
expect_ok "Paystack rejects outright: the route reverts the claim" "$(as "$ROOT" "SELECT public.admin_revert_payment_exception_refund('$E2', 'Paystack: insufficient balance');")"
expect_value "back to approved, retryable with the same approvals" "$(state "$E2")" "open/approved"
expect_value "retry claims again" "$(start "$ROOT" "$E2" | jq -r '.status')" "refund_pending"
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.attach_payment_exception_refund_id('$E2', 'RF_E2');")"
expect_value "refund.failed is recorded" "$(val "$(as_pa "SELECT public.fail_payment_exception_refund('RF_E2', 'bank rejected');")")" "failed_recorded"
expect_value "the exception stays open and owed" "$(state "$E2")" "open/refund_failed"
expect_value "the failure is logged for admins" "$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'payment_exception_refund_failed' AND details->>'refund_id' = 'RF_E2';")" "1"
expect_error "a failed refund can't be re-sent without new approvals" "not been approved by two admins" "$(as "$ROOT" "SELECT public.start_payment_exception_refund('$E2', 'x');")"
Q2C=$(request "$SUB" "$E2" 500000 "Retry after the bank rejected it")
expect_value "a new request can be filed after a failed refund" "$(state "$E2")" "open/requested"
expect_value "and needs a new second approval" "$(approve "$ADMIN_A" "$Q2C")" "approved"

echo "-- transfer-fee duplicate (0233) goes through the same flow --"
"${PSQL[@]}" -q -c "SELECT public.record_transfer_fee_payment_exception('txf_dup0001', NULL, 'duplicate_payment', 75000, 75000, 'second payment');"
E3=$(val "SELECT id FROM public.payment_exceptions WHERE reference = 'txf_dup0001';")
Q3=$(request "$ADMIN_A" "$E3" 75000 "Duplicate transfer fee")
expect_value "transfer-fee duplicate approved by a second admin" "$(approve "$ROOT" "$Q3")/$(state "$E3")" "approved/open/approved"

echo "-- list and grants --"
expect_value "admins see kind and refund state" \
  "$(val "$(as "$SUB" "SELECT kind || '/' || refund_status || '/' || refund_requested_by_name || '/' || refund_approved_by_name FROM public.admin_list_payment_exceptions('resolved', 10, 0) WHERE id = '$E1';")")" \
  "ticket_purchase/refunded/sub/admin_b"
expect_error "users can't list exceptions" "Admin access required" "$(as "$USER" "SELECT count(*) FROM public.admin_list_payment_exceptions('open', 10, 0);")"
expect_error "signed-in users can't call the webhook's finalize" "permission denied" "$(as "$ROOT" "SELECT * FROM public.finalize_payment_exception_refund('RF_x');")"
expect_error "signed-in users can't call the webhook's fail" "permission denied" "$(as "$ROOT" "SELECT public.fail_payment_exception_refund('RF_x', 'x');")"
expect_error "nobody can call the executor directly" "permission denied" "$(as "$ROOT" "SELECT public.execute_payment_exception_refund_approval('$Q1');")"
expect_error "the table stays closed to clients" "permission denied" "$(as "$ROOT" "SELECT count(*) FROM public.payment_exceptions;")"

echo "-- single-admin resolve still works when no refund is involved --"
E4=$(new_exc VENTS-ref-0004 20000)
expect_ok "a Super Admin records a no-refund resolution" "$(as "$ADMIN_A" "SELECT public.admin_resolve_payment_exception('$E4', 'Paystack shows it was reversed by the bank');")"

echo "-- undo --"
expect_error "undo refuses without the gate" "Refusing" "$(cat "$UNDO")"
expect_error "undo refuses while a refund is approved" "approved or in flight" "SET vents.rollback_confirm = 'undo-0234'; $(cat "$UNDO")"
"${PSQL[@]}" -q -c "UPDATE public.payment_exceptions SET refund_status = 'refund_failed' WHERE refund_status IN ('approved', 'refund_pending');"
expect_ok "undo runs once no refund is mid-flight" "SET vents.rollback_confirm = 'undo-0234'; $(cat "$UNDO")"
"${PSQL[@]}" -tA -c "SELECT pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);" > "$TMP/approve_undo"
"${PSQL[@]}" -tA -c "SELECT pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);" > "$TMP/request_undo"
expect_value "undo restores the maker-checker exactly" "$(cmp -s "$TMP/approve_pre" "$TMP/approve_undo" && cmp -s "$TMP/request_pre" "$TMP/request_undo" && echo same)" "same"
expect_value "undo restores 0226's list and resolve exactly" \
  "$(val "SELECT string_agg(proname || '=' || md5(replace(prosrc, E'\r', '')), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admin_list_payment_exceptions', 'admin_resolve_payment_exception');")" \
  "admin_list_payment_exceptions=9e7cb373db3327cd27443bba4b729987,admin_resolve_payment_exception=87be17ca4555c4a1a53792aa991b1af1"
expect_ok "0234 re-applies after undo" "$(cat "$MIG/0234_payment_exception_two_admin_refund.sql")"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES PAYMENT EXCEPTION REFUND CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
