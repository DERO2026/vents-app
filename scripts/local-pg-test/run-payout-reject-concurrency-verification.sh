#!/usr/bin/env bash
# AZ-09: proves a payout (withdrawal) rejection credits the organizer's
# wallet exactly once, including under genuinely concurrent rejections.
#
# The function under test is production's admin_reject_organizer_payout as
# captured read-only on 2026-10-30 (scripts/local-pg-test/schema-live-payout-
# extras.sql). Its logic is identical to 0187's reject: the status check and
# the write are ONE statement (UPDATE ... WHERE status = 'pending'
# RETURNING), so a second caller that waited on the row lock re-checks the
# row, finds it 'rejected' and raises. No migration after 0187 redefines
# reject; 0213's guard leaves rejection unchanged. The full 0201-0213 stack
# (including the withdrawal guard triggers) is built first.
#
# Mutation check: the pre-0187 body (0124: unlocked SELECT, then an UPDATE
# not conditioned on status) is installed and the SAME concurrent scenario
# must then show the double credit; this proves the concurrency test can
# detect the bug it guards against. The live body is restored afterwards.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_payout_reject_race"
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
ADMIN_A="00000000-0000-0000-0000-000000000b01"
ADMIN_B="00000000-0000-0000-0000-000000000b02"
SUB="00000000-0000-0000-0000-000000000b03"
USER="00000000-0000-0000-0000-000000000c01"
ROOT="c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832"
BANK="00000000-0000-0000-0000-000000000d01"

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
# shellcheck source=lib-money-stack.sh
. "$SCRIPT_DIR/lib-money-stack.sh"

wallet() { val "SELECT balance_kobo || '/' || pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';"; }
reject_logs() { val "SELECT count(*) FROM public.admin_logs WHERE action = 'reject_payout_request' AND details->>'request_id' = '$1';"; }
reconciled() { val "$(as "$ADMIN_A" "SELECT count(*) FILTER (WHERE ledger_gap_kobo <> 0 OR pending_gap_kobo <> 0 OR 'negative_balance' = ANY(issues)) FROM public.admin_earnings_reconciliation();")"; }
# new_pending <id> <amount>: a pending withdrawal exactly as request_withdrawal
# leaves it (money moved from available to pending; no ledger row).
new_pending() {
  "${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id)
                      VALUES ('$1', '$ORG', $2, 'pending', '$BANK');
                      UPDATE public.organizer_wallets SET balance_kobo = balance_kobo - $2, pending_kobo = pending_kobo + $2 WHERE organizer_id = '$ORG';"
}
# race <request> <n> <uid...>: n sessions reject the same request; the first
# holds its transaction open for 2 s so the others genuinely overlap it.
race() {
  local req="$1"; shift; local i=0
  for uid in "$@"; do
    i=$((i+1))
    if [ "$i" -eq 1 ]; then
      ( "${PSQL[@]}" -tA -c "$(as "$uid" "BEGIN; SELECT public.admin_reject_organizer_payout('$req', 'race $i'); SELECT pg_sleep(2); COMMIT;")" >"$TMP/race_$i" 2>&1 || true ) &
      sleep 0.5
    else
      ( "${PSQL[@]}" -tA -c "$(as "$uid" "SELECT public.admin_reject_organizer_payout('$req', 'race $i');")" >"$TMP/race_$i" 2>&1 || true ) &
    fi
  done
  wait
  RACE_OK=$( (grep -l "^rejected$" "$TMP"/race_* 2>/dev/null || true) | wc -l | tr -d ' ')
  RACE_REFUSED=$( (grep -l "Only pending requests can be rejected" "$TMP"/race_* 2>/dev/null || true) | wc -l | tr -d ' ')
  rm -f "$TMP"/race_*
}

