#!/usr/bin/env bash
# Decrypts a downloaded backup artifact on your own machine, checking first
# that the file is intact and that your key is the one it was encrypted with.
#
#   1. sha256sum -c on the .sha256 file in the artifact, and the same value
#      as the manifest's sha256= line;
#   2. the manifest's key_fingerprint= must equal the fingerprint of your key
#      file (a mismatch stops here, before any decryption). Manifests from
#      before fingerprints existed (runs #20, #22) have none: the script says
#      so and relies on gpg, which fails loudly on a wrong key;
#   3. gpg decrypts to <out.dump> (mode 600). Restore it ONLY into a new,
#      empty database, never production: see docs/db-backup.md.
#
# Usage: db-backup-decrypt.sh <unzipped-artifact-dir> <key-file> <out.dump>
set -euo pipefail
DIR="${1:?usage: $0 <artifact-dir> <key-file> <out.dump>}"
KEY="${2:?usage: $0 <artifact-dir> <key-file> <out.dump>}"
OUT="${3:?usage: $0 <artifact-dir> <key-file> <out.dump>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
umask 077
M="$DIR/manifest.txt"
[ -f "$M" ] || { echo "STOP: $M not found (unzip the whole artifact)" >&2; exit 1; }
field() { sed -n "s/^$1=//p" "$M" | head -1; }
FILE="$(field file)"; SUM="$(field sha256)"; SRC="$(field key_source)"; WANT_FP="$(field key_fingerprint)"
[ -n "$FILE" ] && [ -f "$DIR/$FILE" ] && [ -f "$DIR/$FILE.sha256" ] || { echo "STOP: the manifest's file= is missing from $DIR" >&2; exit 1; }
( cd "$DIR" && sha256sum -c --quiet "$FILE.sha256" ) || { echo "STOP: checksum mismatch: the file is damaged or not the one that was backed up" >&2; exit 1; }
GOT="$(sha256sum "$DIR/$FILE" | cut -d' ' -f1)"
[ "$GOT" = "$SUM" ] || { echo "STOP: the file's sha256 differs from the manifest's" >&2; exit 1; }
echo "ok: sha256 $GOT matches the .sha256 file and the manifest"
HAVE_FP="$(bash "$SCRIPT_DIR/db-backup-key-fingerprint.sh" "$KEY")"
if [ -n "$WANT_FP" ]; then
  [ "$HAVE_FP" = "$WANT_FP" ] || { echo "STOP: wrong key: your key's fingerprint is $HAVE_FP, this backup's is $WANT_FP (key_source=$SRC)" >&2; exit 1; }
  echo "ok: key fingerprint $HAVE_FP matches the manifest (key_source=$SRC)"
else
  echo "note: this manifest predates key fingerprints (key_source=${SRC:-unknown}); gpg will reject a wrong key"
fi
GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
gpg --batch --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-file "$KEY" -o "$OUT" -d "$DIR/$FILE" \
  || { rm -f "$OUT"; echo "STOP: decryption failed (wrong key or damaged file)" >&2; exit 1; }
echo "ok: decrypted to $OUT. Restore it only into a new, empty database (docs/db-backup.md)."
