#!/usr/bin/env bash
# Migration 0239 (+ 0240): ticket-transfer fee payments on the LIVE production
# baseline. Builds the local ticket stack, then reproduces production exactly:
#   * confirm_transfer_fee_payment = the reconstructed live body (0043 + the
#     untracked `<` amount edit), md5 5baaac006d1757b42b2f587315ce6a3f;
#   * initiate / owner = 0043 (md5-checked);
#   * NO 0064 (its refund columns and functions removed), no 0233, no 0238.
# It first REPRODUCES what production loses today (overpayment excess,
# underpayment, late payment and replaced-reference payments recorded
# nowhere), then applies 0226 -> 0239 -> 0234 -> 0240 and proves:
#   every outcome recorded once per Paystack reference with the original
#   reference; the `<` rule kept; only the excess refundable on an
#   overpayment; replays (webhook retry / verify after webhook) answer the
#   same and record nothing twice; concurrent payments serialize (one owner,
#   one duplicate); two different admins for every refund; one Paystack send;
#   refund outcome updates the transfer once; precheck refusals; gated undo
#   that restores the live functions byte for byte and never deletes records.
#
# Paystack is never called: the database calls are replayed exactly as
# api/webhook/paystack.ts and api/wallet/refund-ticket.ts make them.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
RB="$REPO_ROOT/supabase/rollback"
DB_NAME="vents_local_pg_transfer_fee_live_0239"
SOCKET_DIR="/var/run/postgresql"
LIVE_MD5="5baaac006d1757b42b2f587315ce6a3f"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL BACKUP_DB_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then die "\$$var is set. Unset it; this test only connects to the local Unix socket."; fi
done
if env | grep -qiE 'supabase\.(co|com)|pooler\.|rds\.amazonaws\.com|neon\.tech|render\.com'; then
  die "an environment variable references a hosted database host."
fi
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z0-9_]+$ ]] || die "database name '$DB_NAME' is not a local test name."
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
FEE=50000

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
xstate() { val "SELECT kind || '/' || reason || '/' || amount_kobo || '/' || COALESCE(expected_kobo::text, '-') || '/' || status FROM public.payment_exceptions WHERE reference = '$1';"; }
xcount() { val "SELECT count(*) FROM public.payment_exceptions WHERE reference = '$1';"; }
xid() { val "SELECT id FROM public.payment_exceptions WHERE reference = '$1';"; }
tstate() { val "SELECT status || '/' || COALESCE(fee_refund_status, '-') || '/' || (fee_paid_at IS NOT NULL)::text FROM public.ticket_transfers WHERE id = '$1';"; }
owner_of() { val "SELECT k.user_id FROM public.tickets k JOIN public.ticket_transfers t ON t.ticket_id = k.id WHERE t.id = '$1';"; }
attempt() { val "SELECT COALESCE(outcome, '-') || '/' || COALESCE(paid_kobo::text, '-') FROM public.ticket_transfer_fee_attempts WHERE reference = '$1';"; }
request() { val "$(as "$1" "SELECT (public.admin_request_payment_exception_refund('$2', $3, \$r\$$4\$r\$))->>'id';")"; }
approve() { "${PSQL[@]}" -tA -c "$(as "$1" "SELECT (public.approve_admin_action('$2'))->>'status';")" 2>"$ERR" | tail -n1; }
start() { val "$(as "$1" "SELECT public.start_payment_exception_refund('$2', 'refund')->>'status';")"; }
md5_of() { val "SELECT md5(replace(prosrc, E'\r', '')) FROM pg_proc WHERE oid = 'public.$1'::regprocedure;"; }
LIVE3="SELECT string_agg(proname || '=' || md5(replace(prosrc, E'\r', '')), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('confirm_transfer_fee_payment', 'initiate_transfer_fee_payment', 'get_transfer_fee_payment_owner');"

build_production_baseline() {
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
  build_ticket_stack >/dev/null
  # Production never had 0064: drop its refund functions and columns.
  "${PSQL[@]}" -q <<'SQL'
DROP FUNCTION IF EXISTS public.attach_transfer_fee_refund_id(text, text);
DROP FUNCTION IF EXISTS public.mark_transfer_fee_refund_initiation_failed(text, text);
DROP FUNCTION IF EXISTS public.finalize_transfer_fee_refund(text);
DROP FUNCTION IF EXISTS public.fail_transfer_fee_refund(text, text);
SQL
  # The live confirm body, reconstructed from production's pg_get_functiondef.
  python3 - "$MIG/0043_ticket_transfer_fee.sql" "$TMP/live_confirm.sql" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r"CREATE OR REPLACE FUNCTION public\.confirm_transfer_fee_payment\(.*?\n\$function\$;?\n", s, re.S)
