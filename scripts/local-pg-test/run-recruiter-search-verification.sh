#!/usr/bin/env bash
# Real-execution verification for migration 0204
# (search_recruiter_invite_targets: the Representative Find tab's search).
#
# Runs against a throwaway local PostgreSQL database (`sudo -u postgres
# psql`); auth.uid() is backed by the `test.uid` GUC, as in
# run-recruiter-invite-target-verification.sh. check_rate_limit is the
# verbatim production body (read 2026-10-31), so the rate-limit test
# exercises the real counter. Never touches the real Supabase project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
M0196="$REPO_ROOT/supabase/migrations/0196_recruiter_invite_target_uses_organizer_capability.sql"
M0204="$REPO_ROOT/supabase/migrations/0204_search_recruiter_invite_targets.sql"
DB_NAME="vents_local_pg_recruiter_search_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

REP="00000000-0000-0000-0000-00000000e001"
SUSPENDED_REP="00000000-0000-0000-0000-00000000e002"
NOT_REP="00000000-0000-0000-0000-00000000e003"
ORG_FLAG="00000000-0000-0000-0000-00000000e010"      # adebayo_events: is_organizer
ORG_EVENTS="00000000-0000-0000-0000-00000000e011"    # tundebayo: events only
PROVIDER="00000000-0000-0000-0000-00000000e012"      # glowbayo: approved provider
PENDING_PROV="00000000-0000-0000-0000-00000000e013"  # bayopending: provider not approved
PLAIN="00000000-0000-0000-0000-00000000e014"         # bayoplain: attendee
DELETED="00000000-0000-0000-0000-00000000e015"       # bayodeleted: deleted organizer
UNDERSCORE="00000000-0000-0000-0000-00000000e016"    # a_b: organizer (wildcard test)
LOOKALIKE="00000000-0000-0000-0000-00000000e017"     # axb: organizer (must not match 'a_b')
NAME_ONLY="00000000-0000-0000-0000-00000000e018"     # zz123, full name "Chioma Okafor": organizer

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
expect_value() {
  local label="$1" sql="$2" expected="$3" actual
  actual=$(sudo -u postgres psql -tA -d "$DB_NAME" -c "$sql" 2>&1 | tail -n1)
  if [ "$actual" = "$expected" ]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
expect_error() {
  local label="$1" expected="$2" sql="$3"
  if sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "$sql" >/dev/null 2>/tmp/rsearch_err.log; then
    fail "$label (expected an exception, call succeeded)"; return
  fi
  if grep -q "$expected" /tmp/rsearch_err.log; then pass "$label"; else fail "$label (wrong error)"; cat /tmp/rsearch_err.log >&2; fi
}
# names <caller> <query> -> comma-separated usernames in result order
names() {
  echo "SET ROLE authenticated; SET test.uid='$1'; SELECT coalesce(string_agg(username, ',' ORDER BY ord), '') FROM (SELECT username, row_number() OVER () AS ord FROM public.search_recruiter_invite_targets(\$q\$$2\$q\$)) s;"
}

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;" >/dev/null

"${PSQL[@]}" -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT current_setting('test.uid', true)::uuid $$;
CREATE TABLE public.users (
  id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'user', username text, full_name text,
  avatar_url text, email text, is_organizer boolean NOT NULL DEFAULT false,
  is_service_provider boolean NOT NULL DEFAULT false, deleted_at timestamptz
);
CREATE TABLE public.events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL);
CREATE TABLE public.service_providers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, status text NOT NULL);
CREATE TABLE public.recruiters (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'active');
CREATE TABLE public.rate_limits (key text, window_start bigint, count integer, PRIMARY KEY (key, window_start));
-- Verbatim production body of public.check_rate_limit (2026-10-31).
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_attempts integer, p_window_seconds integer)
 RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  v_window bigint := floor(extract(epoch FROM now()) / p_window_seconds)::bigint;
  v_count  integer;
