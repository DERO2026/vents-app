#!/usr/bin/env bash
# 0238: transfer-fee refunds follow the two-admin rule (owner, 2026-11-27).
#
#   baseline  before 0238 a paid fee on a transfer that can't complete is
#             claimed for an AUTOMATIC refund (':refund_claimed');
#   queue     after 0238 the same cases (cancelled/declined, expired, ticket
#             no longer eligible) record a payment exception for the exact
#             reference and amount charged, mark the transfer
#             'awaiting_approval', and never claim an automatic refund;
#             replays add nothing; a second payment is a duplicate;
#   approval  one admin requests, a DIFFERENT Super Admin approves; the
#             requester can't approve; no approval twice; nothing goes to
#             Paystack before approval; amount never above what was charged;
#   execution claimed once; refund.processed closes the exception, marks the
#             transfer refunded and tells the recipient once; refund.failed
#             keeps it owed and traceable on both records; a retry needs new
#             approvals;
#   backfill  automatic refunds that never started or failed are queued;
#             refunds already in flight at Paystack are left alone;
#   migration second-run refusal; gated undo restores the exact previous
#             functions; re-apply.
#
# Paystack is never called: the route's and webhook's database calls are
# replayed exactly as api/wallet/refund-ticket.ts and api/webhook/paystack.ts
# make them.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
UNDO="$REPO_ROOT/supabase/rollback/undo_0238.sql"
DB_NAME="vents_local_pg_transfer_fee_refund_two_admin"
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

ORG="00000000-0000-0000-0000-000000000a01"
SENDER="00000000-0000-0000-0000-000000000e01"
RECIP="00000000-0000-0000-0000-000000000e02"
ADMIN_A="00000000-0000-0000-0000-000000000b01"
ADMIN_B="00000000-0000-0000-0000-000000000b02"
SUB="00000000-0000-0000-0000-000000000b03"
USER="00000000-0000-0000-0000-000000000c01"
EV="00000000-0000-0000-0000-0000000f0e01"
FEE=75000

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

new_transfer() {  # new_transfer [expires interval] -> transfer id (fresh ticket owned by SENDER)
  local tk tr; tk=$(cat /proc/sys/kernel/random/uuid); tr=$(cat /proc/sys/kernel/random/uuid)
  "${PSQL[@]}" -q -c "INSERT INTO public.tickets (id, event_id, user_id, quantity, status, payment_status, amount, ticket_type, payment_ref)
                      VALUES ('$tk', '$EV', '$SENDER', 1, 'active', 'paid', 10000, 'Regular', 'pay_' || '$tk');
                      INSERT INTO public.ticket_transfers (id, ticket_id, from_user_id, to_user_id, to_identifier, status, expires_at, fee_kobo)
                      VALUES ('$tr', '$tk', '$SENDER', '$RECIP', 'recip', 'pending', now() + interval '${1:-2 days}', $FEE);"
  echo "$tr"
}
init() { val "$(as "$RECIP" "SELECT public.initiate_transfer_fee_payment('$1')->>'reference';")"; }
confirm() { val "$(as_pa "SELECT public.confirm_transfer_fee_payment('$1', ${2:-$FEE});")"; }
xstate() { val "SELECT kind || '/' || reason || '/' || amount_kobo || '/' || status || '/' || COALESCE(refund_status, '-') FROM public.payment_exceptions WHERE reference = '$1';"; }
xid() { val "SELECT id FROM public.payment_exceptions WHERE reference = '$1';"; }
tstate() { val "SELECT status || '/' || COALESCE(fee_refund_status, '-') FROM public.ticket_transfers WHERE id = '$1';"; }
request() { val "$(as "$1" "SELECT (public.admin_request_payment_exception_refund('$2', $3, \$r\$$4\$r\$))->>'id';")"; }
approve() { "${PSQL[@]}" -tA -c "$(as "$1" "SELECT (public.approve_admin_action('$2'))->>'status';")" 2>"$ERR" | tail -n1; }
start() { val "$(as "$1" "SELECT public.start_payment_exception_refund('$2', 'refund')->>'status';")"; }