body = m.group(0)
body = body.replace("""  -- Idempotent: a retried webhook/verify call for an already-confirmed
  -- transfer is a no-op, not an error -- same convention as
  -- confirm_ticket_payment's own 'already_paid' branch.
""", "", 1)
assert "IF p_amount_kobo IS DISTINCT FROM v_transfer.fee_kobo THEN" in body
body = body.replace("IF p_amount_kobo IS DISTINCT FROM v_transfer.fee_kobo THEN", "IF p_amount_kobo < v_transfer.fee_kobo THEN", 1)
if not body.rstrip().endswith(';'):
    body = body.rstrip() + ';\n'
open(sys.argv[2], 'w').write(body)
PY
  chmod 644 "$TMP/live_confirm.sql"
  "${PSQL[@]}" -q -f "$TMP/live_confirm.sql"
  "${PSQL[@]}" -q -c "ALTER TABLE public.ticket_transfers DROP COLUMN IF EXISTS fee_refund_needed_at, DROP COLUMN IF EXISTS fee_refund_id,
                      DROP COLUMN IF EXISTS fee_refund_status, DROP COLUMN IF EXISTS fee_refund_completed_at;"
  "${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email, username) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test', 'org'), ('$SENDER', 'user', false, 'Sender', 's@example.test', 'sender'),
  ('$RECIP', 'user', false, 'Recipient', 'r@example.test', 'recip'), ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test', 'admin_a'),
  ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test', 'admin_b'), ('$SUB', 'sub-admin', false, 'Sub', 'sub@example.test', 'sub'),
  ('$USER', 'user', false, 'User', 'u@example.test', 'user');
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EV', '$ORG', 'Transfer night', now() + interval '20 days', 'live', '[{"name": "Regular", "price": 10000}]');
SQL
}

echo "== Building the production baseline =="
build_production_baseline
expect_value "baseline confirm is byte-identical to production's live function" "$(md5_of 'confirm_transfer_fee_payment(text,bigint)')" "$LIVE_MD5"
expect_value "baseline initiate is 0043's (as production)" "$(md5_of 'initiate_transfer_fee_payment(uuid)')" "02f938d7ac659268b73ce822752ef400"
expect_value "baseline owner lookup is 0043's (as production)" "$(md5_of 'get_transfer_fee_payment_owner(text)')" "2984c22524a9bb1a1b21a9960447491c"
expect_value "baseline has no 0064 columns (as production)" "$(val "SELECT count(*) FROM information_schema.columns WHERE table_name = 'ticket_transfers' AND column_name LIKE 'fee_refund%';")" "0"
BASE_LIVE3=$(val "$LIVE3")

echo "-- REPRODUCE: what production records today (nothing) --"
TO=$(new_transfer); AO=$(init "$TO")
expect_value "BEFORE: an overpayment completes the transfer (< rule)..." "$(confirm "$AO" $((FEE + 7000)))" "confirmed"
expect_value "...and its excess is recorded nowhere" "$(val "SELECT count(*) FROM public.payment_exceptions WHERE reference = '$AO';")" "0"
TU=$(new_transfer); AU=$(init "$TU")
expect_value "BEFORE: an underpayment is refused and recorded nowhere" "$(confirm "$AU" 100)/$(val "SELECT count(*) FROM public.payment_exceptions WHERE reference = '$AU';")" "amount_mismatch:$FEE:100/0"
TE=$(new_transfer '1 second'); AE=$(init "$TE"); "${PSQL[@]}" -q -c "SELECT pg_sleep(1.2);"
expect_value "BEFORE: a late payment on an expired transfer is kept with no record" "$(confirm "$AE")/$(val "SELECT count(*) FROM public.payment_exceptions WHERE reference = '$AE';")" "expired/0"
TR=$(new_transfer); AR1=$(init "$TR"); AR2=$(init "$TR")
expect_value "BEFORE: a payment under a replaced reference matches nothing" "$(confirm "$AR1")" "not_found"
expect_value "BEFORE: a NULL amount slips past the < check and completes the transfer" "$(T=$(new_transfer); A=$(init "$T"); val "$(as_pa "SELECT public.confirm_transfer_fee_payment('$A', NULL);")")" "confirmed"

