#!/usr/bin/env bash
# Prints the public fingerprint of a backup passphrase file: the first 16 hex
# characters of SHA-256("vents-db-backup-key-check-v1:" + passphrase).
#
# It is recorded in every backup's manifest (key_fingerprint=...). Compute it
# from your own copy of the passphrase to confirm, before decrypting, that it
# is the key that backup was encrypted with. It reveals nothing usable: a
# 32-byte random passphrase cannot be recovered from it, and anyone with the
# public artifact can already test a guessed passphrase against the ciphertext.
#
# The passphrase is read from the file (never a command-line argument, which
# other processes could see). The file must hold the passphrase with no
# trailing newline, exactly as the workflow writes it:
#   printf '%s' 'the-passphrase' > key.txt      (or see docs/db-backup.md)
#
# Usage: db-backup-key-fingerprint.sh <key-file>
set -euo pipefail
KEY="${1:?usage: $0 <key-file>}"
[ -s "$KEY" ] || { echo "STOP: key file $KEY is missing or empty" >&2; exit 1; }
if [ "$(tail -c 1 "$KEY" | od -An -c | tr -d ' ')" = '\n' ]; then
  echo "STOP: $KEY ends with a newline; the workflow's key has none. Recreate it with printf '%s'" >&2; exit 1
fi
{ printf '%s' 'vents-db-backup-key-check-v1:'; cat "$KEY"; } | sha256sum | cut -c1-16