echo "== Building throwaway database $DB_NAME (0193..0213 stack) =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
build_money_stack
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email, username) VALUES
  ('$ORG', 'user', true, 'Ada Organizer', 'ada@example.test', 'ada'),
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test', 'admin_a'),
  ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test', 'admin_b'),
  ('$SUB', 'sub-admin', false, 'Sub One', 's1@example.test', 'sub1'),
  ('$USER', 'user', false, 'Plain User', 'u@example.test', 'plain'),
  ('$ROOT', 'admin', true, 'VENTS Admin', 'root@example.test', 'vents');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES
  ('$BANK', '$ORG', 'GTBank', '058', '0123456789', 'ADA ORGANIZER', 'RCP_ada', true);
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo) VALUES ('$ORG', 10000000, 0, 10000000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG', 'credit', 10000000, 'ticket sales');
SQL

LIVE_BODY_MD5=$(val "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.admin_reject_organizer_payout(uuid,text)'::regprocedure;")
REF_BODY=$(awk '/^-- Live helpers/{next} /FUNCTION public.admin_reject_organizer_payout/,/^\$function\$;/' "$SCRIPT_DIR/schema-live-payout-extras.sql")
expect_value "the function under test is the captured production body" \
  "$(val "SELECT (position('WHERE id = p_request_id AND status = ''pending''' IN prosrc) > 0)::text FROM pg_proc WHERE oid = 'public.admin_reject_organizer_payout(uuid,text)'::regprocedure;")" "true"
expect_value "no migration from 0201 to 0213 redefined reject (still the captured body)" \
  "$(printf '%s' "$REF_BODY" | grep -c 'RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo')" "1"
expect_value "starting ledger reconciles" "$(reconciled)" "0"

echo "-- single rejection --"
W1=10000000-0000-0000-0000-000000000001
new_pending "$W1" 3000000
expect_value "pending withdrawal holds 30,000 naira" "$(wallet)" "7000000/3000000"
expect_value "admin rejects once" "$(val "$(as "$ADMIN_A" "SELECT public.admin_reject_organizer_payout('$W1', 'bank details wrong');")")" "rejected"
expect_value "money back to available exactly once" "$(wallet)" "10000000/0"
expect_error "a second rejection of the same request is refused" "Only pending requests can be rejected" \
  "$(as "$ADMIN_B" "SELECT public.admin_reject_organizer_payout('$W1', 'again');")"
expect_value "...and credits nothing" "$(wallet)" "10000000/0"
expect_error "a rejected request cannot be moved back to pending by a raw UPDATE" "final status cannot change" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'pending' WHERE id = '$W1';"
expect_value "one rejection log row" "$(reject_logs "$W1")" "1"

echo "-- two admins reject the same request at the same moment --"
W2=10000000-0000-0000-0000-000000000002
new_pending "$W2" 2500000
race "$W2" "$ADMIN_A" "$ADMIN_B"
expect_value "exactly one concurrent rejection succeeds" "$RACE_OK" "1"
expect_value "the other is refused (not pending any more)" "$RACE_REFUSED" "1"
expect_value "wallet credited exactly once" "$(wallet)" "10000000/0"
expect_value "one rejection log row" "$(reject_logs "$W2")" "1"

echo "-- five concurrent rejections (double-clicks from three staff) --"
W3=10000000-0000-0000-0000-000000000003
new_pending "$W3" 1000000
race "$W3" "$ADMIN_A" "$ADMIN_B" "$ROOT" "$ADMIN_A" "$ADMIN_B"
expect_value "exactly one of five succeeds" "$RACE_OK" "1"
expect_value "four are refused" "$RACE_REFUSED" "4"
expect_value "wallet credited exactly once" "$(wallet)" "10000000/0"

echo "-- Admin Actions 'reject_payout' path racing a direct rejection --"
W4=10000000-0000-0000-0000-000000000004
new_pending "$W4" 1500000
REQ=$(val "$(as "$ADMIN_A" "SELECT (public.request_admin_action('reject_payout', 'withdrawal', '$W4', 'reject', jsonb_build_object('request_id', '$W4', 'reason', 'dup')))->>'id';")")
( "${PSQL[@]}" -tA -c "$(as "$ROOT" "BEGIN; SELECT public.admin_reject_organizer_payout('$W4', 'direct'); SELECT pg_sleep(2); COMMIT;")" >"$TMP/p1" 2>&1 || true ) &
sleep 0.5
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_B" "SELECT (public.approve_admin_action('$REQ'))->>'status';")" >"$TMP/p2" 2>&1 || true ) &
wait
expect_value "the direct rejection wins" "$(grep -c '^rejected$' "$TMP/p1")" "1"
expect_value "the approval of the duplicate request fails and rolls back" "$(grep -c 'Only pending requests can be rejected' "$TMP/p2")" "1"
expect_value "the duplicate admin request stays pending (nothing half-applied)" "$(val "SELECT status FROM public.admin_action_requests WHERE id = '$REQ';")" "pending"
expect_value "wallet credited exactly once" "$(wallet)" "10000000/0"

