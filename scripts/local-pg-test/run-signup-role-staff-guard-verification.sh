#!/usr/bin/env bash
# Migration 0232 (staff guard in set_signup_role, finding N2) against a real
# local PostgreSQL. Throwaway database; nothing here can reach a hosted one.
#
# Base: public.users from 0002 + 0005's role check + 0121's is_organizer
# column, and VERBATIM copies (latest migration definition) of is_root,
# is_admin, is_super_admin, actor_role, set_signup_role, promote_to_organizer,
# admin_set_organizer_capability and protect_capability_columns (with its
# trigger), plus the real grants from 0011 and 0116's revoke.
#
# Runs WITHOUT 0232 (reproduces N2: a sub-admin or a non-'admin' root makes
# themselves an organizer) and WITH 0232. MUTATE=<name> applies a weakened
# 0232 (used by the mutation test at the end of this file's run).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_signup_role_staff_guard"
SOCKET_DIR="/var/run/postgresql"
die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then die "\$$var is set. Unset it; this test only connects to the local Unix socket."; fi
done
if env | grep -qiE 'supabase\.(co|com)|pooler\.|rds\.amazonaws\.com|neon\.tech|render\.com'; then
  die "an environment variable references a hosted database host."
fi
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z_]+$ ]] || die "database name '$DB_NAME' is not a local test name."
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || die "no local PostgreSQL socket at $SOCKET_DIR (start it: pg_ctlcluster 16 main start)."
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || die "connection is not a local, non-Supabase PostgreSQL server ($server_check)."

PSQL=(pg -d "$DB_NAME")
ERR=$(mktemp); OUT=$(mktemp); M232=$(mktemp --suffix=.sql)
cleanup() { rm -f "$ERR" "$OUT" "$M232"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT
PASSES=0; FAILS=0; MODE=""
pass() { echo "PASS: [$MODE] $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: [$MODE] $1" >&2; FAILS=$((FAILS+1)); }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1 ($(grep -m1 ERROR "$ERR"))"; fi; }
expect_error() { if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an error, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error: $(grep -m1 ERROR "$ERR"))"; fi; }

cp "$MIG/0232_signup_role_staff_guard.sql" "$M232"; chmod 644 "$M232"
case "${MUTATE:-}" in
  "") ;;
  admin_only) python3 - "$M232" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
a="(public.is_admin() OR v_current_role IN ('admin', 'sub-admin'))"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"(v_current_role = 'admin')"))
PY
  ;;
  role_only) python3 - "$M232" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
a="(public.is_admin() OR v_current_role IN ('admin', 'sub-admin'))"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"(v_current_role IN ('admin', 'sub-admin'))"))
PY
  ;;
  *) die "unknown MUTATE=$MUTATE" ;;
esac

USER1=00000000-0000-0000-0000-0000000232a1
USER2=00000000-0000-0000-0000-0000000232a2
SUB=00000000-0000-0000-0000-0000000232b1
SUB_ORG=00000000-0000-0000-0000-0000000232b2
ADMIN=00000000-0000-0000-0000-0000000232c1
ROOT=c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832
FN_NAMES="is_root is_admin is_super_admin actor_role set_signup_role promote_to_organizer admin_set_organizer_capability protect_capability_columns"
org() { val "SELECT is_organizer FROM public.users WHERE id = '$1'"; }