echo "== Order and prechecks =="
expect_error "0234 cannot be applied first (needs 0239's transfer_id)" "payment_exceptions.transfer_id is missing" "$(cat "$MIG/0234_payment_exception_two_admin_refund.sql")"
expect_error "0240 cannot be applied before 0239" "0240 requires 0239" "$(cat "$MIG/0240_transfer_fee_refund_outcome.sql")"
# Drift: an untracked edit to the live function makes 0239 refuse, and nothing changes.
"${PSQL[@]}" -q -c "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.confirm_transfer_fee_payment(text,bigint)'::regprocedure), 'RETURN ''not_found'';', 'RETURN ''not_found''; /* edited */'); END \$d\$;"
expect_error "0239 refuses a confirm that differs from the reviewed live version" "is not the reviewed live version" "$(cat "$MIG/0239_transfer_fee_payment_safety_live.sql")"
expect_value "...and changed nothing (whole migration rolled back)" "$(val "SELECT to_regclass('public.ticket_transfer_fee_attempts') IS NULL;")" "t"
"${PSQL[@]}" -q -f "$TMP/live_confirm.sql"
expect_value "live function restored for the real apply" "$(md5_of 'confirm_transfer_fee_payment(text,bigint)')" "$LIVE_MD5"

echo "== The read-only precheck (scripts/ops/0239-precheck.sql) predicts the apply =="
PRE="$REPO_ROOT/scripts/ops/0239-precheck.sql"
precheck() { "${PSQL[@]}" -tA -F'|' -f "$PRE" 2>"$ERR" | grep '|' ; }
expect_value "precheck on the production baseline: 7 conditions, all READY" "$(precheck | grep -c '|READY|')/$(precheck | wc -l | tr -d ' ')" "7/7"
"${PSQL[@]}" -q -c "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.confirm_transfer_fee_payment(text,bigint)'::regprocedure), 'RETURN ''not_found'';', 'RETURN ''not_found''; /* edited */'); END \$d\$;"
expect_value "precheck on a drifted confirm: exactly that condition BLOCKED" "$(precheck | grep '|BLOCKED|' | cut -d'|' -f1)" "confirm_transfer_fee_payment is the reviewed live version"
"${PSQL[@]}" -q -f "$TMP/live_confirm.sql"
expect_error "the precheck's transaction refuses writes" "read-only transaction" "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; CREATE TABLE public.pc(i int); ROLLBACK;"

echo "== Applying 0239 =="
expect_ok "0239 applies on the production baseline" "$(cat "$MIG/0239_transfer_fee_payment_safety_live.sql")"
expect_error "0239 refuses a second run" "already applied" "$(cat "$MIG/0239_transfer_fee_payment_safety_live.sql")"
expect_value "precheck after 0239: the applied-state conditions report BLOCKED" "$(precheck | grep -c '|BLOCKED|')" "6"
expect_value "backfill: every reference still held is kept, the confirmed ones as paid" \
  "$(attempt "$AO")/$(attempt "$AR2")" "paid/-/-/-"

echo "-- normal and overpaid --"
T1=$(new_transfer); A1=$(init "$T1")
expect_value "exact fee: confirmed, ticket moves, no exception" "$(confirm "$A1")/$(owner_of "$T1")/$(xcount "$A1")/$(attempt "$A1")" "confirmed/$RECIP/0/paid/$FEE"
T2=$(new_transfer); A2=$(init "$T2")
expect_value "overpaid: the < rule still completes the transfer, with a suffix" "$(confirm "$A2" $((FEE + 7000)))/$(owner_of "$T2")/$(tstate "$T2")" "confirmed:excess_refund_queued/$RECIP/accepted/-/true"
expect_value "only the EXCESS is recorded as refundable, with the original reference" "$(xstate "$A2")/$(attempt "$A2")" "ticket_transfer_fee/overpayment/7000/$FEE/open/overpaid/$((FEE + 7000))"
expect_value "webhook retry: same answer, nothing written (one exception, unchanged)" \
  "$(confirm "$A2" $((FEE + 7000)))/$(xcount "$A2")/$(val "SELECT seen_count || '/' || amount_kobo FROM public.payment_exceptions WHERE reference = '$A2';")" "already_paid:excess_refund_queued/1/1/7000"

