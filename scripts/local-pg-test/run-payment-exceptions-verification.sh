#!/usr/bin/env bash
# Migration 0226 (payment exceptions, H1 / OEL-02) against a real local
# PostgreSQL. Throwaway database; nothing here can reach a hosted database.
#
# The admin helpers (actor_role, is_root, is_admin, is_super_admin) are
# extracted at run time from their LATEST definition in supabase/migrations
# (the same extractor check-verbatim-functions.py uses), and the two tables
# 0226 references (pending_purchases, admin_logs) use 0002's exact DDL.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_payment_exceptions"
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
expect_error() { # label expected-substring sql
  if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an error, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error: $(grep -m1 ERROR "$ERR"))"; fi
}
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1 ($(grep -m1 ERROR "$ERR"))"; fi; }
val() { "${PSQL[@]}" -tA -c "$1" 2>&1 | tail -n1; }
expect_value() { local a; a=$(val "$2"); if [ "$a" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$a')"; fi; }
as() { echo "SET ROLE $1; SELECT set_config('test.uid', '$2', false);"; }

ROOT="c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832"
ADMIN="00000000-0000-0000-0000-00000000a001"
SUB="00000000-0000-0000-0000-00000000a002"
BUYER="00000000-0000-0000-0000-00000000b001"
OTHER="00000000-0000-0000-0000-00000000b002"
EVENT="00000000-0000-0000-0000-00000000e001"

pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" -c "CREATE DATABASE $DB_NAME;" >/dev/null

HELPERS=$(PYTHONDONTWRITEBYTECODE=1 python3 - "$REPO_ROOT" <<'PY'
import glob, importlib.util, os, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location('cvf', os.path.join(root, 'scripts', 'local-pg-test', 'check-verbatim-functions.py'))
cvf = importlib.util.module_from_spec(spec); spec.loader.exec_module(cvf)
files = sorted(glob.glob(os.path.join(root, 'supabase', 'migrations', '*.sql')))
for name in ['actor_role', 'is_root', 'is_admin', 'is_super_admin']:
    d = None
    for f in files:
        x = cvf.last_definition(open(f, encoding='utf-8').read(), name)
        if x: d = x
    if not d: sys.exit('missing ' + name)
    print(d + ';\n')
PY
) || die "could not extract helper definitions"
DDL_PP=$(grep -h "^CREATE TABLE IF NOT EXISTS pending_purchases " "$MIG/0002_tables.sql")
DDL_AL=$(grep -h "^CREATE TABLE IF NOT EXISTS admin_logs " "$MIG/0002_tables.sql")
[ -n "$DDL_PP" ] && [ -n "$DDL_AL" ] || die "0002 DDL not found"

"${PSQL[@]}" -q >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='project_admin') THEN CREATE ROLE project_admin NOLOGIN; END IF;
END \$\$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$\$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, project_admin;
CREATE TABLE public.users (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'user', username text, email text);
CREATE TABLE public.events (id uuid PRIMARY KEY, title text NOT NULL);
SET search_path TO public;
$DDL_PP
$DDL_AL
RESET search_path;
$HELPERS
INSERT INTO public.users (id, role, username, email) VALUES
  ('$ROOT', 'admin', 'root', 'root@example.com'), ('$ADMIN', 'admin', 'admin1', 'admin@example.com'),
  ('$SUB', 'sub-admin', 'sub1', 'sub@example.com'), ('$BUYER', 'user', 'buyer1', 'buyer@example.com'),
  ('$OTHER', 'user', 'other1', 'other@example.com');
INSERT INTO public.events (id, title) VALUES ('$EVENT', 'Afro Night');
INSERT INTO public.pending_purchases (event_id, user_id, ticket_type, attendees, attendees_hash, amount_kobo, payment_ref)
VALUES ('$EVENT', '$BUYER', 'VIP', '[]', 'h', 4567500, 'pay-ref-1');
SQL
[ $? -eq 0 ] || die "base schema failed"

echo "== apply 0226"
if "${PSQL[@]}" -q -f "$MIG/0226_payment_exceptions.sql" >"$OUT" 2>"$ERR"; then pass "0226 applies"; else fail "0226 applies ($(grep -m1 ERROR "$ERR"))"; fi
expect_error "0226 does not apply twice (transactional refusal)" "already exists" "$(cat "$MIG/0226_payment_exceptions.sql")"
expect_value "after a refused re-run, still exactly one table and four functions" \
  "SELECT (SELECT count(*) FROM pg_class WHERE relname='payment_exceptions') || '/' || (SELECT count(*) FROM pg_proc WHERE proname IN ('record_payment_exception','mark_payment_exception_ticketed','admin_list_payment_exceptions','admin_resolve_payment_exception'))" "1/4"

echo "== grants and RLS"
expect_value "RLS is enabled with no policies" "SELECT relrowsecurity::text || '/' || (SELECT count(*) FROM pg_policies WHERE tablename='payment_exceptions') FROM pg_class WHERE relname='payment_exceptions'" "true/0"
for role in anon authenticated; do
  expect_error "$role cannot read the table directly" "permission denied" "SET ROLE $role; SELECT * FROM public.payment_exceptions;"
  expect_error "$role cannot insert directly" "permission denied" "SET ROLE $role; INSERT INTO public.payment_exceptions (reference, reason, amount_kobo, source) VALUES ('x','not_found',1,'verify');"
  expect_error "$role cannot call record_payment_exception" "permission denied" "SET ROLE $role; SELECT public.record_payment_exception('PSK-a', NULL, 'not_found', NULL, 1, NULL, 'verify');"
  expect_error "$role cannot call mark_payment_exception_ticketed" "permission denied" "SET ROLE $role; SELECT public.mark_payment_exception_ticketed('PSK-a');"
done
expect_value "the list and resolve functions are not executable by anon" \
  "SELECT has_function_privilege('anon','public.admin_list_payment_exceptions(text,integer,integer)','EXECUTE')::text || '/' || has_function_privilege('anon','public.admin_resolve_payment_exception(uuid,text)','EXECUTE')::text" "false/false"
expect_value "every 0226 function is SECURITY DEFINER with an empty search_path" \
  "SELECT bool_and(prosecdef AND proconfig = ARRAY['search_path=\"\"'])::text FROM pg_proc WHERE proname IN ('record_payment_exception','mark_payment_exception_ticketed','admin_list_payment_exceptions','admin_resolve_payment_exception')" "true"

echo "== recording (server, project_admin)"
ID1=$(val "SET ROLE project_admin; SELECT public.record_payment_exception('PSK-sold', 'pay-ref-1', 'not_found', 'Only 0 VIP ticket(s) remaining', 4567500, NULL, 'verify');")
[[ "$ID1" =~ ^[0-9a-f-]{36}$ ]] && pass "project_admin records an exception" || fail "project_admin records an exception (got '$ID1')"
expect_value "buyer and event are linked from the pending purchase" \
  "SELECT user_id || '/' || event_id || '/' || status || '/' || seen_count || '/' || source FROM public.payment_exceptions WHERE reference='PSK-sold'" "$BUYER/$EVENT/open/1/verify"
ID2=$(val "SET ROLE project_admin; SELECT public.record_payment_exception('PSK-sold', 'pay-ref-1', 'not_found', 'a different later detail', 4567500, NULL, 'webhook');")
[ "$ID2" = "$ID1" ] && pass "a repeat (webhook after verify) returns the same row" || fail "a repeat returns the same row ($ID2 vs $ID1)"
expect_value "the repeat only bumps seen_count and keeps the first detail and source" \
  "SELECT count(*) || '/' || max(seen_count) || '/' || max(detail) || '/' || max(source) FROM public.payment_exceptions WHERE reference='PSK-sold'" "1/2/Only 0 VIP ticket(s) remaining/verify"
expect_ok "amount mismatch is recorded with the expected amount" "SET ROLE project_admin; SELECT public.record_payment_exception('PSK-mm', 'pay-ref-1', 'amount_mismatch', NULL, 100, 4567500, 'webhook');"
expect_value "mismatch row" "SELECT reason || '/' || amount_kobo || '/' || expected_kobo FROM public.payment_exceptions WHERE reference='PSK-mm'" "amount_mismatch/100/4567500"
expect_ok "an unknown reference with no pending purchase is still recorded (unlinked)" "SET ROLE project_admin; SELECT public.record_payment_exception('PSK-orphan', NULL, 'not_found', NULL, 5000, NULL, 'webhook');"
expect_value "unlinked row has no buyer or event" "SELECT (user_id IS NULL AND event_id IS NULL)::text FROM public.payment_exceptions WHERE reference='PSK-orphan'" "true"
expect_error "an unknown reason is refused" "payment_exceptions_reason_check" "SET ROLE project_admin; SELECT public.record_payment_exception('PSK-bad', NULL, 'refund_me', NULL, 1, NULL, 'verify');"
expect_error "a blank reference is refused" "reference required" "SET ROLE project_admin; SELECT public.record_payment_exception('  ', NULL, 'not_found', NULL, 1, NULL, 'verify');"
expect_error "an unknown source is refused" "payment_exceptions_source_check" "SET ROLE project_admin; SELECT public.record_payment_exception('PSK-src', NULL, 'not_found', NULL, 1, NULL, 'cron');"
expect_value "a negative amount is stored as 0, never negative" \
  "SET ROLE project_admin; SELECT public.record_payment_exception('PSK-neg', NULL, 'not_found', NULL, -5, NULL, 'verify') IS NOT NULL; RESET ROLE; SELECT amount_kobo FROM public.payment_exceptions WHERE reference='PSK-neg'" "0"

echo "== a later retry that issued the ticket"
expect_value "mark_payment_exception_ticketed closes an open row" "SET ROLE project_admin; SELECT public.mark_payment_exception_ticketed('PSK-mm')" "t"
expect_value "it is now ticket_issued with resolved_at set" "SELECT status || '/' || (resolved_at IS NOT NULL)::text FROM public.payment_exceptions WHERE reference='PSK-mm'" "ticket_issued/true"
expect_value "a second call is a no-op" "SET ROLE project_admin; SELECT public.mark_payment_exception_ticketed('PSK-mm')" "f"
expect_value "an unknown reference is a no-op" "SET ROLE project_admin; SELECT public.mark_payment_exception_ticketed('PSK-none')" "f"

echo "== admin list"
expect_error "anonymous (no uid) cannot list" "Admin access required" "$(as authenticated '') SELECT * FROM public.admin_list_payment_exceptions();"
expect_error "a plain user cannot list" "Admin access required" "$(as authenticated $BUYER) SELECT * FROM public.admin_list_payment_exceptions();"
expect_value "a Sub-Admin can list open exceptions, newest first" \
  "$(as authenticated $SUB) SELECT string_agg(reference, ',' ORDER BY first_seen_at DESC, id) FROM public.admin_list_payment_exceptions('open')" \
  "$(val "SELECT string_agg(reference, ',' ORDER BY first_seen_at DESC, id) FROM public.payment_exceptions WHERE status='open'")"
expect_value "the list carries buyer and event for follow-up" \
  "$(as authenticated $ADMIN) SELECT buyer_username || '/' || buyer_email || '/' || event_title FROM public.admin_list_payment_exceptions('open') WHERE reference='PSK-sold'" "buyer1/buyer@example.com/Afro Night"
expect_value "the status filter works (ticket_issued)" "$(as authenticated $ADMIN) SELECT string_agg(reference, ',') FROM public.admin_list_payment_exceptions('ticket_issued')" "PSK-mm"
expect_value "NULL status lists everything" "$(as authenticated $ADMIN) SELECT count(*) FROM public.admin_list_payment_exceptions(NULL)" "$(val "SELECT count(*) FROM public.payment_exceptions")"
expect_error "an unknown status filter is refused" "Invalid status" "$(as authenticated $ADMIN) SELECT * FROM public.admin_list_payment_exceptions('everything');"
expect_value "the limit is capped at 200 and floored at 1" "$(as authenticated $ADMIN) SELECT count(*) FROM public.admin_list_payment_exceptions(NULL, 0)" "1"

echo "== admin resolve (records only; no money)"
expect_error "a Sub-Admin cannot resolve" "Admin access required" "$(as authenticated $SUB) SELECT public.admin_resolve_payment_exception('$ID1', 'Refunded in Paystack dashboard');"
expect_error "a plain user cannot resolve" "Admin access required" "$(as authenticated $BUYER) SELECT public.admin_resolve_payment_exception('$ID1', 'Refunded in Paystack dashboard');"
expect_error "a note is required" "A resolution note is required" "$(as authenticated $ADMIN) SELECT public.admin_resolve_payment_exception('$ID1', '  ok ');"
expect_error "an unknown id is refused" "Payment exception not found" "$(as authenticated $ADMIN) SELECT public.admin_resolve_payment_exception(gen_random_uuid(), 'Refunded in Paystack dashboard');"
expect_ok "an Admin resolves it with a note" "$(as authenticated $ADMIN) SELECT public.admin_resolve_payment_exception('$ID1', 'Refunded in Paystack dashboard, ref RF-1');"
expect_value "it is resolved, with who and when" \
  "SELECT status || '/' || resolved_by || '/' || (resolved_at IS NOT NULL)::text || '/' || resolution_note FROM public.payment_exceptions WHERE id='$ID1'" \
  "resolved/$ADMIN/true/Refunded in Paystack dashboard, ref RF-1"
expect_value "it is written to admin_logs with the actor role" \
  "SELECT action || '/' || actor_role || '/' || (details->>'reference') || '/' || (details->>'amount_kobo') FROM public.admin_logs WHERE admin_id='$ADMIN'" "payment_exception_resolved/admin/PSK-sold/4567500"
expect_error "a closed exception cannot be resolved again" "already closed" "$(as authenticated $ROOT) SELECT public.admin_resolve_payment_exception('$ID1', 'Second attempt to resolve');"
ID_MM=$(val "SELECT id FROM public.payment_exceptions WHERE reference='PSK-mm'")
ID_ORPHAN=$(val "SELECT id FROM public.payment_exceptions WHERE reference='PSK-orphan'")
expect_error "a ticket_issued exception cannot be resolved" "already closed" "$(as authenticated $ROOT) SELECT public.admin_resolve_payment_exception('$ID_MM', 'Not needed, ticket exists');"
expect_ok "Root can resolve" "$(as authenticated $ROOT) SELECT public.admin_resolve_payment_exception('$ID_ORPHAN', 'Not a VENTS order; refunded');"
expect_value "Root's resolution is logged as root" "SELECT actor_role FROM public.admin_logs WHERE admin_id='$ROOT'" "root"
expect_ok "a later webhook retry for a resolved reference is accepted" "SET ROLE project_admin; SELECT public.record_payment_exception('PSK-sold', 'pay-ref-1', 'not_found', NULL, 4567500, NULL, 'webhook');"
expect_value "...but never reopens it (still resolved; seen_count bumped)" "SELECT status || '/' || seen_count FROM public.payment_exceptions WHERE id='$ID1'" "resolved/3"
expect_value "mark_payment_exception_ticketed never touches a resolved row" "SET ROLE project_admin; SELECT public.mark_payment_exception_ticketed('PSK-sold')" "f"
expect_error "the resolution invariant holds (open with resolved_at is impossible)" "payment_exceptions_resolution_ck" "UPDATE public.payment_exceptions SET status='open' WHERE id='$ID1';"

echo "== nothing else touched"
expect_value "the pending purchase is unchanged" "SELECT status || '/' || amount_kobo FROM public.pending_purchases WHERE payment_ref='pay-ref-1'" "pending/4567500"

echo "== undo_0226"
UNDO="$REPO_ROOT/supabase/rollback/undo_0226.sql"
expect_error "undo refuses without the confirmation setting" "Refusing" "$(cat "$UNDO")"
expect_value "...and dropped nothing" "SELECT count(*) FROM pg_class WHERE relname='payment_exceptions'" "1"
expect_ok "undo runs with the confirmation setting" "SET vents.rollback_confirm = 'undo-0226'; $(cat "$UNDO")"
expect_value "every 0226 object is gone" \
  "SELECT (SELECT count(*) FROM pg_class WHERE relname='payment_exceptions') + (SELECT count(*) FROM pg_proc WHERE proname IN ('record_payment_exception','mark_payment_exception_ticketed','admin_list_payment_exceptions','admin_resolve_payment_exception'))" "0"
if "${PSQL[@]}" -q -f "$MIG/0226_payment_exceptions.sql" >"$OUT" 2>"$ERR"; then pass "0226 re-applies cleanly after undo"; else fail "0226 re-applies after undo ($(grep -m1 ERROR "$ERR"))"; fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES PAYMENT EXCEPTIONS (0226) CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
