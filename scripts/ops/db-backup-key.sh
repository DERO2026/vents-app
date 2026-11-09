#!/usr/bin/env bash
# Writes the backup encryption passphrase to <key-file> (mode 600) and the
# name of its source to <mode-file>; prints only the source, never the value.
# (Do not capture this script's stdout: in CI it carries the ::add-mask::
# command, which only works when the runner sees it.)
#
#   1. BACKUP_ENCRYPTION_PASSPHRASE, if that secret exists in the o4-backup
#      environment (recommended: independent of the database password).
#   2. Otherwise derived from BACKUP_DB_URL (the DATABASE_URL secret):
#        HMAC-SHA256(key = "vents-db-backup-v1", message = the full URL), hex.
#      Anyone holding the database URL can decrypt -- no worse than the URL
#      itself, which can read the live database -- but if the database
#      password is ever changed, backups taken before the change can only be
#      decrypted with the OLD URL. Recreate it by hand with:
#        printf '%s' "$OLD_URL" | openssl dgst -sha256 -hmac vents-db-backup-v1 -r | cut -d' ' -f1
#
# Usage: db-backup-key.sh <key-file> <mode-file>
set -euo pipefail
KEY="${1:?usage: $0 <key-file> <mode-file>}"
MODE_FILE="${2:?usage: $0 <key-file> <mode-file>}"
umask 077
if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  [ "${#BACKUP_ENCRYPTION_PASSPHRASE}" -ge 24 ] || { echo "STOP: BACKUP_ENCRYPTION_PASSPHRASE is shorter than 24 characters" >&2; exit 1; }
  printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" >"$KEY"
  MODE="passphrase-secret"
elif [ -n "${BACKUP_DB_URL:-}" ]; then
  printf '%s' "$BACKUP_DB_URL" | openssl dgst -sha256 -hmac vents-db-backup-v1 -r | cut -d' ' -f1 | tr -d '\n' >"$KEY"
  MODE="derived-from-DATABASE_URL"
else
  echo "STOP: neither BACKUP_ENCRYPTION_PASSPHRASE nor the database URL is available" >&2; exit 1
fi
[ "$(wc -c <"$KEY")" -ge 24 ] || { echo "STOP: passphrase file is empty or too short" >&2; exit 1; }
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::add-mask::$(cat "$KEY")"; fi
echo "$MODE" >"$MODE_FILE"
echo "ok: encryption passphrase source: $MODE"
