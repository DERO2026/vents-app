#!/usr/bin/env bash
# Batch B (read-only investigation): which apply orders of 0192, 0201, 0202
# and 0203 are safe, proven by running them, not by reading them.
#
# Each scenario builds a throwaway LOCAL database shaped like production
# (the same test schemas and verbatim live money functions the other
# suites use), applies the migrations in one order, each file in its own
# transaction (psql -1, as `supabase db push` does), and records what
# happened. Nothing here can reach a hosted database (same guards as the
# other suites).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_migration_order"
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

file_of() { ls "$MIG"/"$1"_*.sql "$MIG"/_superseded/"$1"_*.sql 2>/dev/null | head -1; }
# Applies one migration file in a single transaction; prints ok or the error.
apply() {
  local f; f=$(file_of "$1")
  # Read here and piped in, so the postgres user never needs file access.
  # The local baseline holds stubs, so 0202's drift guard runs in its local
  # mode here (LOCAL0202=off exercises the production mode).
  if "${PSQL[@]}" -q -1 -c "SET vents.migration_local_test = '${LOCAL0202:-on}';" -f - <"${2:-$f}" >"$TMP/out" 2>"$TMP/err"; then echo ok
  else grep -m1 -E "ERROR" "$TMP/err" | sed 's/^.*ERROR: *//' | cut -c1-160; fi
}

# Production-shaped baseline: tables and verbatim live functions as they
# are before any of 0192/0201/0202/0203.
baseline() {
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
  for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
    "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
  done
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
  # Supabase's auth.users (0192's read policies reference it).
  "${PSQL[@]}" -q -c "CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);" >/dev/null
}
types() { val "SELECT pg_get_constraintdef(oid) LIKE '%payout_reversal%' FROM pg_constraint WHERE conname = 'organizer_transactions_type_check';"; }
marker() { val "SELECT (prosrc LIKE '%[0203]%')::text FROM pg_proc WHERE oid = '$1'::regprocedure;"; }
has_fn() { val "SELECT (to_regprocedure('$1') IS NOT NULL)::text;"; }
has_col() { val "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name='$2')::text;"; }

echo "== Scenario 1: 0201 -> 0202 -> 0203 (recommended core order) =="
baseline
expect_value "0201 applies on the production-shaped baseline" "$(apply 0201)" "ok"
expect_value "0202 applies after 0201" "$(apply 0202)" "ok"
expect_value "after 0202 the ledger allows payout_reversal (0202's reversal rows)" "$(types)" "t"
expect_value "0203 applies after 0201 and 0202" "$(apply 0203)" "ok"
expect_value "0203 patched confirm_ticket_payment" "$(marker 'public.confirm_ticket_payment(text,bigint)')" "true"
expect_value "0203 patched credit_organizer_wallet" "$(marker 'public.credit_organizer_wallet(uuid,bigint,text,uuid,jsonb)')" "true"
expect_value "0203 is idempotent (a second run is a no-op)" "$(apply 0203)" "ok"

echo "== Scenario 2: 0202 -> 0201 (the order the docs used to state) =="
baseline
expect_value "0202 applies first" "$(apply 0202)" "ok"
expect_value "0201 applies after 0202" "$(apply 0201)" "ok"
expect_value "HAZARD: 0201 re-creates the ledger type check WITHOUT payout_reversal" "$(types)" "f"
expect_value "0203 restores payout_reversal when applied right after" "$(apply 0203)" "ok"
expect_value "after 0203 payout_reversal is allowed again" "$(types)" "t"
baseline
expect_value "0202 applies first (again)" "$(apply 0202)" "ok"
"${PSQL[@]}" -q -c "INSERT INTO public.users (id, role) VALUES ('00000000-0000-0000-0000-00000000b001', 'user');
  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description)
  VALUES ('00000000-0000-0000-0000-00000000b001', 'payout_reversal', 100, 'reversal recorded before 0201');" >/dev/null 2>&1
