#!/usr/bin/env bash
# Batch C: proves supabase/rollback/pre_0201_0203_functions.sql restores the
# pre-0201 production bodies exactly, on a LOCAL throwaway database that has
# 0201, 0202 and 0203 applied: each restored md5(prosrc) equals the value
# production reported (2026-10-30), grants are unchanged, and the file
# refuses without explicit confirmation or while earnings are still held.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
SNAP="$REPO_ROOT/supabase/rollback/pre_0201_0203_functions.sql"
DB_NAME="vents_local_pg_rollback_snapshot"
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

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
val() { "${PSQL[@]}" -tA -c "$1" 2>/dev/null | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', expected '$3')"; fi; }
# Runs the snapshot in one transaction, optionally confirmed; prints ok or the error.
restore() {
  local confirm="${1:-}"
  if "${PSQL[@]}" -q -1 -c "SET vents.rollback_confirm = '$confirm';" -f - <"$SNAP" >"$TMP/out" 2>"$TMP/err"; then echo ok
  else grep -m1 ERROR "$TMP/err" | sed 's/^.*ERROR: *//' | cut -c1-160; fi
}

echo "== The checked-in snapshot is exactly what the generator produces =="
cp "$SNAP" "$TMP/checked_in.sql"
python3 "$SCRIPT_DIR/generators/gen_rollback_snapshot.py" >/dev/null
if cmp -s "$SNAP" "$TMP/checked_in.sql"; then pass "snapshot file is up to date with its generator (every body md5-verified at generation)"
else fail "snapshot file differs from the generator output"; cp "$TMP/checked_in.sql" "$SNAP"; fi

echo "== Building a local database with 0201, 0202 and 0203 applied =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
"${PSQL[@]}" -q -1 -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
"${PSQL[@]}" -q -1 -c "SET vents.migration_local_test = 'on';" -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
"${PSQL[@]}" -q -1 -f "$MIG/0203_earnings_policies.sql" >/dev/null
expect_value "0203 is applied (confirm_ticket_payment carries its marker)" \
  "$(val "SELECT (prosrc LIKE '%[0203]%')::text FROM pg_proc WHERE oid = 'public.confirm_ticket_payment(text,bigint)'::regprocedure;")" "true"

# The 17 functions and their production md5s, read back out of the snapshot header lines.
EXPECTED=$(grep -oE '^-- [a-z_0-9]+  \(production md5 [0-9a-f]{32}' "$SNAP" | sed -E 's/^-- ([a-z_0-9]+)  \(production md5 ([0-9a-f]{32})/\1 \2/' | sort)
expect_value "the snapshot covers all 19 replaced functions" "$(echo "$EXPECTED" | grep -c .)" "19"
NAMES=$(echo "$EXPECTED" | awk '{printf "%s'\''%s'\''", (NR>1?",":""), $1}')
GRANTS_SQL="SELECT string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname, p.oid) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($NAMES);"
GRANTS_BEFORE=$(val "$GRANTS_SQL")

echo "== Refusals =="
R=$(restore "")
if [[ "$R" == *"set vents.rollback_confirm"* ]]; then pass "refuses without the explicit rollback confirmation"; else fail "unconfirmed restore: got '$R'"; fi
"${PSQL[@]}" -q -c "INSERT INTO public.users (id, role) VALUES ('00000000-0000-0000-0000-00000000c001', 'user');
  INSERT INTO public.organizer_wallets (organizer_id, on_hold_kobo) VALUES ('00000000-0000-0000-0000-00000000c001', 95000);" >/dev/null
R=$(restore "restore-pre-0201-0203")
if [[ "$R" == *"still on hold"* ]]; then pass "refuses while earnings are held (they would be stranded)"; else fail "restore with held money: got '$R'"; fi
expect_value "the refusals changed nothing (0203 still in place)" \
  "$(val "SELECT (prosrc LIKE '%[0203]%')::text FROM pg_proc WHERE oid = 'public.confirm_ticket_payment(text,bigint)'::regprocedure;")" "true"

echo "== Confirmed restore with nothing held =="
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET balance_kobo = balance_kobo + on_hold_kobo, on_hold_kobo = 0;" >/dev/null
expect_value "the confirmed restore applies" "$(restore "restore-pre-0201-0203")" "ok"
MISMATCH=""
while read -r fn md5; do
  got=$(val "SELECT md5(prosrc) FROM pg_proc WHERE proname = '$fn' AND pronamespace = 'public'::regnamespace;")
  [ "$got" = "$md5" ] || MISMATCH="$MISMATCH $fn($got)"
done <<<"$EXPECTED"
if [ -z "$MISMATCH" ]; then pass "all 19 restored bodies have exactly the expected md5 (18 production-reported, 1 by applied-migration provenance)"
else fail "restored bodies differ from production:$MISMATCH"; fi
expect_value "grants on the 19 functions are unchanged by the restore" "$(val "$GRANTS_SQL")" "$GRANTS_BEFORE"
expect_value "the restore leaves the migrations' tables in place (no financial rows dropped)" \
  "$(val "SELECT (to_regclass('public.earnings_holds') IS NOT NULL AND to_regclass('public.earn_audit_log') IS NOT NULL)::text;")" "true"
expect_value "a second confirmed restore is a no-op (idempotent)" "$(restore "restore-pre-0201-0203")" "ok"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES ROLLBACK SNAPSHOT CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
