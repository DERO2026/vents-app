#!/usr/bin/env bash
# Self-test for recovering a LEGACY backup artifact (key_source=derived-from-
# DATABASE_URL, the format of runs #20 and #22) with:
#   scripts/ops/db-backup-legacy-key-find.sh  (finds the key from the password)
#   scripts/ops/db-backup-decrypt.sh          (checksum + decrypt)
#   scripts/ops/verify-backup-restore.sh      (restore into a local database)
#
# The stand-in artifact is built exactly as run #22's code (commit 7e69c9e)
# built it: key = HMAC-SHA256("vents-db-backup-v1", raw secret) in hex, the
# secret being a DIRECT connection string; pg_dump -Fc streamed into
# gpg --symmetric AES256, s2k mode 3 / SHA512 / 65011712; a manifest with
# key_source=derived-from-DATABASE_URL and no key_fingerprint. The fake
# secret deliberately has a URL-encoded password and a trailing newline, the
# hardest case to reproduce by hand. Local, throwaway, no network.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OPS="$REPO_ROOT/scripts/ops"
DB_NAME="vents_local_pg_legacy_recovery_src"
SOCKET_DIR="/var/run/postgresql"
die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL BACKUP_DB_URL BACKUP_ENCRYPTION_PASSPHRASE PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL \
           PGHOST PGHOSTADDR PGSERVICE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  [ -z "${!var:-}" ] || die "\$$var is set. Unset it; this test is local only."
done
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || die "no local PostgreSQL socket at $SOCKET_DIR"
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }
check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$check" = "true/true" ] || die "not a local, non-Supabase PostgreSQL server"

W="$(mktemp -d)"; chmod 755 "$W"
cleanup() { rm -rf "$W"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT
PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }

# Fake production-like secret: direct form, password needs URL-encoding, pasted with a newline.
PW_RAW='Ab#1@z/Q!x9'
PW_ENC='Ab%231%40z%2FQ%21x9'
SECRET="postgresql://postgres:${PW_ENC}@db.slrtjxtzhowhwhebjprv.supabase.co:5432/postgres
"

pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;" >/dev/null
pg -d "$DB_NAME" -q >/dev/null <<'SQL'
CREATE TABLE public.tickets (id int PRIMARY KEY, amount numeric);
CREATE TABLE public.organizer_wallets (organizer_id int PRIMARY KEY, balance_kobo bigint, pending_kobo bigint);
CREATE TABLE public.events (id int PRIMARY KEY, title text);
INSERT INTO public.tickets SELECT g, g * 100 FROM generate_series(1, 250) g;
INSERT INTO public.organizer_wallets VALUES (1, 5000, 0), (2, 0, 700);
INSERT INTO public.events VALUES (1, 'Legacy night');
SQL

ART="$W/artifact"; mkdir -p "$ART"; chmod 755 "$ART"
F="vents-db-20261111T001450Z.dump.gpg"
# Run #22's key derivation, verbatim from scripts/ops/db-backup-key.sh at 7e69c9e.
printf '%s' "$SECRET" | openssl dgst -sha256 -hmac vents-db-backup-v1 -r | cut -d' ' -f1 | tr -d '\n' >"$W/orig.key"
# Run #22's encryption, same gpg arguments as scripts/ops/db-backup-dump.sh at 7e69c9e.
export GNUPGHOME="$W/gnupg"; mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
sudo -u postgres pg_dump -h "$SOCKET_DIR" -p 5432 --format=custom --compress=6 "$DB_NAME" \
  | gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-file "$W/orig.key" \
        --symmetric --cipher-algo AES256 --compress-algo none \
        --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 -o "$ART/$F"
( cd "$ART" && sha256sum "$F" >"$F.sha256" )
{ echo "file=$F"; echo "created_utc=20261111T001450Z"; echo "bytes=$(wc -c <"$ART/$F" | tr -d ' ')"
  echo "sha256=$(cut -d' ' -f1 "$ART/$F.sha256")"; echo "format=pg_dump custom (-Fc, compress 6), then gpg --symmetric AES256"
  echo "scope=full"; echo "key_source=derived-from-DATABASE_URL"; echo "function_check=report"; } >"$ART/manifest.txt"
