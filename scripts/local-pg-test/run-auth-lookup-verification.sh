#!/usr/bin/env bash
# Migration 0227 (auth lookup hardening: H2, L4, M8, L5) against a real local
# PostgreSQL. Throwaway database; nothing here can reach a hosted database.
#
# Every function 0227 patches, revokes or calls (reclaim_unverified_signup,
# check_user_exists, get_account_status, email_exists,
# resolve_username_to_email, check_rate_limit, client_ip) is extracted at run
# time from its LATEST definition in supabase/migrations and granted exactly
# as 0011 grants it. users and rate_limits use 0002's DDL. Passwords are
# hashed the way Supabase Auth stores them (bcrypt, $2a$).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_auth_lookup"
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
ERR=$(mktemp); OUT=$(mktemp)
cleanup() { rm -f "$ERR" "$OUT"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT
FAILS=0; PASSES=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
expect_error() { if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an error, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error: $(grep -m1 ERROR "$ERR"))"; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1 ($(grep -m1 ERROR "$ERR"))"; fi; }
val() { "${PSQL[@]}" -tA -c "$1" 2>&1 | tail -n1; }
expect_value() { local a; a=$(val "$2"); if [ "$a" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$a')"; fi; }
# as <role> <uid|''> <ip>: a client request as PostgREST would make it.
as() { echo "SET ROLE $1; SELECT set_config('test.uid', '$2', false), set_config('request.headers', '{\"x-forwarded-for\": \"$3\"}', false);"; }
FN_NAMES="reclaim_unverified_signup check_user_exists get_account_status email_exists resolve_username_to_email check_rate_limit client_ip"

ALICE=00000000-0000-0000-0000-0000000000a1   # active, username alice
BOB=00000000-0000-0000-0000-0000000000b2     # suspended
DAN=00000000-0000-0000-0000-0000000000d4     # deleted
ALICE2=00000000-0000-0000-0000-0000000000a2  # newer account, same username differing only in case
PASS='Correct#Pass1'

build() {
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" -c "CREATE DATABASE $DB_NAME;" >/dev/null
  local fns; fns=$(PYTHONDONTWRITEBYTECODE=1 python3 - "$REPO_ROOT" $FN_NAMES <<'PY'
import glob, importlib.util, os, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location('cvf', os.path.join(root, 'scripts', 'local-pg-test', 'check-verbatim-functions.py'))
cvf = importlib.util.module_from_spec(spec); spec.loader.exec_module(cvf)
files = [f for f in sorted(glob.glob(os.path.join(root, 'supabase', 'migrations', '*.sql'))) if os.path.basename(f)[:4] < '0227']
for name in sys.argv[2:]:
    d = None
    for f in files:
        x = cvf.last_definition(open(f, encoding='utf-8').read(), name)
        if x: d = x
    if not d: sys.exit('missing ' + name)
    print(d + ';\n')
PY
) || die "could not extract function definitions"
  local grants; grants=$(grep -hE "^(REVOKE|GRANT) [^;]*ON FUNCTION public\.(reclaim_unverified_signup|check_user_exists|get_account_status|email_exists|resolve_username_to_email|client_ip)\(" "$MIG/0011_grants.sql")
  local ddl_users ddl_rl; ddl_users=$(grep -h "^CREATE TABLE IF NOT EXISTS users " "$MIG/0002_tables.sql"); ddl_rl=$(grep -h "^CREATE TABLE IF NOT EXISTS rate_limits " "$MIG/0002_tables.sql")
  "${PSQL[@]}" -q >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='project_admin') THEN CREATE ROLE project_admin NOLOGIN; END IF;
END \$\$;
CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, encrypted_password text, email_confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$\$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, project_admin;
SET search_path TO public;
$ddl_users
$ddl_rl
ALTER TABLE rate_limits ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key, window_start);
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
RESET search_path;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_update ON public.users FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY own_select ON public.users FOR SELECT TO authenticated USING (id = auth.uid());
GRANT SELECT, UPDATE ON public.users TO authenticated;
$fns
$grants
INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at) VALUES
  ('$ALICE',  'alice@login.example',  extensions.crypt('$PASS', extensions.gen_salt('bf', 10)), now(), now() - interval '30 days'),
  ('$ALICE2', 'alice2@login.example', extensions.crypt('$PASS', extensions.gen_salt('bf', 10)), now(), now() - interval '1 day'),
  ('$BOB',    'bob@login.example',    extensions.crypt('$PASS', extensions.gen_salt('bf', 10)), now(), now() - interval '30 days'),
  ('$DAN',    'dan@login.example',    extensions.crypt('$PASS', extensions.gen_salt('bf', 10)), now(), now() - interval '30 days');