echo "-- refusals change nothing --"
W5=10000000-0000-0000-0000-000000000005
new_pending "$W5" 1000000
"${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = true;"
expect_error "payouts kill switch refuses rejection" "payouts_disabled" "$(as "$ADMIN_A" "SELECT public.admin_reject_organizer_payout('$W5', 'x');")"
"${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = false;"
expect_error "an ordinary user cannot reject" "Super Admin access required" "$(as "$USER" "SELECT public.admin_reject_organizer_payout('$W5', 'x');")"
expect_error "a sub-admin cannot reject (unchanged rule)" "Super Admin access required" "$(as "$SUB" "SELECT public.admin_reject_organizer_payout('$W5', 'x');")"
expect_error "the organizer cannot reject their own request" "Super Admin access required" "$(as "$ORG" "SELECT public.admin_reject_organizer_payout('$W5', 'x');")"
expect_value "request still pending, wallet unchanged" "$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '$W5';")/$(wallet)" "pending/9000000/1000000"
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET status = 'processing', approved_by = '$ROOT' WHERE id = '$W5';" 2>/dev/null || \
  "${PSQL[@]}" -q -c "SET session_replication_role = replica; UPDATE public.organizer_withdrawal_requests SET status = 'processing', approved_by = '$ROOT' WHERE id = '$W5'; SET session_replication_role = origin;"
expect_error "a processing request cannot be rejected" "Only pending requests can be rejected" "$(as "$ADMIN_A" "SELECT public.admin_reject_organizer_payout('$W5', 'x');")"
expect_value "...wallet unchanged" "$(wallet)" "9000000/1000000"
expect_error "an unknown request is reported as not found" "Request not found" \
  "$(as "$ADMIN_A" "SELECT public.admin_reject_organizer_payout('10000000-0000-0000-0000-0000000000ff', 'x');")"
expect_value "the ledger still reconciles (credits - debits = available + pending)" "$(reconciled)" "0"

echo "-- mutation: the pre-0187 body (0124) must show the double credit --"
expect_ok "the old body installs (mutation)" "$(awk '/FUNCTION public.admin_reject_organizer_payout/,/^END; \$function\$;/' "$MIG/0124_emergency_kill_switches.sql")"
W6=10000000-0000-0000-0000-000000000006
new_pending "$W6" 2000000
BEFORE=$(val "SELECT balance_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")
race "$W6" "$ADMIN_A" "$ADMIN_B"
AFTER=$(val "SELECT balance_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")
expect_value "MUTATION DETECTED: with the old body both concurrent rejections succeed" "$RACE_OK" "2"
expect_value "MUTATION DETECTED: ...and a 20,000 naira request is credited twice (40,000 to available)" "$((AFTER - BEFORE))" "4000000"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES PAYOUT REJECT CONCURRENCY CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
