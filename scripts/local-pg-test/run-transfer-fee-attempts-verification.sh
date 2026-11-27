#!/usr/bin/env bash
# AZ-08: migration 0233 (ticket-transfer fee payment attempts).
#
#   baseline   before 0233, a retry overwrites the earlier reference and a
#              late payment of the earlier attempt is matched to nothing
#              (reproduced, so the suite proves the bug it fixes);
#   attempts   every reference is kept; the owner check works for any
#              attempt; backfill of existing references;
#   late       an earlier attempt paying after a retry confirms the transfer;
#   duplicate  a second successful payment (either order) never moves the
#              ticket again and is recorded once as a payment exception for
#              the two-admin refund; webhook replays are idempotent;
#   unknown    an unknown 'txf_' reference is recorded, nothing else is;
#   amount     a wrong amount is recorded and never applied;
#   refunds    a late payment on a cancelled or expired transfer still gets
#              the existing automatic refund, keyed to the reference that
#              paid; refund initiation failure and refund failure are kept;
#   race       two payments confirmed concurrently: one transfer, one
#              duplicate, one ownership change;
#   grants     clients can't read attempts or call the helper;
#   migration  drift and second-run refusals; gated undo restores the exact
#              previous functions and refuses while exceptions exist.
#
# Paystack is never called: confirm_transfer_fee_payment is invoked exactly
# as api/webhook/paystack.ts invokes it after Paystack reports success.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
UNDO="$REPO_ROOT/supabase/rollback/undo_0233.sql"
DB_NAME="vents_local_pg_transfer_fee_attempts"
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
OTHER="00000000-0000-0000-0000-000000000e03"
EV="00000000-0000-0000-0000-0000000f0e01"
FEE=75000   # 7.5% of a 10,000 naira ticket, in kobo

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

new_transfer() {  # new_transfer <status> [expires interval] -> transfer id (fresh ticket owned by SENDER)
  local tk tr; tk=$(cat /proc/sys/kernel/random/uuid); tr=$(cat /proc/sys/kernel/random/uuid)
  "${PSQL[@]}" -q -c "INSERT INTO public.tickets (id, event_id, user_id, quantity, status, payment_status, amount, ticket_type, payment_ref)
                      VALUES ('$tk', '$EV', '$SENDER', 1, 'active', 'paid', 10000, 'Regular', 'pay_' || '$tk');
                      INSERT INTO public.ticket_transfers (id, ticket_id, from_user_id, to_user_id, to_identifier, status, expires_at, fee_kobo)
                      VALUES ('$tr', '$tk', '$SENDER', '$RECIP', 'recip', '$1', now() + interval '${2:-2 days}', $FEE);"
  echo "$tr"
}
init() { val "$(as "$RECIP" "SELECT public.initiate_transfer_fee_payment('$1')->>'reference';")"; }
confirm() { val "$(as_pa "SELECT public.confirm_transfer_fee_payment('$1', ${2:-$FEE});")"; }
owner_of() { val "SELECT k.user_id FROM public.tickets k JOIN public.ticket_transfers t ON t.ticket_id = k.id WHERE t.id = '$1';"; }
exc() { val "SELECT kind || '/' || reason || '/' || amount_kobo || '/' || COALESCE(transfer_id::text, '-') || '/' || seen_count FROM public.payment_exceptions WHERE reference = '$1';"; }

echo "== Building throwaway database $DB_NAME =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
build_ticket_stack
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test'), ('$SENDER', 'user', false, 'Sender', 's@example.test'),
  ('$RECIP', 'user', false, 'Recipient', 'r@example.test'), ('$OTHER', 'user', false, 'Other', 'o@example.test');
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EV', '$ORG', 'Transfer night', now() + interval '20 days', 'live', '[{"name": "Regular", "price": 10000}]');
SQL

echo "-- baseline (before 0233): the bug --"
T0=$(new_transfer pending)
A0=$(init "$T0"); B0=$(init "$T0")
expect_value "a retry overwrites the earlier reference" "$(val "SELECT fee_payment_ref FROM public.ticket_transfers WHERE id = '$T0';")" "$B0"
expect_value "BUG REPRODUCED: the earlier attempt's late payment matches nothing" "$(confirm "$A0")" "not_found"
expect_value "BUG REPRODUCED: ...and is recorded nowhere" "$(val "SELECT count(*) FROM public.payment_exceptions;")" "0"
T_OLD=$(new_transfer pending); A_OLD=$(init "$T_OLD")   # an existing reference to backfill

echo "== Applying 0233 =="
expect_ok "0233 applies" "$(cat "$MIG/0233_transfer_fee_payment_attempts.sql")"
expect_error "0233 refuses a second run" "already applied" "$(cat "$MIG/0233_transfer_fee_payment_attempts.sql")"
expect_value "existing references are backfilled as attempts" \
  "$(val "SELECT count(*) FROM public.ticket_transfer_fee_attempts WHERE reference IN ('$B0', '$A_OLD');")" "2"

