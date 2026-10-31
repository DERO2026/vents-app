#!/usr/bin/env bash
# Restore drill for a production backup, run by the owner on their own
# machine (or here, against a local file). It restores the dump into a
# THROWAWAY LOCAL database only -- never a hosted one -- then reports:
#   * row counts of the money tables (compare with the production counts the
#     owner captured at backup time, runbook P4/W2);
#   * whether each of the 19 functions 0201-0203 replace is present with the
#     expected pre-apply md5 (the md5 table in
#     supabase/rollback/pre_0201_0203_functions.sql).
# Exit 0 only when every function matches. Usage:
#   scripts/ops/verify-backup-restore.sh path/to/backup.dump   (pg_dump -Fc)
#   scripts/ops/verify-backup-restore.sh path/to/backup.sql    (plain SQL)
# A Supabase dump also contains roles, extensions and schemas a local server
# lacks; those statements fail and are counted, the public schema is what is
# checked.
set -uo pipefail

DUMP="${1:-}"
[ -n "$DUMP" ] && [ -r "$DUMP" ] || { echo "usage: $0 <backup.dump|backup.sql>" >&2; exit 2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SNAP="$REPO_ROOT/supabase/rollback/pre_0201_0203_functions.sql"
DB_NAME="${VERIFY_DB_NAME:-vents_local_pg_backup_restore}"
SOCKET_DIR="/var/run/postgresql"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then die "\$$var is set. Unset it; this drill only restores into a local server."; fi
done
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z_]+$ ]] || die "database name '$DB_NAME' is not a local test name."
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || die "no local PostgreSQL socket at $SOCKET_DIR."
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 "$@"; }
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || die "connection is not a local, non-Supabase PostgreSQL server ($server_check)."

TMP=$(mktemp -d); chmod 755 "$TMP"
cleanup() { rm -rf "$TMP"; [ -n "${KEEP_DB:-}" ] || pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;" >/dev/null
cp "$DUMP" "$TMP/backup"; chmod 644 "$TMP/backup"
if head -c 5 "$TMP/backup" | grep -q "PGDMP"; then
  sudo -u postgres env -i PATH="/usr/bin:/bin" pg_restore -h "$SOCKET_DIR" -p 5432 -d "$DB_NAME" --no-owner --no-privileges "$TMP/backup" >"$TMP/restore.log" 2>&1
else
  pg -d "$DB_NAME" -q -f "$TMP/backup" >"$TMP/restore.log" 2>&1
fi
ERRS=$(grep -c "ERROR" "$TMP/restore.log" || true)
echo "Restored $(basename "$DUMP") into local $DB_NAME ($ERRS statement errors; roles/extensions a local server lacks are expected)"

echo "== Money tables (compare with the counts captured at backup time) =="
for t in organizer_wallets organizer_transactions organizer_withdrawal_requests organizer_bank_accounts tickets pending_purchases service_bookings user_wallets admin_action_requests admin_logs; do
  n=$(pg -d "$DB_NAME" -tA -c "SELECT CASE WHEN to_regclass('public.$t') IS NULL THEN 'missing' ELSE (SELECT count(*)::text FROM public.$t) END;" 2>/dev/null | tail -n1)
  printf '  %-32s %s\n' "$t" "$n"
done
echo "  wallet sum (balance/pending): $(pg -d "$DB_NAME" -tA -c "SELECT COALESCE(sum(balance_kobo),0) || '/' || COALESCE(sum(pending_kobo),0) FROM public.organizer_wallets;" 2>/dev/null | tail -n1)"

echo "== The 19 functions 0201-0203 replace (expected pre-apply md5) =="
OK=0; BAD=0
while read -r fn md5; do
  got=$(pg -d "$DB_NAME" -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE proname = '$fn' AND pronamespace = 'public'::regnamespace;" 2>/dev/null | tail -n1)
  if [ "$got" = "$md5" ]; then OK=$((OK+1)); printf '  ok        %s\n' "$fn"
  else BAD=$((BAD+1)); printf '  MISMATCH  %s (got %s, expected %s)\n' "$fn" "${got:-missing}" "$md5"; fi
done < <(grep -oE '^-- [a-z_0-9]+  \(production md5 [0-9a-f]{32}' "$SNAP" | sed -E 's/^-- ([a-z_0-9]+)  \(production md5 ([0-9a-f]{32})/\1 \2/')
echo "Functions matching: $OK/$((OK+BAD))"
[ "$BAD" -eq 0 ]
