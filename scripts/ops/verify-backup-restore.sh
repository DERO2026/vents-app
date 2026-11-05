#!/usr/bin/env bash
# Restore drill for a production backup, run by the owner on their own
# Linux/WSL or macOS (Homebrew postgresql@17) machine, or here against a
# local file. It restores the dump into a
# THROWAWAY LOCAL database only -- never a hosted one -- then reports:
#   * row counts of the money tables (compare with the production counts the
#     owner captured at backup time, runbook P4/W2);
#   * whether each of the 19 functions 0201-0203 replace is present with the
#     expected pre-apply md5 (the md5 table in
#     supabase/rollback/pre_0201_0203_functions.sql).
#   * whether every public table in the backup was restored.
# Exit 0 only when every function matches and every public table restored. Usage:
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

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then die "\$$var is set. Unset it; this drill only restores into a local server."; fi
done
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z_]+$ ]] || die "database name '$DB_NAME' is not a local test name."
# Linux or macOS (Homebrew) local server: see _local_pg.sh.
. "$SCRIPT_DIR/_local_pg.sh" || { echo "REFUSING TO RUN: scripts/ops/_local_pg.sh missing" >&2; exit 2; }
vents_require_local_server

TMP="$(vents_mktemp)"
cleanup() { rm -rf "$TMP"; [ -n "${KEEP_DB:-}" ] || pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;" >/dev/null
cp "$DUMP" "$TMP/backup"; chmod "$(vents_file_mode)" "$TMP/backup"
if head -c 5 "$TMP/backup" | grep -q "PGDMP"; then
  pgtool pg_restore -h "$SOCKET_DIR" -p 5432 -d "$DB_NAME" --no-owner --no-privileges "$TMP/backup" >"$TMP/restore.log" 2>&1
else
  pg -d "$DB_NAME" -q -f "$TMP/backup" >"$TMP/restore.log" 2>&1
fi
ERRS=$(grep -c "ERROR" "$TMP/restore.log" || true)
echo "Restored $(basename "$DUMP") into local $DB_NAME ($ERRS statement errors; roles/extensions a local server lacks are expected)"

# Every public table in the backup must exist after the restore. Statement
# errors are expected for Supabase-only objects, but a public table that
# failed to restore is a real loss and must not hide among them. Names only;
# the restore log (which can hold row data) is never printed.
if head -c 5 "$TMP/backup" | grep -q "PGDMP"; then
  pgtool pg_restore -l "$TMP/backup" 2>/dev/null \
    | awk '$4 == "TABLE" && $5 == "public" { print $6 }' | sort -u >"$TMP/expected_tables"
else
  grep -oE '^CREATE (UNLOGGED )?TABLE public\.[A-Za-z_0-9]+' "$TMP/backup" | sed -E 's/.*public\.//' | sort -u >"$TMP/expected_tables"
fi
pg -d "$DB_NAME" -tA -c "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p');" \
  | sort -u >"$TMP/restored_tables"
TBL_TOTAL=$(wc -l <"$TMP/expected_tables" | tr -d ' ')
MISSING_TABLES=$(comm -23 "$TMP/expected_tables" "$TMP/restored_tables")
TBL_MISSING=$(printf '%s' "$MISSING_TABLES" | grep -c . || true)
echo "== Public tables restored: $((TBL_TOTAL - TBL_MISSING))/$TBL_TOTAL =="
[ -z "$MISSING_TABLES" ] || printf '  NOT RESTORED  %s\n' $MISSING_TABLES

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
[ "$BAD" -eq 0 ] && [ "$TBL_MISSING" -eq 0 ] && [ "$TBL_TOTAL" -gt 0 ]