build() {
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" -c "CREATE DATABASE $DB_NAME;" >/dev/null
  local fns; fns=$(PYTHONDONTWRITEBYTECODE=1 python3 - "$REPO_ROOT" $FN_NAMES <<'PY'
import glob, importlib.util, os, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location('cvf', os.path.join(root, 'scripts', 'local-pg-test', 'check-verbatim-functions.py'))
cvf = importlib.util.module_from_spec(spec); spec.loader.exec_module(cvf)
files = [f for f in sorted(glob.glob(os.path.join(root, 'supabase', 'migrations', '*.sql'))) if os.path.basename(f)[:4] < '0232']
for name in sys.argv[2:]:
    d = None
    for f in files:
        x = cvf.last_definition(open(f, encoding='utf-8').read(), name)
        if x: d = x
    if not d: sys.exit('missing ' + name)
    print(d + ';\n')
PY
) || die "could not extract function definitions"
  local grants; grants=$(grep -hE "^(REVOKE|GRANT) [^;]*ON FUNCTION public\.(set_signup_role|promote_to_organizer|admin_set_organizer_capability|is_root|is_admin|is_super_admin|actor_role)\(" "$MIG/0011_grants.sql" "$MIG/0116"*.sql "$MIG/0121_organizer_capability_independent_of_role.sql")
  local ddl_users ddl_logs; ddl_users=$(grep -h "^CREATE TABLE IF NOT EXISTS users " "$MIG/0002_tables.sql"); ddl_logs=$(grep -h "^CREATE TABLE IF NOT EXISTS admin_logs " "$MIG/0002_tables.sql")
  local role_check; role_check=$(grep -h "ADD CONSTRAINT users_role_check" "$MIG/0005_primary_unique_check_constraints.sql")
  "${PSQL[@]}" -q >/dev/null 2>"$ERR" <<SQL || die "base schema failed: $(grep -m1 ERROR "$ERR")"
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='project_admin') THEN CREATE ROLE project_admin NOLOGIN; END IF;
END \$\$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$\$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, project_admin;
SET search_path TO public;
$ddl_users
$ddl_logs
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
$role_check
RESET search_path;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_service_provider boolean NOT NULL DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_organizer boolean NOT NULL DEFAULT false;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_update ON public.users FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY own_select ON public.users FOR SELECT TO authenticated USING (id = auth.uid());
GRANT SELECT, UPDATE ON public.users TO authenticated;
$fns
CREATE TRIGGER trg_protect_capability_columns BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.protect_capability_columns();
$grants
INSERT INTO public.users (id, email, role, is_organizer) VALUES
  ('$USER1', 'u1@example.test', 'user', false), ('$USER2', 'u2@example.test', 'attendee', false),
  ('$SUB', 's@example.test', 'sub-admin', false), ('$SUB_ORG', 'so@example.test', 'sub-admin', true),
  ('$ADMIN', 'a@example.test', 'admin', false), ('$ROOT', 'root@example.test', 'user', false);
SQL
}

