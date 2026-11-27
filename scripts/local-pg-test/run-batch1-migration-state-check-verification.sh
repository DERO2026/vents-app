#!/usr/bin/env bash
# Tests scripts/ops/batch1-migration-state-check.sql (the read-only Batch 1
# production state check) on local databases in every state it must tell
# apart: before Batch 1 (0226 only), after each of 0233-0238, a partially
# applied migration, a drifted function, and a database without 0226.
# Proves it is read-only: the catalog fingerprint is identical before and
# after, and a write slipped into the script is refused by PostgreSQL.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
CHECK="$REPO_ROOT/scripts/ops/batch1-migration-state-check.sql"
DB_NAME="vents_local_pg_batch1_state_check"
SOCKET_DIR="/var/run/postgresql"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL BACKUP_DB_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then die "\$$var is set. Unset it; this test only connects to the local Unix socket."; fi
done
if env | grep -qiE 'supabase\.(co|com)|pooler\.|rds\.amazonaws\.com|neon\.tech|render\.com'; then
  die "an environment variable references a hosted database host."
fi
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z_0-9]+$ ]] || die "database name '$DB_NAME' is not a local test name."
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || die "no local PostgreSQL socket at $SOCKET_DIR (start it: pg_ctlcluster 16 main start)."
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }
PSQL=(pg -d "$DB_NAME")
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || die "connection is not a local, non-Supabase PostgreSQL server ($server_check)."

TMP=$(mktemp -d); OUT="$TMP/out"; ERR="$TMP/err"
chmod 777 "$TMP"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
# shellcheck source=lib-money-stack.sh
. "$SCRIPT_DIR/lib-money-stack.sh"

run_check() { "${PSQL[@]}" -q -tA -F'|' -f "$CHECK" >"$TMP/report" 2>"$ERR"; }
summary() { run_check; awk -F'|' '$1=="summary"{printf "%s=%s ", $2, $4}' "$TMP/report" | sed 's/ $//'; }
field() { awk -F'|' -v s="$1" -v m="$2" -v i="$3" '$1==s && $2==m && $3==i {print $4}' "$TMP/report"; }
count_status() { awk -F'|' -v s="$1" -v st="$2" '$1==s && $4==st' "$TMP/report" | wc -l | tr -d ' '; }
FP="SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || COALESCE(array_to_string(p.proacl, ','), ''), '|' ORDER BY 1)) || (SELECT md5(string_agg(polname || pg_get_expr(polqual, polrelid), '|' ORDER BY polname)) FROM pg_policy) || (SELECT count(*) FROM pg_class)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"

echo "== Building throwaway database $DB_NAME =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
build_ticket_stack
"${PSQL[@]}" -q <<SQL
GRANT SELECT ON public.events TO anon;
ALTER FUNCTION public.is_admin() SECURITY DEFINER SET search_path TO '';
CREATE TABLE IF NOT EXISTS organizer_reviews (id uuid NOT NULL DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL, reviewer_id uuid NOT NULL, rating smallint NOT NULL, body text NOT NULL, created_at timestamptz DEFAULT now());
ALTER TABLE organizer_reviews ENABLE ROW LEVEL SECURITY;
$(grep -E '^CREATE POLICY organizer_reviews_' "$MIG/0008_rls_and_policies.sql")
CREATE TABLE IF NOT EXISTS public.vc_event_boosts (event_id uuid, user_id uuid, expires_at timestamptz, boosted_at timestamptz DEFAULT now(), PRIMARY KEY (event_id, user_id));
CREATE OR REPLACE FUNCTION public._vc_deduct(p_user uuid, p_amount integer, p_reason text) RETURNS void LANGUAGE sql AS \$\$ SELECT NULL \$\$;
SQL
"${PSQL[@]}" -q -c "SET search_path TO public; $(awk '/^-- Function: boost_event_vc$/{f=1;next} f&&/^-- Function:/{exit} f' "$MIG/0004_functions.sql")"
"${PSQL[@]}" -q -c "$(grep -E 'boost_event_vc' "$MIG/0011_grants.sql")"

echo "-- before Batch 1 (0226 only) --"
BEFORE=$(val "$FP")
expect_value "summary" "$(summary)" "0226=APPLIED 0233=MISSING 0234=MISSING 0235=MISSING 0236=MISSING 0237=MISSING 0238=MISSING"
expect_value "the check changed nothing (catalog fingerprint identical)" "$(val "$FP")" "$BEFORE"
expect_value "0226 functions match the repository" "$(awk -F'|' '$1=="checksum" && $2=="0226" {print $4}' "$TMP/report" | sort -u | tr '\n' ' ')" "MATCHES "
expect_value "0233 is READY" "$(awk -F'|' '$1=="precheck" && $2=="0233" {print $4}' "$TMP/report" | sort -u | tr '\n' ' ')" "READY "
expect_value "0234 is READY (pins and both maker-checker anchors)" "$(awk -F'|' '$1=="precheck" && $2=="0234" {print $4}' "$TMP/report" | sort -u | tr '\n' ' ')" "READY "
expect_value "0235/0236/0237 are READY" "$(awk -F'|' '$1=="precheck" && ($2=="0235"||$2=="0236"||$2=="0237") {print $4}' "$TMP/report" | sort -u | tr '\n' ' ')" "READY "
expect_value "0238 is BLOCKED until 0233 and 0234" "$(awk -F'|' '$1=="precheck" && $2=="0238" {print $4}' "$TMP/report" | sort -u | tr '\n' ' ')" "BLOCKED "
expect_value "AZ-09: the reject function is the atomic one" "$(field safety AZ-09 'admin_reject_organizer_payout claims atomically')" "OK"
expect_value "no migration history table -> said so" "$(field history - 'last 15 entries of supabase_migrations (informational)')" "info"