chmod 644 "$ART"/*

# The current repo's --legacy-derived must rebuild the same key from the same raw secret.
( cd "$W" && BACKUP_DB_URL="$SECRET" bash "$OPS/db-backup-key.sh" --legacy-derived "$W/cur.key" "$W/cur.mode" >/dev/null 2>&1 )
[ "$(cat "$W/cur.key")" = "$(cat "$W/orig.key")" ] && pass "today's --legacy-derived key equals run #22's derivation" || fail "--legacy-derived differs from run #22's derivation"

LOG="$W/log"
find_key() { printf '%s\n' "$1" | VENTS_KEYFIND_STDIN=1 bash "$OPS/db-backup-legacy-key-find.sh" "${3:-$ART}" "$2" >"$LOG" 2>&1; }

if find_key "$PW_RAW" "$W/found.key"; then
  grep -q "matched: input=password, form=direct, scheme=postgresql, sslmode=none, password=url-encoded, ending=newline" "$LOG" \
    && pass "from the raw password alone, the helper finds the stored form (URL-encoded, trailing newline)" || fail "helper matched an unexpected form: $(grep matched "$LOG")"
  [ "$(cat "$W/found.key")" = "$(cat "$W/orig.key")" ] && pass "...and saves exactly the original key" || fail "saved key differs from the original"
  [ "$(stat -c %a "$W/found.key")" = 600 ] && pass "...with mode 600" || fail "key file mode $(stat -c %a "$W/found.key")"
else fail "helper did not find the key from the password ($(tail -2 "$LOG"))"; fi
grep -qF "$PW_RAW" "$LOG" || grep -qF "$PW_ENC" "$LOG" && fail "the helper printed the password" || pass "the helper's output never contains the password or the connection string"

# The owner pastes the full string, but with postgres:// instead of postgresql://, and no newline.
ALT="postgres://postgres:${PW_ENC}@db.slrtjxtzhowhwhebjprv.supabase.co:5432/postgres"
find_key "$ALT" "$W/found2.key" && [ "$(cat "$W/found2.key")" = "$(cat "$W/orig.key")" ] \
  && pass "from a slightly different full string (scheme, missing newline), the helper still finds the key" || fail "full-string variant not found ($(tail -2 "$LOG"))"

find_key 'not-the-password' "$W/nope.key" && fail "a wrong password produced a key" \
  || { grep -q "NOT FOUND" "$LOG" && [ ! -e "$W/nope.key" ] && pass "a wrong password: NOT FOUND, no key file written" || fail "wrong password: unexpected result ($(tail -1 "$LOG"))"; }

find_key "$PW_RAW" "$W/found.key" && fail "overwrote an existing key file" || pass "refuses to overwrite an existing key file"

# The existing decrypt script, with the recovered key.
if bash "$OPS/db-backup-decrypt.sh" "$ART" "$W/found.key" "$W/backup.dump" >"$LOG" 2>&1; then
  grep -q "predates key fingerprints" "$LOG" && pass "db-backup-decrypt.sh checks the checksum and decrypts a legacy (no-fingerprint) artifact" || fail "decrypt output unexpected"
else fail "db-backup-decrypt.sh failed ($(tail -2 "$LOG"))"; fi
chmod 644 "$W/backup.dump" 2>/dev/null
# The existing restore drill, in report mode (an old backup cannot match today's function fingerprints).
if FUNCTION_CHECK=report VERIFY_DB_NAME=vents_local_pg_legacy_recovery bash "$OPS/verify-backup-restore.sh" "$W/backup.dump" >"$LOG" 2>&1; then
  grep -q "Public tables restored: 3/3" "$LOG" && grep -q "Public table rows matching the backup: 3/3" "$LOG" \
    && pass "verify-backup-restore.sh restores every table with every row (3/3, 3/3)" || fail "restore counts unexpected: $(grep '^==' "$LOG" | head -3)"
else fail "restore drill failed ($(grep -E '^==|REFUS' "$LOG" | head -3))"; fi

# Damaged artifact: refused before any key search.
cp -r "$ART" "$W/bad"; printf 'x' >>"$W/bad/$F"
find_key "$PW_RAW" "$W/bad.key" "$W/bad" && fail "a damaged artifact was accepted" || { grep -q "sha256 differs" "$LOG" && pass "a damaged artifact is refused (sha256 mismatch) before any key is tried" || fail "damaged artifact: $(tail -1 "$LOG")"; }
# A passphrase-era artifact is not a legacy one.
cp -r "$ART" "$W/new"; sed -i 's/^key_source=.*/key_source=passphrase-secret/' "$W/new/manifest.txt"
find_key "$PW_RAW" "$W/new.key" "$W/new" && fail "ran on a passphrase artifact" || grep -q "not derived-from-DATABASE_URL" "$LOG" && pass "refuses an artifact whose key_source is not derived-from-DATABASE_URL"
GITHUB_ACTIONS=true VENTS_KEYFIND_STDIN=1 bash "$OPS/db-backup-legacy-key-find.sh" "$ART" "$W/ci.key" </dev/null >"$LOG" 2>&1 \
  && fail "ran on a GitHub runner" || pass "refuses to run on a GitHub runner"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES LEGACY BACKUP RECOVERY SELF-TEST CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