R=$(apply 0201)
if [[ "$R" == *"violated by some row"* ]]; then pass "HAZARD: with a payout_reversal row present, 0201 after 0202 fails (rolled back)"
else fail "0201 after 0202 with a reversal row: expected a check violation, got '$R'"; fi
expect_value "the failed 0201 left nothing behind (transactional)" "$(has_fn 'public.get_my_representative_rewards()')" "false"

echo "== Scenario 3: 0192 first, then 0201 -> 0202 -> 0203 =="
baseline
expect_value "0192 applies on the baseline" "$(apply 0192)" "ok"
expect_value "0201 applies after 0192" "$(apply 0201)" "ok"
expect_value "0202 applies after 0192" "$(apply 0202)" "ok"
R=$(apply 0203)
if [[ "$R" == *"confirm_ticket_payment"*"differs from the definition"* ]]; then
  pass "0203 refuses: 0192 rewrote confirm_ticket_payment, so its md5 pin no longer matches (fails closed)"
else fail "0203 after 0192: expected an md5 refusal, got '$R'"; fi
expect_value "the refused 0203 left nothing behind (transactional)" "$(has_fn 'public.earnings_release_delay()')" "false"

echo "== Scenario 4: 0201 -> 0202 -> 0203, then 0192 =="
baseline
apply 0201 >/dev/null; apply 0202 >/dev/null; apply 0203 >/dev/null
R=$(apply 0192)
if [[ "$R" == *"completed_at"*"already exists"* ]]; then
  pass "0192 after 0203 fails on service_bookings.completed_at (0203 added it), and rolls back"
else fail "0192 after 0203: expected a completed_at conflict, got '$R'"; fi
expect_value "the failed 0192 left 0203's confirm_ticket_payment in place" "$(marker 'public.confirm_ticket_payment(text,bigint)')" "true"
# The tempting one-line "fix" (ADD COLUMN IF NOT EXISTS) is the dangerous
# one: 0192 then succeeds and silently replaces 0203's money functions.
sed 's/  ADD COLUMN completed_at timestamptz NULL,/  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL,/' "$(file_of 0192)" > "$TMP/0192_naive.sql"
expect_value "a naive IF NOT EXISTS edit makes 0192 apply after 0203" "$(apply 0192 "$TMP/0192_naive.sql")" "ok"
expect_value "HAZARD: ...and it silently removes 0203's patch from confirm_ticket_payment (fee model)" "$(marker 'public.confirm_ticket_payment(text,bigint)')" "false"
expect_value "HAZARD: ...and from credit_organizer_wallet (48-hour settlement hold)" "$(marker 'public.credit_organizer_wallet(uuid,bigint,text,uuid,jsonb)')" "false"

echo "== 0202 drift guard =="
baseline
R=$(LOCAL0202=off apply 0202)
if [[ "$R" == *"does not exist; this is not the database 0202 was written against"* ]]; then
  pass "without the local-test setting, 0202 refuses a database missing the payout functions it replaces"
else fail "0202 production-mode guard on the stub baseline: got '$R'"; fi
expect_value "the refused 0202 left nothing behind (transactional)" "$(has_fn 'public.reverse_organizer_payout(text)')" "false"
# Production-shaped payout functions: verbatim copies of the four whose live
# bodies are in the repository, plus the stub complete_organizer_payout
# (production's body is not in the repository).
python3 - "$MIG" > "$TMP/live_payout.sql" <<'PY'
import re, sys
mig = sys.argv[1]
want = {'admin_claim_payout_for_processing': '0124_emergency_kill_switches.sql',
        'admin_mark_payout_processing': '0004_functions.sql',
        'admin_release_payout_claim': '0004_functions.sql',
        'admin_cancel_processing_payout': '0187_fix_payout_reject_cancel_toctou_race.sql'}