scenario() {
  local with="$1"
  MODE=$([ "$with" = 1 ] && echo "with 0232" || echo "without 0232")
  echo "== $MODE"
  build
  if [ "$with" = 1 ]; then
    if "${PSQL[@]}" -q -f "$M232" >"$OUT" 2>"$ERR"; then pass "0232 applies on the live (0121) set_signup_role"; else fail "0232 applies ($(grep -m1 ERROR "$ERR"))"; return; fi
  fi

  echo "-- [$MODE] ordinary users (D1a)"
  expect_ok "an ordinary user selects Organizer" "$(as "$USER1" "SELECT public.set_signup_role('organizer');")"
  expect_value "...and is an organizer immediately (no approval step)" "$(org "$USER1")" "t"
  expect_ok "a legacy 'attendee'-role user selects Organizer" "$(as "$USER2" "SELECT public.set_signup_role('organizer');")"
  expect_value "...and is an organizer" "$(org "$USER2")" "t"
  expect_ok "set_signup_role('user') still succeeds for an ordinary user" "$(as "$USER1" "SELECT public.set_signup_role('user');")"
  expect_error "an invalid role is refused" "Invalid role" "$(as "$USER1" "SELECT public.set_signup_role('admin');")"
  expect_error "an unauthenticated call is refused" "Not authenticated" "SET ROLE anon; SELECT public.set_signup_role('organizer');"

  echo "-- [$MODE] staff self-escalation through direct RPC"
  expect_error "admin cannot self-select Organizer" "Admin role cannot be changed" "$(as "$ADMIN" "SELECT public.set_signup_role('organizer');")"
  expect_value "...admin is still not an organizer" "$(org "$ADMIN")" "f"
  if "${PSQL[@]}" -c "$(as "$SUB" "SELECT public.set_signup_role('organizer');")" >"$OUT" 2>"$ERR"; then
    [ "$with" = 1 ] && fail "sub-admin self-selecting Organizer should be refused" \
      || expect_value "DEFECT REPRODUCED: a sub-admin makes themselves an organizer by calling the RPC directly" "$(org "$SUB")" "t"
  else
    [ "$with" = 1 ] && grep -q "Staff accounts cannot turn on organizer tools" "$ERR" && pass "sub-admin cannot self-select Organizer (direct RPC)" || fail "sub-admin refusal ($(grep -m1 ERROR "$ERR"))"
    [ "$with" = 1 ] && expect_value "...sub-admin is still not an organizer" "$(org "$SUB")" "f"
  fi
  if "${PSQL[@]}" -c "$(as "$ROOT" "SELECT public.set_signup_role('organizer');")" >"$OUT" 2>"$ERR"; then
    [ "$with" = 1 ] && fail "root (role 'user') self-selecting Organizer should be refused" \
      || expect_value "DEFECT REPRODUCED: the root account (role 'user') makes itself an organizer" "$(org "$ROOT")" "t"
  else
    [ "$with" = 1 ] && grep -q "Staff accounts cannot turn on organizer tools" "$ERR" && pass "root cannot self-select Organizer even when its role is not 'admin'" || fail "root refusal ($(grep -m1 ERROR "$ERR"))"
  fi
  expect_ok "sub-admin set_signup_role('user') is unchanged (grants nothing)" "$(as "$SUB_ORG" "SELECT public.set_signup_role('user');")"

  echo "-- [$MODE] other routes stay closed"
  expect_error "a direct UPDATE of is_organizer by a sub-admin is refused" "is_organizer can only be changed" "$(as "$SUB" "UPDATE public.users SET is_organizer = NOT is_organizer WHERE id = '$SUB';")"
  expect_error "a direct UPDATE of is_organizer by an ordinary user is refused" "is_organizer can only be changed" "$(as "$USER1" "UPDATE public.users SET is_organizer = false WHERE id = '$USER1';")"
  expect_value "promote_to_organizer is not callable by signed-in clients" "$(val "SELECT has_function_privilege('authenticated', 'public.promote_to_organizer()', 'EXECUTE')")" "f"
  expect_error "a sub-admin cannot use the Super Admin grant on themselves" "Super Admin access required" "$(as "$SUB" "SELECT public.admin_set_organizer_capability('$SUB', true);")"

  echo "-- [$MODE] legitimate staff permissions preserved"
  [ "$with" = 1 ] && expect_error "an existing staff organizer calling the RPC is refused..." "Staff accounts" "$(as "$SUB_ORG" "SELECT public.set_signup_role('organizer');")"
  expect_value "...but keeps the organizer access they already had" "$(org "$SUB_ORG")" "t"
  expect_ok "an admin (Super Admin) can still grant a sub-admin organizer access" "$(as "$ADMIN" "SELECT public.admin_set_organizer_capability('$SUB', true);")"
  expect_value "...the sub-admin is now an organizer, and it is logged" "$(org "$SUB")/$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'organizer_capability_change' AND target_user_id = '$SUB'")" "t/1"
  expect_value "the staff tier (role) is never changed by any of this" "$(val "SELECT string_agg(role, ',' ORDER BY id) FROM public.users")" "user,attendee,sub-admin,sub-admin,admin,user"

  [ "$with" = 1 ] || return 0
  echo "-- [$MODE] undo, re-apply, drift"
  local POST; POST=$(val "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'set_signup_role'")
  expect_error "0232 refuses to run twice" "already patched" "$(cat "$M232")"
  expect_error "undo refuses without the confirmation setting" "Refusing" "$(cat "$REPO_ROOT/supabase/rollback/undo_0232.sql")"
  expect_ok "undo runs with the confirmation setting" "SET vents.rollback_confirm = 'undo-0232'; $(cat "$REPO_ROOT/supabase/rollback/undo_0232.sql")"
  expect_value "undo restores set_signup_role byte-for-byte" "$(val "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'set_signup_role'")" "$PRE_SRC"
  if "${PSQL[@]}" -q -f "$M232" >"$OUT" 2>"$ERR"; then pass "0232 re-applies after undo"; else fail "0232 re-applies ($(grep -m1 ERROR "$ERR"))"; fi
  expect_value "...to the same function body" "$(val "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'set_signup_role'")" "$POST"
  expect_ok "undo again" "SET vents.rollback_confirm = 'undo-0232'; $(cat "$REPO_ROOT/supabase/rollback/undo_0232.sql")"
  "${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.set_signup_role(p_role text) RETURNS void LANGUAGE sql AS \$f\$ SELECT NULL \$f\$;" >/dev/null
  if "${PSQL[@]}" -q -f "$M232" >"$OUT" 2>"$ERR"; then fail "0232 refuses a drifted function"
  else grep -q "not the expected version" "$ERR" && pass "0232 refuses a drifted function (nothing applied)" || fail "drift refusal wording ($(grep -m1 ERROR "$ERR"))"; fi
}

MODE="baseline"; build
PRE_SRC=$(val "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'set_signup_role'")
scenario 0
scenario 1

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES SIGNUP ROLE STAFF GUARD (0232) CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
