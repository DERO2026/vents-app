#!/usr/bin/env bash
# O4 preflight (runbook docs/deploy-runbook-0201-0203.md §0a). Run on the
# owner's Linux/WSL machine, from the repository root, BEFORE taking the
# rehearsal dump. Local only: it reads tool versions and runs
# `SHOW server_version_num` on the LOCAL server; it never connects to a
# hosted database. Exit 0 = ready for scripts/ops/verify-backup-restore.sh.
set -uo pipefail
ok=0; bad=0
pass() { echo "  ok    $1"; ok=$((ok+1)); }
fail() { echo "  STOP  $1"; bad=$((bad+1)); }
major() { grep -oE '[0-9]+(\.[0-9]+)?' | head -1 | cut -d. -f1; }
SOCK=/var/run/postgresql
as_pg() { sudo -u postgres env -i PATH=/usr/bin:/bin "$@"; }

echo "== O4 preflight =="
envbad=0
for v in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
         PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  [ -z "${!v:-}" ] || { fail "\$$v is set (run: unset $v)"; envbad=1; }
done
[ "$envbad" -eq 0 ] && pass "no hosted-database variables in the environment"

# The pg_dump you will run for the dump step (your own PATH).
v="$(pg_dump --version 2>/dev/null | major)"
[ "$v" = "17" ] && pass "your pg_dump is $(pg_dump --version | grep -oE '[0-9]+\.[0-9]+' | head -1)" \
  || fail "your pg_dump is '${v:-missing}', need 17 (production runs PostgreSQL 17.6)"

# pg_restore and psql exactly as the drill calls them (user postgres, PATH=/usr/bin:/bin, port 5432).
for t in pg_restore psql; do
  v="$(as_pg "$t" --version -h "$SOCK" -p 5432 2>/dev/null | major)"
  [ "$v" = "17" ] && pass "drill's $t is 17" || fail "drill's $t is '${v:-missing}', need 17"
done

if [ -S "$SOCK/.s.PGSQL.5432" ]; then
  sv="$(as_pg psql -h "$SOCK" -p 5432 -d postgres -tAc 'SHOW server_version_num' 2>/dev/null)"
  [ "${sv:0:2}" = "17" ] && pass "local server on port 5432 is PostgreSQL $sv" \
    || fail "local server on port 5432 is '${sv:-unreachable}', need 17 (check pg_lsclusters: a 17 cluster on 5433 is not used)"
  for e in pg_trgm unaccent pgcrypto; do
    have="$(as_pg psql -h "$SOCK" -p 5432 -d postgres -tAc "SELECT count(*) FROM pg_available_extensions WHERE name='$e'" 2>/dev/null)"
    [ "$have" = "1" ] && pass "extension $e available locally" \
      || echo "  warn  extension $e not available locally (objects using it become counted restore errors)"
  done
else
  fail "no local PostgreSQL socket on port 5432 (sudo pg_ctlcluster 17 main start)"
fi

free_mb="$(df -Pm . | awk 'NR==2{print $4}')"
[ "${free_mb:-0}" -ge 2048 ] && pass "${free_mb} MB free here" || fail "only ${free_mb:-?} MB free; keep at least 2 GB"

[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "claude/vents-work-earn" ] \
  && pass "on branch claude/vents-work-earn" || fail "not on claude/vents-work-earn (git checkout claude/vents-work-earn)"
[ -f scripts/ops/verify-backup-restore.sh ] && [ -f supabase/rollback/pre_0201_0203_functions.sql ] \
  && pass "drill script and 19-function snapshot present" || fail "run from the repository root"

echo "Result: $ok ok, $bad stop"
[ "$bad" -eq 0 ]