echo "-- late payment of an earlier attempt --"
T1=$(new_transfer pending)
A1=$(init "$T1"); B1=$(init "$T1")
expect_value "both attempts are kept" "$(val "SELECT count(*) FROM public.ticket_transfer_fee_attempts WHERE transfer_id = '$T1';")" "2"
expect_value "the owner check works for the earlier attempt" "$(val "$(as_pa "SELECT public.get_transfer_fee_payment_owner('$A1');")")" "$RECIP"
expect_value "the earlier attempt, paid late, confirms the transfer" "$(confirm "$A1")" "confirmed"
expect_value "ticket now belongs to the recipient" "$(owner_of "$T1")" "$RECIP"
expect_value "fee_payment_ref follows the reference that paid" "$(val "SELECT fee_payment_ref FROM public.ticket_transfers WHERE id = '$T1';")" "$A1"
expect_value "the newer attempt, also paid, is a duplicate" "$(confirm "$B1")" "duplicate_payment"
expect_value "the ticket did not move again" "$(owner_of "$T1")" "$RECIP"
expect_value "the duplicate is recorded for a two-admin refund" "$(exc "$B1")" "ticket_transfer_fee/duplicate_payment/$FEE/$T1/1"
expect_value "a webhook replay of the duplicate stays idempotent" "$(confirm "$B1")" "duplicate_payment"
expect_value "...one exception row, seen twice" "$(exc "$B1")" "ticket_transfer_fee/duplicate_payment/$FEE/$T1/2"
expect_value "...one admin log entry" "$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'transfer_fee_payment_exception' AND details->>'paystack_reference' = '$B1';")" "1"
expect_value "a replay of the paying reference is unchanged ('already_paid')" "$(confirm "$A1")" "already_paid"
expect_value "attempt outcomes recorded" "$(val "SELECT string_agg(outcome, ',' ORDER BY outcome) FROM public.ticket_transfer_fee_attempts WHERE transfer_id = '$T1';")" "duplicate,paid"
expect_value "exactly one acceptance notification" "$(val "SELECT count(*) FROM public.notifications WHERE push_data->>'transferId' = '$T1';")" "1"

echo "-- out of order: the newer attempt pays first --"
T2=$(new_transfer pending)
A2=$(init "$T2"); B2=$(init "$T2")
expect_value "the newer attempt confirms" "$(confirm "$B2")" "confirmed"
expect_value "the older attempt, arriving later, is a duplicate" "$(confirm "$A2")" "duplicate_payment"
expect_value "recorded with the right amount and transfer" "$(exc "$A2")" "ticket_transfer_fee/duplicate_payment/$FEE/$T2/1"

echo "-- unknown references --"
expect_value "an unknown transfer-fee reference is not found" "$(confirm txf_doesnotexist000)" "not_found"
expect_value "...and is recorded" "$(exc txf_doesnotexist000)" "ticket_transfer_fee/not_found/$FEE/-/1"
expect_value "a non-transfer reference is not recorded here" "$(confirm VENTS-somethingelse)/$(val "SELECT count(*) FROM public.payment_exceptions WHERE reference = 'VENTS-somethingelse';")" "not_found/0"

echo "-- wrong amount --"
T3=$(new_transfer pending)
A3=$(init "$T3")
expect_value "a wrong amount is refused" "$(confirm "$A3" 70000)" "amount_mismatch:$FEE:70000"
expect_value "...recorded" "$(exc "$A3")" "ticket_transfer_fee/amount_mismatch/70000/$T3/1"
expect_value "...and the transfer stays pending with the ticket unmoved" "$(val "SELECT status FROM public.ticket_transfers WHERE id = '$T3';")/$(owner_of "$T3")" "pending/$SENDER"
B3=$(init "$T3")
expect_value "a correct retry then confirms" "$(confirm "$B3")" "confirmed"

echo "-- late payment on a cancelled transfer: existing automatic refund, right reference --"
T4=$(new_transfer pending)
A4=$(init "$T4"); B4=$(init "$T4")
"${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'cancelled', responded_at = now() WHERE id = '$T4';"
expect_value "the earlier attempt's late payment claims the refund" "$(confirm "$A4")" "transfer_not_pending:cancelled:refund_claimed"
expect_value "fee_payment_ref points at the reference that paid" "$(val "SELECT fee_payment_ref FROM public.ticket_transfers WHERE id = '$T4';")" "$A4"
"${PSQL[@]}" -q -c "$(as_pa "SELECT public.attach_transfer_fee_refund_id('$A4', 'RF_T4');")"
expect_value "the refund id attaches to that payment" "$(val "SELECT fee_refund_id || '/' || fee_refund_status FROM public.ticket_transfers WHERE id = '$T4';")" "RF_T4/processing"
expect_value "the refund webhook finalizes it" "$(val "$(as_pa "SELECT status FROM public.finalize_transfer_fee_refund('RF_T4');")")" "finalized"
expect_value "a second payment on the cancelled transfer is a duplicate, not a second automatic refund" "$(confirm "$B4")" "duplicate_payment"
expect_value "...recorded for the two-admin flow" "$(exc "$B4")" "ticket_transfer_fee/duplicate_payment/$FEE/$T4/1"