pat = re.compile(r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z_0-9]+)\s*\(.*?\bAS\s+(\$[a-zA-Z_0-9]*\$).*?\2[^;]*;", re.S)
print("SET check_function_bodies = off;")
for fn, f in want.items():
    s = open(f"{mig}/{f}", encoding="utf8").read()
    last = [m.group(0) for m in pat.finditer(s) if m.group(1) == fn][-1]
    print(last)
PY
"${PSQL[@]}" -q -f - <"$TMP/live_payout.sql" >/dev/null 2>&1
expect_value "the four repository copies carry production's recorded bodies" \
  "$(val "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('admin_cancel_processing_payout','admin_claim_payout_for_processing','admin_mark_payout_processing','admin_release_payout_claim') AND pronamespace = 'public'::regnamespace;")" \
  "cea18083231d281ba2fee58e7610a774,89675182b62750b8631eb2de1d71211e,bf84ac786144b3ea3796fbc09f4bbec6,33dd4783b1bb7c4333b70bf32c671e02"
R=$(LOCAL0202=off apply 0202)
if [[ "$R" == *"complete_organizer_payout(text) differs from the definition"* ]]; then
  pass "0202 refuses when complete_organizer_payout is not the recorded production body (drift detected, names the function)"
else fail "0202 drift on complete_organizer_payout: got '$R'"; fi
# Simulate production exactly for the guard: pin the stub's own md5 as the
# "live" value in a copy of 0202, so the guard passes on matching bodies.
STUB=$(val "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.complete_organizer_payout(text)'::regprocedure;")
sed "s/563304a9394f6fb5148b2d458ce945f6/$STUB/" "$(file_of 0202)" > "$TMP/0202_pinned.sql"
expect_value "with every body matching its pin, 0202 applies in production mode" "$(LOCAL0202=off apply 0202 "$TMP/0202_pinned.sql")" "ok"
expect_value "a re-run of 0202 over its own bodies is accepted (idempotent)" "$(LOCAL0202=off apply 0202 "$TMP/0202_pinned.sql")" "ok"
apply 0201 >/dev/null
expect_value "0203 applies after the guarded 0202" "$(apply 0203)" "ok"
R=$(LOCAL0202=off apply 0202 "$TMP/0202_pinned.sql")
if [[ "$R" == *"differs from the definition"* ]]; then
  pass "re-running 0202 after 0203 is refused, so it can never undo 0203's payout changes"
else fail "0202 re-run after 0203: got '$R'"; fi
expect_value "...and 0203's patch is still in place" "$(marker 'public.confirm_ticket_payment(text,bigint)')" "true"
# The local relaxation cannot apply outside a vents_local_pg_* database.
pg -d postgres -q -c "DROP DATABASE IF EXISTS vents_guardcheck_prodname;" -c "CREATE DATABASE vents_guardcheck_prodname;" >/dev/null
R=$(sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 -d vents_guardcheck_prodname -q -1 \
     -c "SET vents.migration_local_test = 'on';" -f - <"$(file_of 0202)" 2>&1 >/dev/null | grep -m1 ERROR)
pg -d postgres -q -c "DROP DATABASE IF EXISTS vents_guardcheck_prodname;" >/dev/null
if [[ "$R" == *"does not exist; this is not the database 0202 was written against"* ]]; then
  pass "the local-test setting is ignored on a database not named vents_local_pg_* (production is 'postgres')"
else fail "local relaxation outside a local database: got '$R'"; fi

echo "== What 0192 adds that nothing else uses =="
baseline; apply 0192 >/dev/null
expect_value "0192 adds tickets.qualifying_status (the retired 30-day commission plan)" "$(has_col tickets qualifying_status)" "true"
N=$(grep -rlE "qualifying_status|platform_fee_reversals|payment_disputes|platform_fee_reconciliation" "$REPO_ROOT/src" "$REPO_ROOT/api" --include=*.ts --include=*.tsx 2>/dev/null | grep -v '\.test\.' | wc -l)
expect_value "no app or API code reads qualifying_status, platform_fee_reversals, payment_disputes or the reconciliation view" "$N" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES MIGRATION ORDER CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