echo "-- read-only proof --"
sed 's/^ROLLBACK;$/CREATE TABLE public.state_check_write_probe (x int);\nROLLBACK;/' "$CHECK" > "$TMP/with_write.sql"
if "${PSQL[@]}" -q -tA -f "$TMP/with_write.sql" >"$OUT" 2>"$ERR"; then fail "a write inside the check was NOT refused"; else
  grep -q "read-only transaction" "$ERR" && pass "a write slipped into the check is refused (READ ONLY transaction)" || { fail "unexpected error"; cat "$ERR" >&2; }; fi
expect_value "...and nothing was created" "$(val "SELECT to_regclass('public.state_check_write_probe') IS NULL;")" "t"
expect_value "the script contains no write or DDL statements" \
  "$(grep -viE '^\s*--' "$CHECK" | grep -ciE '\b(insert into|update public|delete from|create (table|function|policy|index)|alter |drop |grant |revoke |truncate)\b' || true)" "0"

echo "-- applying Batch 1 step by step --"
step() { expect_ok "$1 applies" "$(cat "$MIG/$1"*.sql)"; }
step 0233; expect_value "after 0233" "$(summary)" "0226=APPLIED 0233=APPLIED 0234=MISSING 0235=MISSING 0236=MISSING 0237=MISSING 0238=MISSING"
step 0234; expect_value "after 0234" "$(summary)" "0226=APPLIED 0233=APPLIED 0234=APPLIED 0235=MISSING 0236=MISSING 0237=MISSING 0238=MISSING"
expect_value "0238 is now READY" "$(awk -F'|' '$1=="precheck" && $2=="0238" {print $4}' "$TMP/report" | sort -u | tr '\n' ' ')" "READY "
step 0235; step 0236; step 0237; step 0238
expect_value "all applied" "$(summary)" "0226=APPLIED 0233=APPLIED 0234=APPLIED 0235=APPLIED 0236=APPLIED 0237=APPLIED 0238=APPLIED"
expect_value "every checksum matches the repository (later replacements accepted)" "$(count_status checksum DIFFERS)/$(count_status checksum absent)" "0/0"
expect_value "prechecks report n/a once applied" "$(awk -F'|' '$1=="precheck" {print $4}' "$TMP/report" | sort -u | tr '\n' ' ')" "n/a (applied) "

echo "-- partial and drifted states are flagged --"
"${PSQL[@]}" -q -c "DROP FUNCTION public.start_payment_exception_refund(uuid, text);"
expect_value "a missing function makes 0234 PARTIAL" "$(summary | grep -o '0234=[A-Z]*')" "0234=PARTIAL"
expect_value "...and its checksum row says absent" "$(field checksum 0234 start_payment_exception_refund)" "absent"
"${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.user_holds_ticket_for_event(p_event_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS \$f\$ SELECT true \$f\$;"
run_check
expect_value "a function edited by hand is reported as DIFFERS" "$(field checksum 0236 user_holds_ticket_for_event)" "DIFFERS"
"${PSQL[@]}" -q -c "CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text); INSERT INTO supabase_migrations.schema_migrations VALUES ('20261120000000', 'payment_exceptions');"
run_check
expect_value "migration history names are listed when the table exists" "$(awk -F'|' '$1=="history" {print $5}' "$TMP/report")" "20261120000000 payment_exceptions"

echo "-- a database without 0226 --"
"${PSQL[@]}" -q -c "DROP TABLE public.payment_exceptions CASCADE;"
expect_value "0226 shows PARTIAL when its table is gone but functions remain" "$(summary | grep -o '0226=[A-Z]*')" "0226=PARTIAL"
expect_value "0233 (whose column and check went with that table) is then PARTIAL" "$(summary | grep -o '0233=[A-Z]*')" "0233=PARTIAL"
expect_value "...and its precheck says 0226 is missing (BLOCKED)" "$(field precheck 0233 '0226 present (payment_exceptions)')" "BLOCKED"
expect_value "the report never prints connection details" "$(grep -ciE 'postgres(ql)?://|password|sslmode' "$TMP/report" || true)" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES BATCH 1 STATE CHECK VERIFICATIONS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