echo "-- expired transfer, refund initiation failure, refund failure --"
T5=$(new_transfer pending '1 second')
A5=$(init "$T5"); B5=$(init "$T5")
"${PSQL[@]}" -q -c "SELECT pg_sleep(1.2);"
expect_value "the earlier attempt's late payment on an expired transfer claims the refund" "$(confirm "$A5")" "expired:refund_claimed"
"${PSQL[@]}" -q -c "$(as_pa "SELECT public.mark_transfer_fee_refund_initiation_failed('$A5', 'Paystack said no');")"
expect_value "a refund-initiation failure is kept on the transfer" "$(val "SELECT fee_refund_status FROM public.ticket_transfers WHERE id = '$T5';")" "failed"
T6=$(new_transfer pending)
A6=$(init "$T6"); "${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'declined' WHERE id = '$T6';"
confirm "$A6" >/dev/null
"${PSQL[@]}" -q -c "$(as_pa "SELECT public.attach_transfer_fee_refund_id('$A6', 'RF_T6');")"
expect_value "a failed refund webhook is recorded" "$(val "$(as_pa "SELECT public.fail_transfer_fee_refund('RF_T6', 'bank rejected');")")" "failed_recorded"
expect_value "...and logged for admins" "$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'transfer_fee_refund_failed' AND details->>'refund_id' = 'RF_T6';")" "1"

echo "-- two payments confirmed at the same moment --"
T7=$(new_transfer pending)
A7=$(init "$T7"); B7=$(init "$T7")
( "${PSQL[@]}" -tA -c "$(as_pa "BEGIN; SELECT public.confirm_transfer_fee_payment('$A7', $FEE); SELECT pg_sleep(1.5); COMMIT;")" >"$TMP/c1" 2>&1 ) &
sleep 0.4
( "${PSQL[@]}" -tA -c "$(as_pa "SELECT public.confirm_transfer_fee_payment('$B7', $FEE);")" >"$TMP/c2" 2>&1 ) &
wait
expect_value "one confirms, the other is a duplicate" "$(grep -h -E '^(confirmed|duplicate_payment)$' "$TMP/c1" "$TMP/c2" | sort | tr '\n' ' ')" "confirmed duplicate_payment "
expect_value "the ticket moved exactly once" "$(owner_of "$T7")/$(val "SELECT count(*) FROM public.payment_exceptions WHERE transfer_id = '$T7';")" "$RECIP/1"

echo "-- grants --"
expect_error "a signed-in user cannot read the attempts table" "permission denied" "$(as "$RECIP" "SELECT count(*) FROM public.ticket_transfer_fee_attempts;")"
expect_error "a signed-in user cannot record an exception" "permission denied" \
  "$(as "$RECIP" "SELECT public.record_transfer_fee_payment_exception('txf_x', NULL, 'not_found', 1, NULL, 'x');")"
expect_error "a signed-in user still cannot confirm a payment" "permission denied" "$(as "$RECIP" "SELECT public.confirm_transfer_fee_payment('$A1', $FEE);")"
expect_error "another user cannot pay for someone else's transfer" "Only the intended recipient" "$(as "$OTHER" "SELECT public.initiate_transfer_fee_payment('$(new_transfer pending)');")"

echo "-- undo --"
expect_error "undo refuses without the gate" "Refusing" "$(cat "$UNDO")"
expect_error "undo refuses while transfer-fee exceptions exist" "resolve them before undoing" "SET vents.rollback_confirm = 'undo-0233'; $(cat "$UNDO")"
"${PSQL[@]}" -q -c "DELETE FROM public.payment_exceptions; UPDATE public.ticket_transfer_fee_attempts SET outcome = NULL WHERE outcome IN ('duplicate', 'amount_mismatch');"
expect_ok "undo runs once the money records are resolved" "SET vents.rollback_confirm = 'undo-0233'; $(cat "$UNDO")"
expect_value "undo restores the exact previous functions" \
  "$(val "SELECT string_agg(proname || '=' || md5(replace(prosrc, E'\r', '')), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('initiate_transfer_fee_payment', 'get_transfer_fee_payment_owner', 'confirm_transfer_fee_payment');")" \
  "confirm_transfer_fee_payment=46f411874adac7e0f55192cc54539a2d,get_transfer_fee_payment_owner=2984c22524a9bb1a1b21a9960447491c,initiate_transfer_fee_payment=02f938d7ac659268b73ce822752ef400"
expect_ok "0233 re-applies after undo" "$(cat "$MIG/0233_transfer_fee_payment_attempts.sql")"
"${PSQL[@]}" -q -c "SET vents.rollback_confirm = 'undo-0233';" -f "$UNDO" >/dev/null
"${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.get_transfer_fee_payment_owner(p_reference text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS \$f\$ SELECT NULL::uuid \$f\$;"
expect_error "0233 refuses a drifted function (no partial apply)" "not the expected version" "$(cat "$MIG/0233_transfer_fee_payment_attempts.sql")"
expect_value "...and created nothing" "$(val "SELECT to_regclass('public.ticket_transfer_fee_attempts') IS NULL;")" "t"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES TRANSFER FEE ATTEMPT CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
