#!/usr/bin/env bash
# Verifies scripts/ops/0220-precheck.sql (the read-only production precheck
# for migration 0220, unpaid tickets usable for entry) on the same local
# ticket stack the 0220 suite uses:
#   * before 0220: every anchor of all four functions reports OK;
#   * the precheck is a single read-only transaction (it would refuse a write);
#   * after 0220: every function reports ALREADY PATCHED;
#   * a function that differs from the expected text reports BLOCKED, and
#     0220 itself then refuses to apply (the precheck predicts the migration);
#   * the committed precheck matches a fresh generation from 0220.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files. No network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
PRE="$REPO_ROOT/scripts/ops/0220-precheck.sql"
DB_NAME="vents_local_pg_0220_precheck"
SOCKET_DIR="/var/run/postgresql"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
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

TMP=$(mktemp -d); OUT="$TMP/out"; ERR="$TMP/err"; chmod 777 "$TMP"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT
PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
precheck() { "${PSQL[@]}" -tA -F'|' -f "$PRE" 2>"$ERR" | grep '|' ; }
fresh_db() {
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
  # shellcheck source=lib-money-stack.sh
  source "$SCRIPT_DIR/lib-money-stack.sh"
  build_ticket_stack >/dev/null
}

echo "== generator: the committed precheck is exactly what 0220 generates"
cp "$PRE" "$TMP/committed.sql"
python3 "$REPO_ROOT/scripts/ops/gen-0220-precheck.py"
if cmp -s "$PRE" "$TMP/committed.sql"; then pass "committed precheck matches a fresh generation"; else fail "precheck is stale: run scripts/ops/gen-0220-precheck.py"; cp "$TMP/committed.sql" "$PRE"; fi
if python3 "$SCRIPT_DIR/lib-0220-precheck.py" scan "$PRE"; then
  pass "precheck has no write keyword outside comments and anchor literals"
else fail "precheck contains a write keyword outside comments and anchor literals"; fi
expect_value "precheck runs READ ONLY and ends in ROLLBACK" "$(grep -c -E '^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;$|^ROLLBACK;$' "$PRE")" "2"

echo "== before 0220: every anchor OK"
fresh_db
precheck >"$TMP/before" || true
expect_value "4 functions checked" "$(cut -d'|' -f1 "$TMP/before" | sort -u | wc -l | tr -d ' ')" "4"
expect_value "no anchor is anything but OK" "$(grep -vc '|OK$' "$TMP/before" || true)" "0"
expect_value "at least one anchor per function" "$(grep -c '|OK$' "$TMP/before" | awk '{print ($1>=4)}')" "1"

echo "== the precheck cannot write: a write inside its transaction is refused"
if "${PSQL[@]}" -c "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; CREATE TABLE public.x(i int); ROLLBACK;" >"$OUT" 2>"$ERR"; then
  fail "a write succeeded in the precheck's transaction mode"
else
  grep -q "read-only transaction" "$ERR" && pass "the precheck's transaction mode refuses writes" || { fail "unexpected error"; cat "$ERR" >&2; }
fi

echo "== after 0220: every function ALREADY PATCHED"
expect_ok "0220 applies" "$(cat "$MIG/0220_ticket_payment_integrity.sql")"
precheck >"$TMP/after" || true
expect_value "every row ALREADY PATCHED" "$(grep -vc '|ALREADY PATCHED$' "$TMP/after" || true)" "0"

echo "== drift: a function that differs reports BLOCKED and 0220 refuses"
fresh_db
# Untracked edit: 0220's first verify_entry_pass anchor now appears twice.
python3 "$SCRIPT_DIR/lib-0220-precheck.py" drift-sql "$MIG/0220_ticket_payment_integrity.sql" >"$TMP/drift.sql"
chmod 644 "$TMP/drift.sql"
"${PSQL[@]}" -q -f "$TMP/drift.sql" 2>"$ERR" || { fail "could not create the drifted function"; cat "$ERR" >&2; }
precheck >"$TMP/drift" || true
expect_value "verify_entry_pass reports BLOCKED" "$(grep -c '^public.verify_entry_pass(text,uuid,text,text)|[0-9]*|BLOCKED' "$TMP/drift")" "1"
expect_value "the other three still OK" "$(grep -v '^public.verify_entry_pass' "$TMP/drift" | grep -vc '|OK$' || true)" "0"
if "${PSQL[@]}" -1 -f "$MIG/0220_ticket_payment_integrity.sql" >"$OUT" 2>"$ERR"; then
  fail "0220 applied over a drifted function"
else
  grep -q "is not the expected version" "$ERR" && pass "0220 refuses exactly as the precheck predicted" || { fail "0220 failed for another reason"; cat "$ERR" >&2; }
fi
expect_value "nothing was patched (whole migration rolled back)" "$("${PSQL[@]}" -tA -c "SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%[0220]%'")" "0"

echo
echo "$PASSES passed, $FAILS failed"
[ "$FAILS" = 0 ] && echo "ALL CHECKS PASSED" || exit 1
