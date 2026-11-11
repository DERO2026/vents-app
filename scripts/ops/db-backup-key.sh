#!/usr/bin/env bash
# Writes the backup encryption passphrase to <key-file> (mode 600), the name
# of its source to <mode-file> and its public fingerprint to <fp-file>;
# prints only the source and the fingerprint, never the value.
# (Do not capture this script's stdout: in CI it carries the ::add-mask::
# command, which only works when the runner sees it.)
#
# Backups (the workflow): the key is ALWAYS the o4-backup environment secret
# BACKUP_ENCRYPTION_PASSPHRASE (at least 32 characters). There is no
# fallback: without the secret the run stops, so a backup can never be
# encrypted with a key the owner does not hold independently of GitHub.
#
# Legacy artifacts only (taken before this rule, manifest key_source=
# derived-from-DATABASE_URL, e.g. runs #20 and #22): --legacy-derived
# rebuilds that key from BACKUP_DB_URL, which must be the EXACT secret value
# those runs used, byte for byte (trailing whitespace included):
#   HMAC-SHA256(key = "vents-db-backup-v1", message = the raw secret), hex.
# It refuses to run on a GitHub runner, so no backup can use it.
#
# The fingerprint (scripts/ops/db-backup-key-fingerprint.sh) lets the owner
# check, without revealing anything usable, that their own copy of the
# passphrase is the one a backup was encrypted with.
#
# Usage: db-backup-key.sh <key-file> <mode-file> [<fp-file>]
#        db-backup-key.sh --legacy-derived <key-file> <mode-file> [<fp-file>]
set -euo pipefail
LEGACY=0
if [ "${1:-}" = "--legacy-derived" ]; then LEGACY=1; shift; fi
KEY="${1:?usage: $0 [--legacy-derived] <key-file> <mode-file> [<fp-file>]}"
MODE_FILE="${2:?usage: $0 [--legacy-derived] <key-file> <mode-file> [<fp-file>]}"
FP_FILE="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
umask 077
if [ "$LEGACY" = 1 ]; then
  [ "${GITHUB_ACTIONS:-}" != "true" ] || { echo "STOP: --legacy-derived is for decrypting old artifacts on your own machine, never in a workflow" >&2; exit 1; }
  [ -n "${BACKUP_DB_URL:-}" ] || { echo "STOP: --legacy-derived needs BACKUP_DB_URL = the exact secret value the old run used" >&2; exit 1; }
  printf '%s' "$BACKUP_DB_URL" | openssl dgst -sha256 -hmac vents-db-backup-v1 -r | cut -d' ' -f1 | tr -d '\n' >"$KEY"
  MODE="derived-from-DATABASE_URL"
else
  [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ] || {
    echo "STOP: the o4-backup environment secret BACKUP_ENCRYPTION_PASSPHRASE is missing or empty." >&2
    echo "      Backups are only encrypted with that independently stored passphrase. See docs/db-backup.md." >&2
    exit 1; }
  [ "${#BACKUP_ENCRYPTION_PASSPHRASE}" -ge 32 ] || { echo "STOP: BACKUP_ENCRYPTION_PASSPHRASE is shorter than 32 characters (generate one with: openssl rand -base64 32)" >&2; exit 1; }
  printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" >"$KEY"
  MODE="passphrase-secret"
fi
[ "$(wc -c <"$KEY")" -ge 32 ] || { echo "STOP: passphrase file is empty or too short" >&2; exit 1; }
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::add-mask::$(cat "$KEY")"; fi
echo "$MODE" >"$MODE_FILE"
FP="$(bash "$SCRIPT_DIR/db-backup-key-fingerprint.sh" "$KEY")"
[ -z "$FP_FILE" ] || echo "$FP" >"$FP_FILE"
echo "ok: encryption passphrase source: $MODE, fingerprint: $FP"