echo "== Building throwaway database $DB_NAME =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
build_ticket_stack
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email, username) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test', 'org'), ('$SENDER', 'user', false, 'Sender', 's@example.test', 'sender'),
  ('$RECIP', 'user', false, 'Recipient', 'r@example.test', 'recip'), ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test', 'admin_a'),
  ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test', 'admin_b'), ('$SUB', 'sub-admin', false, 'Sub', 'sub@example.test', 'sub'),
  ('$USER', 'user', false, 'User', 'u@example.test', 'user');
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EV', '$ORG', 'Transfer night', now() + interval '20 days', 'live', '[{"name": "Regular", "price": 10000}]');
SQL
expect_ok "0233 applies (prerequisite)" "$(cat "$MIG/0233_transfer_fee_payment_attempts.sql")"
expect_ok "0234 applies (prerequisite)" "$(cat "$MIG/0234_payment_exception_two_admin_refund.sql")"
PRE_MD5="SELECT string_agg(proname || '=' || md5(replace(prosrc, E'\r', '')), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('confirm_transfer_fee_payment', 'finalize_payment_exception_refund', 'fail_payment_exception_refund');"
BEFORE_MD5=$(val "$PRE_MD5")

echo "-- baseline (before 0238): automatic refund --"
T0=$(new_transfer); A0=$(init "$T0"); "${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'cancelled' WHERE id = '$T0';"
expect_value "BEFORE: a paid fee on a cancelled transfer is claimed for an automatic refund" "$(confirm "$A0")" "transfer_not_pending:cancelled:refund_claimed"
# Legacy states the backfill must handle (as 0064's webhook functions leave them):
TN=$(new_transfer); AN=$(init "$TN"); "${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'cancelled' WHERE id = '$TN';"; confirm "$AN" >/dev/null   # 'needed', refund never started
TF=$(new_transfer); AF=$(init "$TF"); "${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'cancelled' WHERE id = '$TF';"; confirm "$AF" >/dev/null
"${PSQL[@]}" -q -c "$(as_pa "SELECT public.mark_transfer_fee_refund_initiation_failed('$AF', 'Paystack said no');")"                                        # 'failed'
TP=$(new_transfer); AP=$(init "$TP"); "${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'cancelled' WHERE id = '$TP';"; confirm "$AP" >/dev/null
"${PSQL[@]}" -q -c "$(as_pa "SELECT public.attach_transfer_fee_refund_id('$AP', 'RF_INFLIGHT');")"                                                         # 'processing'

echo "== Applying 0238 =="
expect_ok "0238 applies" "$(cat "$MIG/0238_transfer_fee_refunds_two_admin.sql")"
expect_error "0238 refuses a second run" "already applied" "$(cat "$MIG/0238_transfer_fee_refunds_two_admin.sql")"
expect_value "the confirm function can no longer claim an automatic refund" \
  "$(val "SELECT position(':refund_claimed' IN prosrc) FROM pg_proc WHERE oid = 'public.confirm_transfer_fee_payment(text,bigint)'::regprocedure;")" "0"

echo "-- backfill --"
expect_value "a refund that never started is queued for two admins" "$(xstate "$AN")/$(tstate "$TN")" "ticket_transfer_fee/transfer_not_completed/$FEE/open/-/cancelled/awaiting_approval"
expect_value "a refund whose initiation failed is queued too" "$(xstate "$AF")/$(tstate "$TF")" "ticket_transfer_fee/transfer_not_completed/$FEE/open/-/cancelled/awaiting_approval"
expect_value "the baseline transfer's never-started automatic refund is queued as well" "$(xstate "$A0")/$(tstate "$T0")" "ticket_transfer_fee/transfer_not_completed/$FEE/open/-/cancelled/awaiting_approval"
expect_value "a refund already in flight at Paystack is left alone" "$(val "SELECT count(*) FROM public.payment_exceptions WHERE reference = '$AP';")/$(tstate "$TP")" "0/cancelled/processing"
expect_value "...and still finishes through 0064's webhook function" "$(val "$(as_pa "SELECT status FROM public.finalize_transfer_fee_refund('RF_INFLIGHT');")")" "finalized"

