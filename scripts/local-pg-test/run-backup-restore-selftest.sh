#!/usr/bin/env bash
# Self-test for scripts/ops/verify-backup-restore.sh, entirely local: builds
# a database holding the 19 pre-apply functions (from the rollback snapshot),
# dumps it, and checks the drill reports 19/19; then drifts one function and
# checks the drill fails and names it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
SRC_DB="vents_local_pg_backup_src"
SOCKET_DIR="/var/run/postgresql"
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || { echo "REFUSING TO RUN: no local PostgreSQL socket" >&2; exit 2; }
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || { echo "REFUSING TO RUN: not a local, non-Supabase server" >&2; exit 2; }

TMP=$(mktemp -d); chmod 755 "$TMP"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $SRC_DB;" >/dev/null 2>&1 || true; }
trap cleanup EXIT
PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }

pg -d postgres -q -c "DROP DATABASE IF EXISTS $SRC_DB;" -c "CREATE DATABASE $SRC_DB;" >/dev/null
for f in schema-vents-earn.sql; do pg -d "$SRC_DB" -q -f "$SCRIPT_DIR/$f" >/dev/null; done
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  pg -d "$SRC_DB" -q -f "$MIG/$m.sql" >/dev/null
done
for f in schema-representative-rewards.sql schema-live-payout-extras.sql schema-earnings-policies.sql live-money-functions.sql; do
  pg -d "$SRC_DB" -q -f "$SCRIPT_DIR/$f" >/dev/null
done
# The production pre-apply state of all 19 functions.
pg -d "$SRC_DB" -q -1 -c "SET check_function_bodies = off; SET vents.rollback_confirm = 'restore-pre-0201-0203';" \
  -f - <"$REPO_ROOT/supabase/rollback/pre_0201_0203_functions.sql" >/dev/null
sudo -u postgres env -i PATH="/usr/bin:/bin" pg_dump -h "$SOCKET_DIR" -p 5432 -Fc -d "$SRC_DB" > "$TMP/good.dump"

OUT=$(bash "$REPO_ROOT/scripts/ops/verify-backup-restore.sh" "$TMP/good.dump" 2>&1); RC=$?
if [ $RC -eq 0 ] && [[ "$OUT" == *"Functions matching: 19/19"* ]]; then pass "a backup holding the pre-apply functions verifies 19/19"
else fail "good backup: rc=$RC $(echo "$OUT" | tail -3)"; fi
if [[ "$OUT" == *"organizer_withdrawal_requests"* ]]; then pass "the drill reports the money-table counts"; else fail "no money-table counts"; fi

pg -d "$SRC_DB" -q -c "CREATE OR REPLACE FUNCTION public.get_event_analytics(p_event_id uuid) RETURNS jsonb LANGUAGE sql AS \$\$ SELECT '{}'::jsonb \$\$;" >/dev/null
sudo -u postgres env -i PATH="/usr/bin:/bin" pg_dump -h "$SOCKET_DIR" -p 5432 -Fc -d "$SRC_DB" > "$TMP/drifted.dump"
OUT=$(bash "$REPO_ROOT/scripts/ops/verify-backup-restore.sh" "$TMP/drifted.dump" 2>&1); RC=$?
if [ $RC -ne 0 ] && [[ "$OUT" == *"MISMATCH  get_event_analytics"* ]] && [[ "$OUT" == *"Functions matching: 18/19"* ]]; then
  pass "a backup with a drifted function fails and names it"
else fail "drifted backup: rc=$RC $(echo "$OUT" | grep -E 'MISMATCH|matching')"; fi

OUT=$(DATABASE_URL=postgres://example.invalid/db bash "$REPO_ROOT/scripts/ops/verify-backup-restore.sh" "$TMP/good.dump" 2>&1); RC=$?
if [ $RC -eq 2 ] && [[ "$OUT" == *"REFUSING TO RUN"* ]]; then pass "the drill refuses to run when a hosted database URL is in the environment"
else fail "drill with DATABASE_URL set: rc=$RC"; fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES BACKUP RESTORE SELF-TEST CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