BEGIN
  INSERT INTO public.rate_limits (key, window_start, count)
  VALUES (p_key, v_window, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = public.rate_limits.count + 1
  RETURNING count INTO v_count;
  IF random() < 0.02 THEN
    DELETE FROM public.rate_limits WHERE window_start < v_window - 10;
  END IF;
  IF v_count > p_max_attempts THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0429';
  END IF;
END;
$function$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
SQL

# 0196 defines recruiter_target_is_organizer; take only that helper (the rest
# of 0196 needs recruiter tables this test does not model).
awk '/CREATE OR REPLACE FUNCTION public.recruiter_target_is_organizer/{f=1} f{print} f&&/^\$function\$;/{exit}' "$M0196" | "${PSQL[@]}" -q >/dev/null

"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, username, full_name, is_organizer, deleted_at) VALUES
  ('$REP', 'rep_one', 'Rep One', false, NULL),
  ('$SUSPENDED_REP', 'rep_two', 'Rep Two', false, NULL),
  ('$NOT_REP', 'just_me', 'Just Me', false, NULL),
  ('$ORG_FLAG', 'adebayo_events', 'Adebayo Events', true, NULL),
  ('$ORG_EVENTS', 'tundebayo', 'Tunde Bayo', false, NULL),
  ('$PROVIDER', 'glowbayo', 'Glow Studio', false, NULL),
  ('$PENDING_PROV', 'bayopending', 'Pending Provider', false, NULL),
  ('$PLAIN', 'bayoplain', 'Plain Attendee', false, NULL),
  ('$DELETED', 'bayodeleted', 'Deleted Org', true, now()),
  ('$UNDERSCORE', 'a_b', 'Underscore Org', true, NULL),
  ('$LOOKALIKE', 'axb', 'Lookalike Org', true, NULL),
  ('$NAME_ONLY', 'zz123', 'Chioma Okafor', true, NULL);
INSERT INTO public.events (organizer_id) VALUES ('$ORG_EVENTS');
INSERT INTO public.service_providers (user_id, status) VALUES ('$PROVIDER', 'approved'), ('$PENDING_PROV', 'pending');
INSERT INTO public.recruiters (id, status) VALUES ('$REP', 'active'), ('$SUSPENDED_REP', 'suspended');
SQL

"${PSQL[@]}" -q -f "$M0204" >/dev/null

# --- partial matching + eligibility -----------------------------------------
expect_value "infix 'bayo' returns only eligible users (flag organizer, events organizer, approved provider)" \
  "$(names "$REP" "bayo")" "glowbayo,tundebayo,adebayo_events"
expect_value "prefix match ranks before infix matches" \
  "$(names "$REP" "ade")" "adebayo_events"
expect_value "case-insensitive" "$(names "$REP" "BAYO")" "glowbayo,tundebayo,adebayo_events"
expect_value "leading @ is ignored" "$(names "$REP" "@tunde")" "tundebayo"
expect_value "exact username ranks first" "$(names "$REP" "glowbayo")" "glowbayo"
expect_value "matches full name too" "$(names "$REP" "okafor")" "zz123"
expect_value "'_' is literal, not a wildcard" "$(names "$REP" "a_b")" "a_b"
expect_value "'%' is literal, not a wildcard" "$(names "$REP" "a%b")" ""
expect_value "plain attendee is excluded" "$(names "$REP" "bayoplain")" ""
expect_value "provider whose listing is not approved is excluded" "$(names "$REP" "bayopending")" ""
expect_value "deleted organizer is excluded" "$(names "$REP" "bayodeleted")" ""
expect_value "single character returns nothing" "$(names "$REP" "b")" ""
expect_value "caller never sees themselves" "$(names "$REP" "rep_one")" ""
expect_value "eligibility fields are returned (provider id for the provider)" \
  "SET ROLE authenticated; SET test.uid='$REP'; SELECT target_is_organizer || '|' || (target_provider_id IS NOT NULL) FROM public.search_recruiter_invite_targets('glowbayo');" \
  "false|true"
expect_value "eligibility fields are returned (organizer flag)" \
  "SET ROLE authenticated; SET test.uid='$REP'; SELECT target_is_organizer || '|' || (target_provider_id IS NOT NULL) FROM public.search_recruiter_invite_targets('tundebayo');" \
  "true|false"

# --- authorization ------------------------------------------------------------
expect_error "unauthenticated caller is refused" "Not authenticated" \
  "SET ROLE authenticated; SELECT * FROM public.search_recruiter_invite_targets('bayo');"
expect_error "a user who is not a representative is refused" "Only active representatives" \
  "SET ROLE authenticated; SET test.uid='$NOT_REP'; SELECT * FROM public.search_recruiter_invite_targets('bayo');"
expect_error "a suspended representative is refused" "Only active representatives" \
  "SET ROLE authenticated; SET test.uid='$SUSPENDED_REP'; SELECT * FROM public.search_recruiter_invite_targets('bayo');"
expect_error "anon cannot execute" "permission denied" \
  "SET ROLE anon; SELECT * FROM public.search_recruiter_invite_targets('bayo');"

# --- rate limit: own bucket, 60 per minute -----------------------------------
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits;"
expect_value "60 searches in one window all succeed" \
  "SET ROLE authenticated; SET test.uid='$REP'; DO \$\$ BEGIN FOR i IN 1..60 LOOP PERFORM * FROM public.search_recruiter_invite_targets('bayo'); END LOOP; END \$\$; SELECT 'ok';" \
  "ok"
expect_error "the 61st search in the same window raises rate_limited" "rate_limited" \
  "SET ROLE authenticated; SET test.uid='$REP'; SELECT * FROM public.search_recruiter_invite_targets('bayo');"
expect_value "the bucket is separate from checkout's search_users bucket" \
  "SELECT count(*) FROM public.rate_limits WHERE key LIKE 'search_users:%';" "0"
expect_value "a refused call does not consume allowance (count stays at the cap)" \
  "SELECT max(count) FROM public.rate_limits WHERE key = 'recruiter_search:$REP';" "60"

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null

if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) FAILED" >&2; exit 1; fi
echo "All recruiter search checks passed."