echo "-- the three situations now queue a two-admin refund --"
T1=$(new_transfer); A1=$(init "$T1"); B1=$(init "$T1")
"${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'cancelled', responded_at = now() WHERE id = '$T1';"
expect_value "sender cancelled: the earlier attempt's late payment is queued, not auto-refunded" "$(confirm "$A1")" "transfer_not_pending:cancelled:refund_queued"
expect_value "exception for the exact reference and amount charged; transfer awaiting approval" "$(xstate "$A1")/$(tstate "$T1")" "ticket_transfer_fee/transfer_not_completed/$FEE/open/-/cancelled/awaiting_approval"
expect_value "a webhook replay adds nothing (no suffix, same single exception)" "$(confirm "$A1")/$(val "SELECT seen_count FROM public.payment_exceptions WHERE reference = '$A1';")" "transfer_not_pending:cancelled/1"
expect_value "a second payment on it is a duplicate (separate exception)" "$(confirm "$B1")/$(xstate "$B1")" "duplicate_payment/ticket_transfer_fee/duplicate_payment/$FEE/open/-"
T2=$(new_transfer '1 second'); A2=$(init "$T2"); "${PSQL[@]}" -q -c "SELECT pg_sleep(1.2);"
expect_value "expired: queued" "$(confirm "$A2")/$(xstate "$A2")" "expired:refund_queued/ticket_transfer_fee/transfer_not_completed/$FEE/open/-"
T3=$(new_transfer); A3=$(init "$T3")
"${PSQL[@]}" -q -c "UPDATE public.tickets SET checked_in = true WHERE id = (SELECT ticket_id FROM public.ticket_transfers WHERE id = '$T3');"
expect_value "ticket no longer eligible (already scanned): queued, ticket stays with the sender" \
  "$(confirm "$A3")/$(val "SELECT k.user_id FROM public.tickets k JOIN public.ticket_transfers t ON t.ticket_id = k.id WHERE t.id = '$T3';")" "ticket_ineligible:refund_queued/$SENDER"
expect_value "no automatic-refund bookkeeping was started for any of them" \
  "$(val "SELECT count(*) FROM public.ticket_transfers WHERE id IN ('$T1', '$T2', '$T3') AND (fee_refund_id IS NOT NULL OR fee_refund_status IN ('needed', 'processing'));")" "0"
expect_value "a normal transfer still completes" "$(T9=$(new_transfer); A9=$(init "$T9"); confirm "$A9")" "confirmed"

echo "-- two different admins, then Paystack once --"
X1=$(xid "$A1")
expect_error "nothing goes to Paystack before approval" "not been approved by two admins" "$(as "$ADMIN_A" "SELECT public.start_payment_exception_refund('$X1', 'x');")"
expect_error "an ordinary user can't request it" "Admin access required" "$(as "$USER" "SELECT public.admin_request_payment_exception_refund('$X1', $FEE, 'refund it');")"
expect_error "more than the recipient paid can't be requested" "cannot exceed the amount Paystack captured" "$(as "$SUB" "SELECT public.admin_request_payment_exception_refund('$X1', $((FEE + 1)), 'refund it');")"
Q1=$(request "$SUB" "$X1" "$FEE" "Transfer cancelled after the fee was paid")
expect_error "the requesting sub-admin can't approve (sub-admins never approve)" "Super Admin access required" "$(as "$SUB" "SELECT public.approve_admin_action('$Q1');")"
Q1B=$(request "$ADMIN_A" "$(xid "$A2")" "$FEE" "Expired transfer refund")
expect_error "...nor can a Super Admin who requested approve their own" "Cannot approve your own request" "$(as "$ADMIN_A" "SELECT public.approve_admin_action('$Q1B');")"
expect_value "a different Super Admin approves" "$(approve "$ADMIN_A" "$Q1")" "approved"
expect_error "the same approval can't be given twice" "Request already approved" "$(as "$ADMIN_B" "SELECT public.approve_admin_action('$Q1');")"
expect_value "both admins recorded, bound to the charged reference and amount" \
  "$(val "SELECT (refund_requested_by = '$SUB')::text || '/' || (refund_approved_by = '$ADMIN_A')::text || '/' || reference || '/' || refund_amount_kobo FROM public.payment_exceptions WHERE id = '$X1';")" "true/true/$A1/$FEE"