-- public.users.email deliberately differs from the login email for alice (L5 drift case).
INSERT INTO public.users (id, email, username, status, banned_until, created_at) VALUES
  ('$ALICE',  'stale-profile@example.com', 'alice',  'active',    NULL, now() - interval '30 days'),
  ('$ALICE2', 'alice2@login.example',      'Alice ', 'active',    NULL, now() - interval '1 day'),
  ('$BOB',    'bob@login.example',         'bob',    'suspended', now() + interval '7 days', now() - interval '30 days'),
  ('$DAN',    'dan@login.example',         'dan',    'deleted',   NULL, now() - interval '30 days');
SQL
  [ $? -eq 0 ] || die "base schema failed"
}
apply_0227() { "${PSQL[@]}" -q -f "$MIG/0227_auth_lookup_hardening.sql" >"$OUT" 2>"$ERR"; }
apply_0228() { "${PSQL[@]}" -q -f "$MIG/0228_revoke_open_auth_lookups.sql" >"$OUT" 2>"$ERR"; }
# Unconfirmed sign-ups of given ages, for the reclaim checks.
seed_pending() { # id email username phone age
  "${PSQL[@]}" -q -c "INSERT INTO auth.users (id, email, created_at) VALUES ('$1', '$2', now() - interval '$5');
    INSERT INTO public.users (id, email, username, phone_number) VALUES ('$1', '$2', '$3', '$4');" >/dev/null
}

echo "== before 0227 (the defects, reproduced)"
build
expect_value "BEFORE: anyone (anon) gets any user's email from their username" "$(as anon '' 1.1.1.1) SELECT public.resolve_username_to_email('alice')" "stale-profile@example.com"
expect_value "BEFORE: anon learns any email's account status" "$(as anon '' 1.1.1.1) SELECT status FROM public.get_account_status('bob@login.example')" "suspended"
P1=00000000-0000-0000-0000-00000000c001
seed_pending $P1 victim@example.com victim +2348000000001 '10 minutes'
expect_value "BEFORE: a stranger wipes a 10-minute-old unconfirmed sign-up by username" "$(as anon '' 6.6.6.6) SELECT public.reclaim_unverified_signup(NULL, NULL, 'victim')" "1"
expect_ok "BEFORE: a user can rewrite their own profile email" "$(as authenticated $ALICE 1.1.1.1) UPDATE public.users SET email='attacker@example.com' WHERE id='$ALICE';"

echo "== 0228 needs 0227"
build
if apply_0228; then fail "0228 refuses without 0227"; else grep -q "0227 is not applied" "$ERR" && pass "0228 refuses without 0227" || fail "0228 refusal wording ($(grep -m1 ERROR "$ERR"))"; fi
expect_value "...and revoked nothing" "SELECT has_function_privilege('anon','public.resolve_username_to_email(text)','EXECUTE')::text" "true"

echo "== apply 0227"
build
if apply_0227; then pass "0227 applies over the verbatim pre-0227 functions"; else fail "0227 applies ($(grep -m1 ERROR "$ERR"))"; fi
expect_error "0227 refuses to run twice (nothing re-patched)" "already patched; refusing to run twice" "$(cat "$MIG/0227_auth_lookup_hardening.sql")"
expect_value "the patched functions carry the [0227] marker" "SELECT count(*) FROM pg_proc WHERE proname IN ('reclaim_unverified_signup','check_user_exists') AND prosrc LIKE '%[0227]%'" "2"

echo "== H2: username login"
expect_value "right password: the LOGIN email (auth.users), not the drifted profile email" "$(as anon '' 2.2.2.1) SELECT public.resolve_login_email('alice', '$PASS')" "alice@login.example"
expect_value "wrong password: NULL" "$(as anon '' 2.2.2.2) SELECT coalesce(public.resolve_login_email('alice', 'wrong'), 'NULL')" "NULL"
expect_value "unknown username: NULL (same as a wrong password)" "$(as anon '' 2.2.2.3) SELECT coalesce(public.resolve_login_email('nobody', '$PASS'), 'NULL')" "NULL"
expect_value "empty password: NULL" "$(as anon '' 2.2.2.4) SELECT coalesce(public.resolve_login_email('alice', ''), 'NULL')" "NULL"
expect_value "case- and space-insensitive; the oldest account wins (as 0049)" "$(as anon '' 2.2.2.5) SELECT public.resolve_login_email('  ALICE ', '$PASS')" "alice@login.example"
expect_value "signed-in callers use it the same way" "$(as authenticated $BOB 2.2.2.6) SELECT public.resolve_login_email('alice', '$PASS')" "alice@login.example"
expect_error "rate limited per username (6th try in 5 minutes)" "rate_limited" \
  "$(as anon '' 2.2.3.1) SELECT public.resolve_login_email('bob', 'x'); SELECT public.resolve_login_email('bob', 'x'); SELECT public.resolve_login_email('bob', 'x'); SELECT public.resolve_login_email('bob', 'x'); SELECT public.resolve_login_email('bob', 'x'); SELECT public.resolve_login_email('bob', 'x');"