echo "-- underpaid / no amount --"
T3=$(new_transfer); A3=$(init "$T3")
expect_value "underpaid: refused, transfer untouched, whole amount recorded" "$(confirm "$A3" 1000)/$(tstate "$T3")/$(xstate "$A3")" "amount_mismatch:$FEE:1000:refund_queued/pending/-/false/ticket_transfer_fee/amount_mismatch/1000/$FEE/open"
expect_value "replay of the underpayment: same answer, nothing new" "$(confirm "$A3" 1000)/$(xcount "$A3")/$(tstate "$T3")" "amount_mismatch:$FEE:1000:refund_queued/1/pending/-/false"
B3=$(init "$T3")
expect_value "the recipient can still pay the right amount with a new attempt" "$(confirm "$B3")/$(owner_of "$T3")" "confirmed/$RECIP"
T4=$(new_transfer); A4=$(init "$T4")
expect_value "no amount at all (NULL): refused and recorded, never a completed transfer" "$(val "$(as_pa "SELECT public.confirm_transfer_fee_payment('$A4', NULL);")")/$(tstate "$T4")/$(xstate "$A4")" "amount_mismatch:$FEE:null:refund_queued/pending/-/false/ticket_transfer_fee/amount_mismatch/0/$FEE/open"

echo "-- duplicates and replaced references --"
T5=$(new_transfer); A5=$(init "$T5"); B5=$(init "$T5")
expect_value "an OLDER attempt paying later is matched (replaced reference)" "$(confirm "$A5")/$(owner_of "$T5")" "confirmed/$RECIP"
expect_value "the transfer now points at the reference that actually paid" "$(val "SELECT fee_payment_ref FROM public.ticket_transfers WHERE id = '$T5';")" "$A5"
expect_value "the buyer's own verify works for the older attempt" "$(val "$(as_pa "SELECT public.get_transfer_fee_payment_owner('$A5');")")" "$RECIP"
expect_value "the second payment is a duplicate: whole amount recorded, ownership unchanged" "$(confirm "$B5")/$(xstate "$B5")/$(owner_of "$T5")" "duplicate_payment:refund_queued/ticket_transfer_fee/duplicate_payment/$FEE/$FEE/open/$RECIP"
expect_value "duplicate replay: same answer, one exception" "$(confirm "$B5")/$(xcount "$B5")" "duplicate_payment:refund_queued/1"
expect_value "an unknown txf_ reference is recorded too" "$(confirm 'txf_unknownref0001')/$(xstate 'txf_unknownref0001')" "not_found:refund_queued/ticket_transfer_fee/not_found/$FEE/-/open"
expect_value "a non-transfer reference is not this function's business" "$(confirm 'VNT-123')/$(xcount 'VNT-123')" "not_found/0"

echo "-- late payments: expired, cancelled, declined, ineligible --"
T6=$(new_transfer '1 second'); A6=$(init "$T6"); "${PSQL[@]}" -q -c "SELECT pg_sleep(1.2);"
expect_value "expired: queued for two admins, transfer expired and awaiting approval" "$(confirm "$A6")/$(tstate "$T6")/$(xstate "$A6")" "expired:refund_queued/expired/awaiting_approval/false/ticket_transfer_fee/transfer_not_completed/$FEE/$FEE/open"
expect_value "expired replay: same answer, nothing new" "$(confirm "$A6")/$(xcount "$A6")" "expired:refund_queued/1"
T7=$(new_transfer); A7=$(init "$T7"); "${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'cancelled', responded_at = now() WHERE id = '$T7';"
expect_value "cancelled by the sender: queued" "$(confirm "$A7")/$(xstate "$A7")" "transfer_not_pending:cancelled:refund_queued/ticket_transfer_fee/transfer_not_completed/$FEE/$FEE/open"
T8=$(new_transfer); A8=$(init "$T8"); "${PSQL[@]}" -q -c "UPDATE public.ticket_transfers SET status = 'declined', responded_at = now() WHERE id = '$T8';"
expect_value "declined: queued (the 3 production cases are this shape)" "$(confirm "$A8")/$(tstate "$T8")" "transfer_not_pending:declined:refund_queued/declined/awaiting_approval/false"
expect_error "a declined transfer can't start a new attempt" "no longer pending" "$(as "$RECIP" "SELECT public.initiate_transfer_fee_payment('$T8');")"
expect_value "a SECOND late payment on it is a duplicate (separate record)" "$(T=$T8; R=txf_latedup0001; "${PSQL[@]}" -q -c "INSERT INTO public.ticket_transfer_fee_attempts (reference, transfer_id, fee_kobo, payer_id) VALUES ('$R', '$T', $FEE, '$RECIP');"; confirm "$R")/$(xcount txf_latedup0001)" "duplicate_payment:refund_queued/1"
T9=$(new_transfer); A9=$(init "$T9")
"${PSQL[@]}" -q -c "UPDATE public.tickets SET checked_in = true WHERE id = (SELECT ticket_id FROM public.ticket_transfers WHERE id = '$T9');"
expect_value "ticket no longer eligible: queued, ticket stays with the sender" "$(confirm "$A9")/$(owner_of "$T9")/$(tstate "$T9")" "ticket_ineligible:refund_queued/$SENDER/cancelled/awaiting_approval/false"
expect_value "late payments still on a cancelled-by-confirm transfer replay the same" "$(confirm "$A9")" "ticket_ineligible:refund_queued"