expect_value "a Super Admin sends it" "$(start "$ADMIN_B" "$X1")" "refund_pending"
expect_error "a second send is refused (no duplicate Paystack refund)" "already sent to Paystack" "$(as "$ADMIN_A" "SELECT public.start_payment_exception_refund('$X1', 'x');")"
"${PSQL[@]}" -q -c "$(as "$ADMIN_B" "SELECT public.attach_payment_exception_refund_id('$X1', 'RF_X1');")"
expect_value "refund.processed closes the exception" "$(val "$(as_pa "SELECT status FROM public.finalize_payment_exception_refund('RF_X1');")")/$(xstate "$A1")" "finalized/ticket_transfer_fee/transfer_not_completed/$FEE/resolved/refunded"
expect_value "...marks the transfer refunded" "$(tstate "$T1")" "cancelled/refunded"
expect_value "...and tells the recipient once" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$RECIP' AND title = 'Transfer fee refunded' AND push_data->>'transferId' = '$T1';")" "1"
expect_value "a refund.processed replay changes nothing" \
  "$(val "$(as_pa "SELECT status FROM public.finalize_payment_exception_refund('RF_X1');")")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$RECIP' AND title = 'Transfer fee refunded' AND push_data->>'transferId' = '$T1';")" "already_finalized/1"

echo "-- refund failure stays traceable and needs new approvals --"
XN=$(xid "$AN")
QN=$(request "$SUB" "$XN" "$FEE" "Backfilled refund")
approve "$ADMIN_B" "$QN" >/dev/null
start "$ADMIN_A" "$XN" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.attach_payment_exception_refund_id('$XN', 'RF_XN');")"
expect_value "refund.failed is recorded on the exception and the transfer" \
  "$(val "$(as_pa "SELECT public.fail_payment_exception_refund('RF_XN', 'bank rejected');")")/$(xstate "$AN")/$(tstate "$TN")" "failed_recorded/ticket_transfer_fee/transfer_not_completed/$FEE/open/refund_failed/cancelled/failed"
expect_error "it can't be re-sent without new approvals" "not been approved by two admins" "$(as "$ADMIN_A" "SELECT public.start_payment_exception_refund('$XN', 'x');")"
QN2=$(request "$ADMIN_A" "$XN" "$FEE" "Retry after bank rejection")
expect_value "a new request needs a new, different second admin" "$(approve "$ADMIN_B" "$QN2")" "approved"

echo "-- undo --"
expect_error "undo_0234 refuses while 0238 is applied (reverse order only)" "0238 is still applied" \
  "SET vents.rollback_confirm = 'undo-0234'; $(cat "$REPO_ROOT/supabase/rollback/undo_0234.sql")"
expect_error "undo_0233 refuses while 0234 is applied (reverse order only)" "0234 is still applied" \
  "SET vents.rollback_confirm = 'undo-0233'; $(cat "$REPO_ROOT/supabase/rollback/undo_0233.sql")"
expect_error "undo refuses without the gate" "Refusing" "$(cat "$UNDO")"
expect_ok "undo runs with the gate" "SET vents.rollback_confirm = 'undo-0238'; $(cat "$UNDO")"
expect_value "undo restores the exact previous functions" "$(val "$PRE_MD5")" "$BEFORE_MD5"
expect_value "the owed refunds stay in the queue after undo" "$(val "SELECT count(*) FROM public.payment_exceptions WHERE reason = 'transfer_not_completed' AND status = 'open';")" "5"
expect_ok "0238 re-applies after undo" "$(cat "$MIG/0238_transfer_fee_refunds_two_admin.sql")"
expect_value "...and is back in force" "$(val "SELECT position('[0238]' IN prosrc) > 0 FROM pg_proc WHERE oid = 'public.confirm_transfer_fee_payment(text,bigint)'::regprocedure;")" "t"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES TRANSFER FEE TWO-ADMIN REFUND CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
