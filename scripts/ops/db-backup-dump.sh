#!/usr/bin/env bash
# Takes an encrypted pg_dump of the VENTS production database.
#
#   * Source: BACKUP_DB_URL (mapped from the o4-backup environment secret
#     DATABASE_URL). It must be the Supabase SESSION pooler URI of project
#     slrtjxtzhowhwhebjprv on port 5432: GitHub runners have no IPv6, so the
#     direct host is unreachable, and the transaction pooler (6543) cannot run
#     pg_dump. Anything else is refused before a connection is made.
#   * pg_dump only reads: it runs in a REPEATABLE READ, READ ONLY transaction
#     and takes ACCESS SHARE locks (DDL waits; reads and writes do not). With
#     --lock-wait-timeout it gives up rather than queue behind a DDL lock.
#   * Custom format (-Fc), compressed inside the archive, streamed straight
#     into AES-256 (gpg, passphrase file); the plain dump never touches disk.
#     Ownership and every GRANT/REVOKE are kept (no --no-owner/--no-privileges).
#   * A failure leaves no output file (written to <out>.partial, renamed only
#     on success) and prints pg_dump's error with the connection string removed.
#
# Usage: db-backup-dump.sh <out.dump.gpg> <passphrase-file>
# Env:   BACKUP_DB_URL (required), BACKUP_SCOPE full|public_auth_storage|public
#        BACKUP_SELFTEST=1 additionally allows a password URL to a LOCAL test
#        database (scripts/local-pg-test/run-db-backup-pipeline-selftest.sh).
set -uo pipefail
OUT="${1:-}"; KEY="${2:-}"
[ -n "$OUT" ] && [ -n "$KEY" ] || { echo "usage: $0 <out.dump.gpg> <passphrase-file>" >&2; exit 2; }
[ -s "$KEY" ] || { echo "STOP: passphrase file $KEY is missing or empty" >&2; exit 1; }
SCOPE="${BACKUP_SCOPE:-full}"
scrub() { sed -E 's#postgres(ql)?://[^[:space:]"]*#<connection string removed>#g; s#(password|PGPASSWORD)=[^[:space:]]*#\1=<removed>#Ig'; }

URL="${BACKUP_DB_URL:-}"
[ -n "$URL" ] || { echo "STOP: the DATABASE_URL secret is empty or not available to this job (o4-backup environment)" >&2; exit 1; }
PROD_RE='^postgres(ql)?://postgres\.slrtjxtzhowhwhebjprv:[^@/]+@[a-z0-9.-]+\.pooler\.supabase\.com:5432/postgres(\?sslmode=(require|verify-ca|verify-full))?$'
TEST_RE='^postgresql://vents_backup_selftest:[^@/]+@127\.0\.0\.1:5432/vents_local_pg_[a-z_]+\?sslmode=disable$'
if printf '%s' "$URL" | grep -qE "$PROD_RE"; then
  KIND="production (session pooler, project slrtjxtzhowhwhebjprv, SSL required)"
  export PGSSLMODE=require   # used when the URI carries no sslmode of its own
elif [ "${BACKUP_SELFTEST:-}" = "1" ] && printf '%s' "$URL" | grep -qE "$TEST_RE"; then
  KIND="local self-test database"
else
  echo "STOP: DATABASE_URL is not the VENTS Supabase session pooler URI. Expected the shape" >&2
  echo "  postgresql://postgres.slrtjxtzhowhwhebjprv:<password>@<region>.pooler.supabase.com:5432/postgres[?sslmode=require]" >&2
  echo "  (password URL-encoded; no sslmode=disable/allow/prefer; not the direct db.* host, not port 6543)" >&2
  exit 1
fi
# Mask the password on its own too (GitHub masks the whole secret already).
PW="$(printf '%s' "$URL" | sed -E 's#^[^:]+://[^:]+:([^@]+)@.*#\1#')"
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "$PW" ]; then echo "::add-mask::$PW"; fi
unset PW

case "$SCOPE" in
  full) SCOPE_ARGS=() ;;
  public_auth_storage) SCOPE_ARGS=(-n public -n auth -n storage) ;;
  public) SCOPE_ARGS=(-n public) ;;
  *) echo "STOP: unknown dump scope '$SCOPE' (full | public_auth_storage | public)" >&2; exit 1 ;;
esac

umask 077
ERR="$(mktemp)"; GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -f "$ERR"; rm -rf "$GNUPGHOME"' EXIT
rm -f "$OUT" "$OUT.partial"
echo "pg_dump $(pg_dump --version | grep -oE '[0-9]+\.[0-9]+' | head -1), scope=$SCOPE, source: $KIND"
pg_dump --dbname="$URL" --format=custom --compress=6 --no-password --lock-wait-timeout=120000 \
        "${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"}" 2>"$ERR" \
  | gpg --batch --yes --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-file "$KEY" \
        --symmetric --cipher-algo AES256 --compress-algo none \
        --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
        -o "$OUT.partial"
rc=("${PIPESTATUS[@]}")
echo "exit codes: pg_dump=${rc[0]} gpg=${rc[1]}"
if [ "${rc[0]}" != 0 ] || [ "${rc[1]}" != 0 ]; then
  echo "BACKUP FAILED: the dump did not complete. pg_dump said (connection details removed):" >&2
  scrub <"$ERR" | tail -8 >&2
  if grep -qi 'permission denied' "$ERR"; then
    echo "A schema is not readable by this role. Re-run with dump_scope=public_auth_storage; never GRANT anything on production." >&2
  fi
  rm -f "$OUT.partial"
  exit 1
fi
# pg_dump may warn without failing; show warnings (scrubbed) so they are seen.
if [ -s "$ERR" ]; then echo "pg_dump warnings (connection details removed):"; scrub <"$ERR" | tail -8; fi
SIZE=$(wc -c <"$OUT.partial" | tr -d ' ')
[ "$SIZE" -ge 1024 ] || { echo "BACKUP FAILED: encrypted output is only $SIZE bytes" >&2; rm -f "$OUT.partial"; exit 1; }
mv "$OUT.partial" "$OUT"
echo "ok: encrypted backup written ($SIZE bytes)"