echo "-- concurrency: webhook and verify at once, two references at once --"
TC=$(new_transfer); AC=$(init "$TC"); BC=$(init "$TC")
( "${PSQL[@]}" -tA -c "BEGIN; SET LOCAL ROLE project_admin; SELECT public.confirm_transfer_fee_payment('$AC', $FEE); SELECT pg_sleep(1); COMMIT;" 2>&1 | grep -v -e BEGIN -e COMMIT -e '^$' -e SET > "$TMP/c1" ) &
sleep 0.3
( "${PSQL[@]}" -tA -c "BEGIN; SET LOCAL ROLE project_admin; SELECT public.confirm_transfer_fee_payment('$BC', $FEE); COMMIT;" 2>&1 | grep -v -e BEGIN -e COMMIT -e '^$' -e SET > "$TMP/c2" ) &
wait
expect_value "two different payments at once: the first owns the transfer, the second is a duplicate" "$(head -1 "$TMP/c1")/$(head -1 "$TMP/c2")" "confirmed/duplicate_payment:refund_queued"
expect_value "...one owner, exactly one exception (for the second)" "$(owner_of "$TC")/$(xcount "$AC")/$(xcount "$BC")" "$RECIP/0/1"
TD=$(new_transfer); AD=$(init "$TD")
( "${PSQL[@]}" -tA -c "BEGIN; SET LOCAL ROLE project_admin; SELECT public.confirm_transfer_fee_payment('$AD', $((FEE + 500))); SELECT pg_sleep(1); COMMIT;" 2>&1 | grep -v -e BEGIN -e COMMIT -e '^$' -e SET > "$TMP/d1" ) &
sleep 0.3
( "${PSQL[@]}" -tA -c "BEGIN; SET LOCAL ROLE project_admin; SELECT public.confirm_transfer_fee_payment('$AD', $((FEE + 500))); COMMIT;" 2>&1 | grep -v -e BEGIN -e COMMIT -e '^$' -e SET > "$TMP/d2" ) &
wait
expect_value "the same overpaid reference twice at once (webhook + verify): one completion, one replay" "$(head -1 "$TMP/d1")/$(head -1 "$TMP/d2")" "confirmed:excess_refund_queued/already_paid:excess_refund_queued"
expect_value "...the excess recorded exactly once" "$(xcount "$AD")/$(val "SELECT amount_kobo FROM public.payment_exceptions WHERE reference = '$AD';")" "1/500"

echo "-- evidence cannot be erased --"
expect_error "an attempt cannot be deleted" "cannot be deleted" "DELETE FROM public.ticket_transfer_fee_attempts WHERE reference = '$A2';"
expect_error "an attempt's outcome cannot be rewritten" "already has an outcome" "UPDATE public.ticket_transfer_fee_attempts SET paid_kobo = 1 WHERE reference = '$A2';"
expect_error "an attempt cannot be re-pointed to another transfer" "is immutable" "UPDATE public.ticket_transfer_fee_attempts SET transfer_id = '$T1' WHERE reference = '$A2';"
expect_error "clients cannot read the attempts" "permission denied" "$(as "$RECIP" "SELECT count(*) FROM public.ticket_transfer_fee_attempts;")"
expect_error "clients cannot record exceptions" "permission denied" "$(as "$RECIP" "SELECT public.record_transfer_fee_payment_exception('x', NULL, 'not_found', 1, 1, 'x');")"

