#!/usr/bin/env bash
# Proves an encrypted backup is usable, without touching any hosted database:
#   1. decrypts it (gpg verifies integrity; a wrong key or a damaged file fails);
#   2. reads the archive's table of contents with pg_restore -l;
#   3. restores it into a THROWAWAY LOCAL database with
#      scripts/ops/verify-backup-restore.sh (which refuses hosted servers) and
#      requires every public table, with exactly the rows the backup carries;
#   4. shreds the decrypted copy.
# Only pass/fail lines are printed: the drill's full report (row counts, wallet
# sums) stays in <report-dir>, which is never uploaded.
#
# Usage: db-backup-validate.sh <backup.dump.gpg> <passphrase-file> <report-dir>
# Env:   FUNCTION_CHECK=report (default) | enforce -- enforce also requires the
#        19 pre-0201 function fingerprints (the O4 rehearsal check).
set -uo pipefail
ENC="${1:-}"; KEY="${2:-}"; REPORT="${3:-}"
[ -n "$ENC" ] && [ -n "$KEY" ] && [ -n "$REPORT" ] || { echo "usage: $0 <backup.dump.gpg> <passphrase-file> <report-dir>" >&2; exit 2; }
for v in BACKUP_DB_URL DATABASE_URL BACKUP_ENCRYPTION_PASSPHRASE; do
  [ -z "${!v:-}" ] || { echo "REFUSING TO RUN: \$$v is set; validation must not see production credentials" >&2; exit 2; }
done
export FUNCTION_CHECK="${FUNCTION_CHECK:-report}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
umask 077
mkdir -p "$REPORT"
PLAIN="$(mktemp -d)"; GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
cleanup() { [ -f "$PLAIN/backup.dump" ] && shred -u "$PLAIN/backup.dump"; rm -rf "$PLAIN" "$GNUPGHOME"; }
trap cleanup EXIT
fail() { echo "BACKUP VALIDATION FAILED: $1"; exit 1; }

[ -s "$ENC" ] || fail "encrypted backup $ENC is missing or empty"
gpg --batch --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-file "$KEY" \
    -o "$PLAIN/backup.dump" -d "$ENC" 2>"$REPORT/gpg.err" || fail "decryption failed (wrong key, or the file is damaged or truncated)"
echo "ok: decrypted and integrity-checked"

[ "$(head -c 5 "$PLAIN/backup.dump")" = "PGDMP" ] || fail "decrypted file is not a pg_dump custom-format archive"
pg_restore -l "$PLAIN/backup.dump" >"$REPORT/toc.txt" 2>"$REPORT/toc.err" || fail "pg_restore cannot read the archive's table of contents"
TOC_TABLES=$(awk '$4 == "TABLE" && $5 == "public"' "$REPORT/toc.txt" | wc -l | tr -d ' ')
TOC_DATA=$(awk '$4 == "TABLE" && $5 == "DATA" && $6 == "public"' "$REPORT/toc.txt" | wc -l | tr -d ' ')
TOC_FUNCS=$(awk '$4 == "FUNCTION" && $5 == "public"' "$REPORT/toc.txt" | wc -l | tr -d ' ')
echo "archive: $TOC_TABLES public tables, $TOC_DATA with data, $TOC_FUNCS public functions"
[ "$TOC_TABLES" -gt 0 ] || fail "the archive holds no public tables"
[ "$TOC_DATA" -gt 0 ] || fail "the archive holds no public table data"

bash "$SCRIPT_DIR/verify-backup-restore.sh" "$PLAIN/backup.dump" >"$REPORT/drill.txt" 2>"$REPORT/drill.err"
DRILL_RC=$?
shred -u "$PLAIN/backup.dump"
echo "ok: decrypted copy shredded"

tables=$(grep -E '^== Public tables restored: ' "$REPORT/drill.txt" | sed -E 's/^== (.*) ==$/\1/')
rows=$(grep -E '^== Public table rows matching the backup: ' "$REPORT/drill.txt" | sed -E 's/^== (.*) ==$/\1/')
funcs=$(grep -E '^Functions matching: ' "$REPORT/drill.txt")
echo "${tables:-Public tables restored: (missing)}"
echo "${rows:-Public table rows matching the backup: (missing)}"
echo "${funcs:-Functions matching: (missing)}"
grep -E '^  (NOT RESTORED|ROW MISMATCH) ' "$REPORT/drill.txt" || true
if [ "$FUNCTION_CHECK" = enforce ]; then grep -E '^  MISMATCH ' "$REPORT/drill.txt" | sed -E 's/ \(got .*$//' || true; fi
grep -q 'REFUSING TO RUN' "$REPORT/drill.err" && sed -n 's/^REFUSING TO RUN/drill refused:/p' "$REPORT/drill.err"
bad=0
[ "$DRILL_RC" = 0 ] || { echo "FAIL: restore drill exit $DRILL_RC"; bad=1; }
echo "$tables" | grep -qE '^Public tables restored: ([0-9]+)/\1$' || { echo "FAIL: not every public table restored"; bad=1; }
echo "$rows" | grep -qE '^Public table rows matching the backup: ([0-9]+)/\1$' || { echo "FAIL: restored rows differ from the backup"; bad=1; }
n=$(echo "$tables" | sed -nE 's/^Public tables restored: ([0-9]+)\/[0-9]+$/\1/p')
[ "${n:-0}" = "$TOC_TABLES" ] || { echo "FAIL: drill restored ${n:-?} tables, archive lists $TOC_TABLES"; bad=1; }
if [ "$FUNCTION_CHECK" = enforce ]; then
  echo "$funcs" | grep -qE '^Functions matching: 19/19 ' || { echo "FAIL: function fingerprints are not 19/19 (FUNCTION_CHECK=enforce)"; bad=1; }
fi
{ echo "public_tables=$TOC_TABLES"; echo "public_tables_with_data=$TOC_DATA"; echo "public_functions=$TOC_FUNCS"
  echo "restore_tables=${tables#Public tables restored: }"; echo "restore_rows=${rows#Public table rows matching the backup: }"
  echo "function_fingerprints=${funcs#Functions matching: }"; } >"$REPORT/summary.txt"
[ "$bad" = 0 ] || fail "see the lines above"
echo "BACKUP VERIFIED: decrypts, restores every public table with every row into a local database"
