#!/usr/bin/env bash
# O4 preflight (runbook docs/deploy-runbook-0201-0203.md §0a). Run on the
# owner's machine (macOS with Homebrew postgresql@17, or Linux/WSL), from the
# repository root, BEFORE taking the rehearsal dump. Local only: it reads tool
# versions and runs `SHOW server_version_num` on the LOCAL server; it never
# connects to a hosted database. Exit 0 = ready for
# scripts/ops/verify-backup-restore.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_local_pg.sh" || { echo "REFUSING TO RUN: scripts/ops/_local_pg.sh missing" >&2; exit 2; }
ok=0; bad=0
pass() { echo "  ok    $1"; ok=$((ok+1)); }
fail() { echo "  STOP  $1"; bad=$((bad+1)); }
major() { grep -oE '[0-9]+(\.[0-9]+)?' | head -1 | cut -d. -f1; }
if [ "$VENTS_OS" = "Darwin" ]; then
  START_HINT="brew services start postgresql@17"
  INSTALL_HINT="brew install postgresql@17"
  PATH_HINT="export PATH=\"$VENTS_PG_BIN:\$PATH\""
else
  START_HINT="sudo pg_ctlcluster 17 main start"
  INSTALL_HINT="install the postgresql-17 package"
  PATH_HINT="install the postgresql-client-17 package"
fi

echo "== O4 preflight ($VENTS_OS; tools: $VENTS_PG_BIN; socket: $SOCKET_DIR) =="
envbad=0
for v in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
         PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  [ -z "${!v:-}" ] || { fail "\$$v is set (run: unset $v)"; envbad=1; }
done
[ "$envbad" -eq 0 ] && pass "no hosted-database variables in the environment"

# The pg_dump you will run for the dump step (your own PATH).
v="$(pg_dump --version 2>/dev/null | major)"
[ "$v" = "17" ] && pass "your pg_dump (on PATH) is $(pg_dump --version | grep -oE '[0-9]+\.[0-9]+' | head -1)" \
  || fail "your pg_dump (on PATH) is '${v:-missing}', need 17; production runs PostgreSQL 17.6 ($PATH_HINT)"

# pg_restore and psql exactly as the drill calls them.
for t in pg_restore psql; do
  if [ -x "$VENTS_PG_BIN/$t" ]; then
    v="$(pgtool "$t" --version -h "$SOCKET_DIR" -p 5432 2>/dev/null | major)"
    [ "$v" = "17" ] && pass "drill's $t ($VENTS_PG_BIN) is 17" || fail "drill's $t ($VENTS_PG_BIN) is '${v:-unknown}', need 17"
  else
    fail "no $t in $VENTS_PG_BIN ($INSTALL_HINT)"
  fi
done

if [ -S "$SOCKET_DIR/.s.PGSQL.5432" ]; then
  sv="$(pg -d postgres -tAc 'SHOW server_version_num' 2>/dev/null)"
  [ "${sv:0:2}" = "17" ] && pass "local server on port 5432 is PostgreSQL $sv" \
    || fail "local server on port 5432 is '${sv:-unreachable}', need 17 (another PostgreSQL may hold 5432; the drill uses 5432 only)"
  for e in pg_trgm unaccent pgcrypto; do
    have="$(pg -d postgres -tAc "SELECT count(*) FROM pg_available_extensions WHERE name='$e'" 2>/dev/null)"
    [ "$have" = "1" ] && pass "extension $e available locally" \
      || echo "  warn  extension $e not available locally (objects using it become counted restore errors)"
  done
else
  fail "no local PostgreSQL socket at $SOCKET_DIR/.s.PGSQL.5432 ($START_HINT)"
fi

free_mb="$(df -Pm . | awk 'NR==2{print $4}')"
[ "${free_mb:-0}" -ge 2048 ] && pass "${free_mb} MB free here" || fail "only ${free_mb:-?} MB free; keep at least 2 GB"

[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "claude/vents-work-earn" ] \
  && pass "on branch claude/vents-work-earn" || fail "not on claude/vents-work-earn (git checkout claude/vents-work-earn)"
[ -f scripts/ops/verify-backup-restore.sh ] && [ -f supabase/rollback/pre_0201_0203_functions.sql ] \
  && pass "drill script and 19-function snapshot present" || fail "run from the repository root"

echo "Result: $ok ok, $bad stop"
[ "$bad" -eq 0 ]