expect_error "rate limited per IP (21st try in 5 minutes, different usernames)" "rate_limited" \
  "$(as anon '' 9.9.9.9) SELECT public.resolve_login_email('u' || g, 'x') FROM generate_series(1, 21) g;"
expect_value "after 0227 alone, installed old app builds still work (old lookup still callable)" "$(as anon '' 1.1.1.2) SELECT public.resolve_username_to_email('alice')" "stale-profile@example.com"
if apply_0228; then pass "0228 applies after 0227"; else fail "0228 applies ($(grep -m1 ERROR "$ERR"))"; fi
expect_error "after 0228: anon can no longer call resolve_username_to_email" "permission denied" "$(as anon '' 1.1.1.1) SELECT public.resolve_username_to_email('alice');"
expect_error "after 0228: signed-in users can no longer call it either" "permission denied" "$(as authenticated $BOB 1.1.1.1) SELECT public.resolve_username_to_email('alice');"
expect_value "server code (project_admin) still can" "SET ROLE project_admin; SELECT public.resolve_username_to_email('alice')" "stale-profile@example.com"
expect_value "the new login lookup keeps working after 0228" "$(as anon '' 2.2.4.1) SELECT public.resolve_login_email('alice', '$PASS')" "alice@login.example"
expect_error "the internal password check is not callable by clients" "permission denied" "$(as anon '' 1.1.1.1) SELECT public.login_password_matches('$ALICE', '$PASS');"

echo "== L4: account status after a failed sign-in"
expect_value "the owner (right password, by username) learns 'suspended' and until when" \
  "$(as anon '' 3.3.3.1) SELECT status || '/' || (banned_until > now())::text FROM public.get_login_account_status('bob', '$PASS')" "suspended/true"
expect_value "...and by email" "$(as anon '' 3.3.3.2) SELECT status FROM public.get_login_account_status('BOB@login.example', '$PASS')" "suspended"
expect_value "deleted accounts are reported to their owner" "$(as anon '' 3.3.3.3) SELECT status FROM public.get_login_account_status('dan', '$PASS')" "deleted"
expect_value "a wrong password learns nothing" "$(as anon '' 3.3.3.4) SELECT count(*) FROM public.get_login_account_status('bob', 'guess')" "0"
expect_value "an active account returns nothing (nothing to report)" "$(as anon '' 3.3.3.5) SELECT count(*) FROM public.get_login_account_status('alice', '$PASS')" "0"
expect_value "an unknown identifier returns nothing" "$(as anon '' 3.3.3.6) SELECT count(*) FROM public.get_login_account_status('ghost@example.com', '$PASS')" "0"
expect_error "after 0228: anon can no longer call get_account_status" "permission denied" "$(as anon '' 1.1.1.1) SELECT * FROM public.get_account_status('bob@login.example');"
expect_error "anon can no longer call email_exists" "permission denied" "$(as anon '' 1.1.1.1) SELECT public.email_exists('bob@login.example');"
expect_value "check_user_exists still answers sign-up's question" "$(as anon '' 4.4.4.1) SELECT public.check_user_exists('bob@login.example', NULL, 'nobody')::text" '{"email_taken": true, "username_taken": false}'
expect_error "check_user_exists is rate limited per IP (61st call in 5 minutes)" "rate_limited" "$(as anon '' 4.4.4.2) SELECT public.check_user_exists('x' || g || '@example.com') FROM generate_series(1, 61) g;"

echo "== M8: reclaiming unconfirmed sign-ups"
P2=00000000-0000-0000-0000-00000000c002; P3=00000000-0000-0000-0000-00000000c003
seed_pending $P2 victim2@example.com victim2 +2348000000002 '10 minutes'
seed_pending $P3 stale@example.com stale +2348000000003 '2 hours'
expect_value "a 10-minute-old sign-up can no longer be wiped by a stranger" "$(as anon '' 5.5.5.1) SELECT public.reclaim_unverified_signup(NULL, '+2348000000002', 'victim2')" "0"
expect_value "...and it still exists" "SELECT count(*) FROM auth.users WHERE id='$P2'" "1"
expect_value "a 2-hour-old abandoned sign-up is still reclaimed (sign-up retry keeps working)" "$(as anon '' 5.5.5.2) SELECT public.reclaim_unverified_signup('stale@example.com', NULL, NULL)" "1"
expect_value "a confirmed account is never reclaimed" "$(as anon '' 5.5.5.3) SELECT public.reclaim_unverified_signup('bob@login.example', NULL, 'bob')" "0"
expect_value "...bob still exists" "SELECT count(*) FROM auth.users WHERE id='$BOB'" "1"
expect_error "reclaim is rate limited per IP (11th call in 5 minutes)" "rate_limited" "$(as anon '' 5.5.5.4) SELECT public.reclaim_unverified_signup('n' || g || '@example.com') FROM generate_series(1, 11) g;"