echo "== Applying 0234 then 0240 =="
expect_ok "0234 applies after 0239 (unchanged)" "$(cat "$MIG/0234_payment_exception_two_admin_refund.sql")"
expect_ok "0240 applies" "$(cat "$MIG/0240_transfer_fee_refund_outcome.sql")"
expect_value "0240 installs 0238's reviewed bodies byte for byte" "$(md5_of 'finalize_payment_exception_refund(text)')/$(md5_of 'fail_payment_exception_refund(text,text)')" "937f2aeb15224742f6fba86653cdbaa4/4057b9954d0883d7a0caf839962975de"
expect_error "0240 refuses a second run" "is not 0234's version" "$(cat "$MIG/0240_transfer_fee_refund_outcome.sql")"

echo "-- overpayment refund: excess only, two different admins, one send --"
X2=$(xid "$A2")
expect_error "nothing goes to Paystack before approval" "not been approved by two admins" "$(as "$ADMIN_A" "SELECT public.start_payment_exception_refund('$X2', 'x');")"
expect_error "more than the excess can't be requested" "cannot exceed the amount Paystack captured" "$(as "$SUB" "SELECT public.admin_request_payment_exception_refund('$X2', 7001, 'overpaid');")"
Q2=$(request "$SUB" "$X2" 7000 "Overpaid transfer fee: refund the excess")
expect_error "a sub-admin can't approve" "Super Admin access required" "$(as "$SUB" "SELECT public.approve_admin_action('$Q2');")"
Q6=$(request "$ADMIN_A" "$(xid "$A6")" "$FEE" "Expired transfer: refund the fee")
expect_error "a Super Admin can't approve their own request" "Cannot approve your own request" "$(as "$ADMIN_A" "SELECT public.approve_admin_action('$Q6');")"
expect_value "a different Super Admin approves" "$(approve "$ADMIN_A" "$Q2")" "approved"
expect_value "a Super Admin sends it once" "$(start "$ADMIN_B" "$X2")" "refund_pending"
expect_error "a second send is refused (no duplicate Paystack refund)" "already sent to Paystack" "$(as "$ADMIN_A" "SELECT public.start_payment_exception_refund('$X2', 'x');")"
"${PSQL[@]}" -q -c "$(as "$ADMIN_B" "SELECT public.attach_payment_exception_refund_id('$X2', 'RF_OVER');")"
expect_value "refund.processed closes it; the completed transfer is untouched" "$(val "$(as_pa "SELECT status FROM public.finalize_payment_exception_refund('RF_OVER');")")/$(tstate "$T2")/$(owner_of "$T2")" "finalized/accepted/-/true/$RECIP"
expect_value "a webhook replay of the original payment after the refund changes nothing" "$(confirm "$A2" $((FEE + 7000)))/$(xcount "$A2")" "already_paid:excess_refund_queued/1"

echo "-- late-payment refund updates the transfer (0240) --"
expect_value "the other Super Admin approves the expired-transfer refund" "$(approve "$ADMIN_B" "$Q6")" "approved"
X6=$(xid "$A6"); start "$ADMIN_A" "$X6" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.attach_payment_exception_refund_id('$X6', 'RF_LATE');")"
expect_value "refund.processed: exception refunded, transfer refunded" "$(val "$(as_pa "SELECT status FROM public.finalize_payment_exception_refund('RF_LATE');")")/$(tstate "$T6")" "finalized/expired/refunded/false"
expect_value "...the recipient is told once, and a replay changes nothing" \
  "$(val "$(as_pa "SELECT status FROM public.finalize_payment_exception_refund('RF_LATE');")")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$RECIP' AND title = 'Transfer fee refunded' AND push_data->>'transferId' = '$T6';")" "already_finalized/1"
X7=$(xid "$A7"); Q7=$(request "$SUB" "$X7" "$FEE" "Cancelled transfer"); approve "$ADMIN_A" "$Q7" >/dev/null; start "$ADMIN_B" "$X7" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ADMIN_B" "SELECT public.attach_payment_exception_refund_id('$X7', 'RF_FAIL');")"
expect_value "refund.failed: recorded on the exception and the transfer" "$(val "$(as_pa "SELECT public.fail_payment_exception_refund('RF_FAIL', 'bank rejected');")")/$(tstate "$T7")" "failed_recorded/cancelled/failed/false"
expect_error "...and it can't be re-sent without new approvals" "not been approved by two admins" "$(as "$ADMIN_A" "SELECT public.start_payment_exception_refund('$X7', 'x');")"