echo "== L5: profile email columns"
expect_error "a user can't change their profile email" "changed in account settings" "$(as authenticated $ALICE 1.1.1.1) UPDATE public.users SET email='attacker@example.com' WHERE id='$ALICE';"
expect_error "...or original_email" "changed in account settings" "$(as authenticated $ALICE 1.1.1.1) UPDATE public.users SET original_email='x@example.com' WHERE id='$ALICE';"
expect_ok "other profile fields still update" "$(as authenticated $ALICE 1.1.1.1) UPDATE public.users SET full_name='Alice A', username='alice' WHERE id='$ALICE';"
expect_ok "server/database-function writes (owner role) can still change it" "UPDATE public.users SET email='alice@login.example' WHERE id='$ALICE';"

echo "== drift refusal"
build
"${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.reclaim_unverified_signup(p_email text DEFAULT NULL, p_phone text DEFAULT NULL, p_username text DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS \$f\$ BEGIN RETURN 0; END; \$f\$;" >/dev/null
if apply_0227; then fail "0227 refuses a drifted reclaim_unverified_signup"; else grep -q "not the expected version" "$ERR" && pass "0227 refuses a drifted reclaim_unverified_signup" || fail "drift refusal wording ($(grep -m1 ERROR "$ERR"))"; fi
expect_value "...and changed nothing (no new functions, old grants intact)" \
  "SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('resolve_login_email','get_login_account_status','login_password_matches')) || '/' || has_function_privilege('anon','public.resolve_username_to_email(text)','EXECUTE')::text" "0/true"

echo "== undo_0228, then undo_0227"
build
SRC_RECLAIM=$(val "SELECT md5(prosrc) FROM pg_proc WHERE proname='reclaim_unverified_signup'")
SRC_EXISTS=$(val "SELECT md5(prosrc) FROM pg_proc WHERE proname='check_user_exists'")
apply_0227 || fail "0227 applies before undo"
apply_0228 || fail "0228 applies before undo"
UNDO="$REPO_ROOT/supabase/rollback/undo_0227.sql"
UNDO8="$REPO_ROOT/supabase/rollback/undo_0228.sql"
expect_error "undo_0227 refuses while 0228 is applied" "run undo_0228 first" "SET vents.rollback_confirm = 'undo-0227'; $(cat "$UNDO")"
expect_error "undo_0228 refuses without the confirmation setting" "Refusing" "$(cat "$UNDO8")"
expect_ok "undo_0228 runs" "SET vents.rollback_confirm = 'undo-0228'; $(cat "$UNDO8")"
expect_value "...old lookups are callable again" "SELECT has_function_privilege('anon','public.resolve_username_to_email(text)','EXECUTE')::text || has_function_privilege('anon','public.get_account_status(text)','EXECUTE')::text" "truetrue"
expect_error "undo_0227 refuses without the confirmation setting" "Refusing" "$(cat "$UNDO")"
expect_ok "undo_0227 runs" "SET vents.rollback_confirm = 'undo-0227'; $(cat "$UNDO")"
expect_value "reclaim_unverified_signup is byte-identical to before 0227" "SELECT md5(prosrc) FROM pg_proc WHERE proname='reclaim_unverified_signup'" "$SRC_RECLAIM"
expect_value "check_user_exists is byte-identical to before 0227" "SELECT md5(prosrc) FROM pg_proc WHERE proname='check_user_exists'" "$SRC_EXISTS"
expect_value "new functions and the trigger are gone" \
  "SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('resolve_login_email','get_login_account_status','login_password_matches','protect_user_email_columns')) + (SELECT count(*) FROM pg_trigger WHERE tgname='trg_protect_user_email_columns')" "0"
expect_value "old grants are back as 0011 had them" \
  "SELECT has_function_privilege('anon','public.resolve_username_to_email(text)','EXECUTE')::text || has_function_privilege('anon','public.get_account_status(text)','EXECUTE')::text || has_function_privilege('anon','public.email_exists(text)','EXECUTE')::text" "truetruetrue"
if apply_0227; then pass "0227 re-applies after undo"; else fail "0227 re-applies after undo ($(grep -m1 ERROR "$ERR"))"; fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES AUTH LOOKUP (0227 + 0228) CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