echo "-- undo (reverse order; records are never deleted) --"
expect_error "undo_0239 refuses while 0234 is applied" "0234 is still applied" "SET vents.rollback_confirm = 'undo-0239'; $(cat "$RB/undo_0239.sql")"
expect_error "undo_0234 refuses while 0240 is applied" "0240 (or 0238) is still applied" "SET vents.rollback_confirm = 'undo-0234'; $(cat "$RB/undo_0234.sql")"
expect_error "undo_0240 refuses without the gate" "undo-0240" "$(cat "$RB/undo_0240.sql")"
expect_ok "undo_0240 runs with the gate" "SET vents.rollback_confirm = 'undo-0240'; $(cat "$RB/undo_0240.sql")"
expect_value "...restoring 0234's functions byte for byte" "$(md5_of 'finalize_payment_exception_refund(text)')/$(md5_of 'fail_payment_exception_refund(text,text)')" "5054801cd73750349ed99310519aaf8e/099e94c90aacac4e70bb6bc925cf94e2"
# Finish the one open refund request so 0234's own undo may run.
"${PSQL[@]}" -q -c "UPDATE public.admin_action_requests SET status = 'rejected' WHERE action_type = 'refund_payment_exception' AND status = 'pending';" 2>/dev/null || true
"${PSQL[@]}" -q -c "UPDATE public.payment_exceptions SET refund_status = 'refund_failed' WHERE refund_status IN ('approved', 'refund_pending');"
expect_ok "undo_0234 runs (reverse order)" "SET vents.rollback_confirm = 'undo-0234'; $(cat "$RB/undo_0234.sql")"
RECORDS_BEFORE=$(val "SELECT (SELECT count(*) FROM public.payment_exceptions WHERE kind = 'ticket_transfer_fee') || '/' || (SELECT count(*) FROM public.ticket_transfer_fee_attempts);")
expect_error "undo_0239 refuses without the gate" "undo-0239" "$(cat "$RB/undo_0239.sql")"
expect_ok "undo_0239 runs with the gate" "SET vents.rollback_confirm = 'undo-0239'; $(cat "$RB/undo_0239.sql")"
expect_value "the three functions are production's live versions again, byte for byte" "$(val "$LIVE3")" "$BASE_LIVE3"
expect_value "every recorded payment and attempt is kept as evidence" "$(val "SELECT (SELECT count(*) FROM public.payment_exceptions WHERE kind = 'ticket_transfer_fee') || '/' || (SELECT count(*) FROM public.ticket_transfer_fee_attempts);")" "$RECORDS_BEFORE"
expect_error "0239 then refuses to re-apply over kept evidence (a deliberate decision)" "already applied" "$(cat "$MIG/0239_transfer_fee_payment_safety_live.sql")"

echo "-- undo on a database where nothing was recorded returns to 0226 exactly --"
build_production_baseline
SCHEMA_0226=$(val "SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.payment_exceptions'::regclass;")
expect_ok "0239 applies (no transfers paid yet)" "$(cat "$MIG/0239_transfer_fee_payment_safety_live.sql")"
expect_ok "undo_0239 runs" "SET vents.rollback_confirm = 'undo-0239'; $(cat "$RB/undo_0239.sql")"
expect_value "no attempts table, no refund columns, no transfer_id" \
  "$(val "SELECT (to_regclass('public.ticket_transfer_fee_attempts') IS NULL)::text || '/' || (SELECT count(*) FROM information_schema.columns WHERE (table_name = 'ticket_transfers' AND column_name LIKE 'fee_refund%') OR (table_name = 'payment_exceptions' AND column_name = 'transfer_id'));")" "true/0"
expect_value "payment_exceptions constraints exactly as 0226 left them" "$(val "SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.payment_exceptions'::regclass;")" "$SCHEMA_0226"
expect_value "live functions restored" "$(md5_of 'confirm_transfer_fee_payment(text,bigint)')" "$LIVE_MD5"
expect_ok "0239 re-applies after a clean undo" "$(cat "$MIG/0239_transfer_fee_payment_safety_live.sql")"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES TRANSFER FEE (0239/0240, LIVE BASELINE) CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
