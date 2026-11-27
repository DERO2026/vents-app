#!/usr/bin/env bash
# Batch 1 access hardening, tested as the real database roles (not the UI):
#
#   0235 (AZ-32)  boost_event_vc: anon and signed-in users can no longer
#                 execute it (before: a signed-in organizer was charged
#                 1,000 VENTS Cents for a boost with no effect); the server
#                 role keeps it;
#   0236 (AZ-16)  events: anonymous and signed-in non-owners can't read
#                 drafts or admin-hidden events (before: anyone could); the
#                 organizer and admins/sub-admins still can; live, Coming
#                 Soon, ended and cancelled events stay public; a ticket
#                 holder keeps access to an event later hidden or moved to
#                 draft; deleted events stay invisible to the public; an
#                 anonymous read never errors on the ticket check;
#   0237 (AZ-33)  organizer_reviews: only a caller with an active, paid,
#                 checked-in ticket for one of that organizer's events can
#                 write or edit a review; no self-reviews; one per organizer;
#                 cancelled, refunded, unpaid and not-checked-in tickets don't
#                 count; admins get no bypass;
#   and each migration's refusal to run twice and its gated undo.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
RB="$REPO_ROOT/supabase/rollback"
DB_NAME="vents_local_pg_access_hardening"
SOCKET_DIR="/var/run/postgresql"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL BACKUP_DB_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then die "\$$var is set. Unset it; this test only connects to the local Unix socket."; fi
done
if env | grep -qiE 'supabase\.(co|com)|pooler\.|rds\.amazonaws\.com|neon\.tech|render\.com'; then
  die "an environment variable references a hosted database host."
fi
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z_]+$ ]] || die "database name '$DB_NAME' is not a local test name."
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || die "no local PostgreSQL socket at $SOCKET_DIR (start it: pg_ctlcluster 16 main start)."
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }
PSQL=(pg -d "$DB_NAME")
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || die "connection is not a local, non-Supabase PostgreSQL server ($server_check)."

TMP=$(mktemp -d); OUT="$TMP/out"; ERR="$TMP/err"
chmod 777 "$TMP"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ORG="00000000-0000-0000-0000-000000000a01"
ORG2="00000000-0000-0000-0000-000000000a02"
ADMIN="00000000-0000-0000-0000-000000000b01"
SUB="00000000-0000-0000-0000-000000000b03"
USER="00000000-0000-0000-0000-000000000c01"
HOLDER="00000000-0000-0000-0000-000000000c02"
ATT="00000000-0000-0000-0000-000000000c03"   # attended (checked in)
NOSHOW="00000000-0000-0000-0000-000000000c04" # paid, never checked in
REFUNDED="00000000-0000-0000-0000-000000000c05"
EV_LIVE=10000000-0000-0000-0000-00000000e001; EV_DRAFT=10000000-0000-0000-0000-00000000e002
EV_HIDDEN=10000000-0000-0000-0000-00000000e003; EV_DELETED=10000000-0000-0000-0000-00000000e004
EV_SOON=10000000-0000-0000-0000-00000000e005; EV_CANCEL=10000000-0000-0000-0000-00000000e006
EV_PAST=10000000-0000-0000-0000-00000000e007; EV_HELD=10000000-0000-0000-0000-00000000e008
EV_O2=10000000-0000-0000-0000-00000000e009

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
as_anon() { printf "SET ROLE anon; %s" "$1"; }   # no test.uid: auth.uid() is NULL, as for a real visitor
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
expect_error() {
  if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an exception, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error)"; cat "$ERR" >&2; fi
}
# shellcheck source=lib-money-stack.sh
. "$SCRIPT_DIR/lib-money-stack.sh"

ALL_EVENTS="'$EV_LIVE','$EV_DRAFT','$EV_HIDDEN','$EV_DELETED','$EV_SOON','$EV_CANCEL','$EV_PAST','$EV_HELD'"
seen_by() { val "$(as "$1" "SELECT COALESCE(string_agg(title, ',' ORDER BY title), '') FROM public.events WHERE id IN ($ALL_EVENTS);")"; }
seen_anon() { val "$(as_anon "SELECT COALESCE(string_agg(title, ',' ORDER BY title), '') FROM public.events WHERE id IN ($ALL_EVENTS);")"; }
review() { printf "INSERT INTO public.organizer_reviews (organizer_id, reviewer_id, rating, body) VALUES ('%s', '%s', 5, 'Great night');" "$1" "$2"; }

echo "== Building throwaway database $DB_NAME =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
build_ticket_stack
"${PSQL[@]}" -q <<SQL
-- Production grants on events (0012: anon and authenticated may SELECT; RLS decides rows).
GRANT SELECT ON public.events TO anon;
-- Production's is_admin() is SECURITY DEFINER (0004): anonymous callers can evaluate it.
ALTER FUNCTION public.is_admin() SECURITY DEFINER SET search_path TO '';
-- organizer_reviews exactly as production (0002 table, 0005 keys, 0008 policies, 0012 grants).
CREATE TABLE IF NOT EXISTS organizer_reviews (id uuid NOT NULL DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL, reviewer_id uuid NOT NULL, rating smallint NOT NULL, body text NOT NULL, created_at timestamptz DEFAULT now());
ALTER TABLE organizer_reviews ADD CONSTRAINT organizer_reviews_pkey PRIMARY KEY (id);
ALTER TABLE organizer_reviews ADD CONSTRAINT organizer_reviews_organizer_id_reviewer_id_key UNIQUE (organizer_id, reviewer_id);
ALTER TABLE organizer_reviews ENABLE ROW LEVEL SECURITY;
$(grep -E '^CREATE POLICY organizer_reviews_' "$MIG/0008_rls_and_policies.sql")
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizer_reviews TO authenticated;
GRANT SELECT ON public.organizer_reviews TO anon;
-- boost_event_vc exactly as 0004, with 0011's grants; its VC helpers stubbed.
CREATE TABLE IF NOT EXISTS public.vc_event_boosts (event_id uuid, user_id uuid, expires_at timestamptz, boosted_at timestamptz DEFAULT now(), PRIMARY KEY (event_id, user_id));
CREATE OR REPLACE FUNCTION public._vc_deduct(p_user uuid, p_amount integer, p_reason text) RETURNS void LANGUAGE sql AS \$\$ SELECT NULL \$\$;
SQL
"${PSQL[@]}" -q -c "SET search_path TO public; $(awk '/^-- Function: boost_event_vc$/{f=1;next} f&&/^-- Function:/{exit} f' "$MIG/0004_functions.sql")"
"${PSQL[@]}" -q -c "$(grep -E 'boost_event_vc' "$MIG/0011_grants.sql")"
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test'), ('$ORG2', 'user', true, 'Org Two', 'org2@example.test'),
  ('$ADMIN', 'admin', false, 'Admin', 'a@example.test'), ('$SUB', 'sub-admin', false, 'Sub', 's@example.test'),
  ('$USER', 'user', false, 'User', 'u@example.test'), ('$HOLDER', 'user', false, 'Holder', 'h@example.test'),
  ('$ATT', 'user', false, 'Attendee', 'att@example.test'), ('$NOSHOW', 'user', false, 'No show', 'ns@example.test'),
  ('$REFUNDED', 'user', false, 'Refunded', 'rf@example.test');
INSERT INTO public.events (id, organizer_id, title, event_date, status, hidden_by_admin, deleted_at, cancelled_at, ticket_types) VALUES
  ('$EV_LIVE',    '$ORG', 'live',      now() + interval '9 days',  'live',        false, NULL,  NULL,  '[]'),
  ('$EV_DRAFT',   '$ORG', 'draft',     now() + interval '9 days',  'draft',       false, NULL,  NULL,  '[]'),
  ('$EV_HIDDEN',  '$ORG', 'hidden',    now() + interval '9 days',  'live',        true,  NULL,  NULL,  '[]'),
  ('$EV_DELETED', '$ORG', 'deleted',   now() + interval '9 days',  'live',        false, now(), NULL,  '[]'),
  ('$EV_CANCEL',  '$ORG', 'cancelled', now() + interval '9 days',  'live',        false, NULL,  now(), '[]'),
  ('$EV_PAST',    '$ORG', 'past',      now() - interval '9 days',  'live',        false, NULL,  NULL,  '[]'),
  ('$EV_HELD',    '$ORG', 'held',      now() + interval '9 days',  'draft',       false, NULL,  NULL,  '[]'),
  ('$EV_O2',      '$ORG2','o2',        now() - interval '5 days',  'live',        false, NULL,  NULL,  '[]');
INSERT INTO public.tickets (event_id, user_id, quantity, status, payment_status, amount, checked_in) VALUES
  ('$EV_HELD', '$HOLDER', 1, 'active', 'paid', 5000, false),
  ('$EV_PAST', '$ATT', 1, 'active', 'paid', 5000, true),
  ('$EV_PAST', '$NOSHOW', 1, 'active', 'paid', 5000, false),
  ('$EV_PAST', '$REFUNDED', 1, 'cancelled', 'refunded', 5000, true),
  ('$EV_O2', '$USER', 1, 'active', 'paid', 0, true);
SQL
# Coming Soon only exists with 0224; mirror its status value locally if absent.
"${PSQL[@]}" -q -c "ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check; INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES ('$EV_SOON', '$ORG', 'soon', now() + interval '30 days', 'coming_soon', '[]');"

echo "-- before: the exposure (0008 policy) --"
expect_value "BEFORE 0236: an anonymous visitor reads drafts and hidden events" "$(seen_anon)" "cancelled,draft,held,hidden,live,past,soon"
expect_value "BEFORE 0237: any user can review any organizer" "$(val "$(as "$USER" "$(review "$ORG" "$USER") SELECT 'written';")")" "written"
"${PSQL[@]}" -q -c "DELETE FROM public.organizer_reviews;"
expect_value "BEFORE 0235: a signed-in user can execute boost_event_vc" "$(val "SELECT has_function_privilege('authenticated', 'public.boost_event_vc(uuid)', 'EXECUTE');")" "t"

echo "== Applying 0235, 0236, 0237 =="
for m in 0235_revoke_boost_event_vc 0236_event_read_privacy 0237_organizer_review_attendance; do
  expect_ok "$m applies" "$(cat "$MIG/$m.sql")"
done
expect_error "0236 refuses a second run" "already applied" "$(cat "$MIG/0236_event_read_privacy.sql")"
expect_error "0237 refuses a second run" "already applied" "$(cat "$MIG/0237_organizer_review_attendance.sql")"

echo "-- 0235: boost_event_vc --"
expect_value "anon can't execute boost_event_vc" "$(val "SELECT has_function_privilege('anon', 'public.boost_event_vc(uuid)', 'EXECUTE');")" "f"
expect_value "signed-in users can't execute it" "$(val "SELECT has_function_privilege('authenticated', 'public.boost_event_vc(uuid)', 'EXECUTE');")" "f"
expect_error "an organizer calling it on their own event is refused" "permission denied" "$(as "$ORG" "SELECT public.boost_event_vc('$EV_LIVE');")"
expect_value "...and no boost row was written" "$(val "SELECT count(*) FROM public.vc_event_boosts;")" "0"
expect_value "the server role keeps it" "$(val "SELECT has_function_privilege('project_admin', 'public.boost_event_vc(uuid)', 'EXECUTE');")" "t"

echo "-- 0236: who sees which events --"
expect_value "anonymous: only public events (live, Coming Soon, cancelled, past)" "$(seen_anon)" "cancelled,live,past,soon"
expect_value "a signed-in stranger: the same" "$(seen_by "$USER")" "cancelled,live,past,soon"
expect_value "the organizer: everything not deleted, plus their deleted event (unchanged)" "$(seen_by "$ORG")" "cancelled,deleted,draft,held,hidden,live,past,soon"
expect_value "an admin: everything" "$(seen_by "$ADMIN")" "cancelled,deleted,draft,held,hidden,live,past,soon"
expect_value "a sub-admin: everything (is_admin, unchanged)" "$(seen_by "$SUB")" "cancelled,deleted,draft,held,hidden,live,past,soon"
expect_value "a ticket holder keeps their event after it moved back to draft" "$(seen_by "$HOLDER")" "cancelled,held,live,past,soon"
expect_value "a direct read of a draft by id (shared link) returns nothing" "$(val "$(as_anon "SELECT count(*) FROM public.events WHERE id = '$EV_DRAFT';")")" "0"
expect_value "a saved-event style join hides the draft" "$(val "$(as "$USER" "SELECT count(*) FROM (VALUES ('$EV_DRAFT'::uuid), ('$EV_LIVE'::uuid)) s(id) JOIN public.events e ON e.id = s.id;")")" "1"
expect_value "the organizer can still edit their draft" "$(val "$(as "$ORG" "WITH u AS (UPDATE public.events SET title = 'draft' WHERE id = '$EV_DRAFT' RETURNING 1) SELECT CASE WHEN count(*) = 1 THEN 'ok' END FROM u;")")" "ok"
expect_value "anonymous reads never trip on the ticket check (no tickets access)" "$(val "$(as_anon "SELECT count(*) FROM public.events;")")" "5"

echo "-- 0237: reviews need attendance --"
expect_value "a checked-in, paid attendee can review the organizer" "$(val "$(as "$ATT" "$(review "$ORG" "$ATT") SELECT 'ok';")")" "ok"
expect_error "...once (one review per organizer)" "duplicate key" "$(as "$ATT" "$(review "$ORG" "$ATT")")"
expect_error "a stranger can't" "row-level security" "$(as "$USER" "$(review "$ORG" "$USER")")"
expect_error "a paid ticket never checked in doesn't count" "row-level security" "$(as "$NOSHOW" "$(review "$ORG" "$NOSHOW")")"
expect_error "a refunded ticket doesn't count" "row-level security" "$(as "$REFUNDED" "$(review "$ORG" "$REFUNDED")")"
expect_error "the organizer can't review themselves" "row-level security" "$(as "$ORG" "$(review "$ORG" "$ORG")")"
expect_error "an admin gets no bypass" "row-level security" "$(as "$ADMIN" "$(review "$ORG" "$ADMIN")")"
expect_error "a reviewer can't impersonate another reviewer" "row-level security" "$(as "$USER" "$(review "$ORG" "$ATT")")"
expect_value "a free-event attendee (checked in) can review that organizer" "$(val "$(as "$USER" "$(review "$ORG2" "$USER") SELECT 'ok';")")" "ok"
expect_error "a review can't be moved to an organizer the reviewer never attended" "row-level security" \
  "$(as "$USER" "UPDATE public.organizer_reviews SET organizer_id = '$ORG' WHERE reviewer_id = '$USER';")"
expect_value "the attendee can still edit their own review" "$(val "$(as "$ATT" "WITH u AS (UPDATE public.organizer_reviews SET rating = 4 WHERE reviewer_id = '$ATT' RETURNING rating) SELECT rating FROM u;")")" "4"
expect_value "reviews stay publicly readable" "$(val "$(as_anon "SELECT count(*) FROM public.organizer_reviews;")")" "2"

echo "-- undo --"
for n in 0235 0236 0237; do
  expect_error "undo_$n refuses without the gate" "Refusing" "$(cat "$RB/undo_$n.sql")"
  expect_ok "undo_$n runs with the gate" "SET vents.rollback_confirm = 'undo-$n'; $(cat "$RB/undo_$n.sql")"
done
expect_value "after undo the old (exposed) behaviour is back exactly" "$(seen_anon)/$(val "SELECT has_function_privilege('authenticated', 'public.boost_event_vc(uuid)', 'EXECUTE');")" "cancelled,draft,held,hidden,live,past,soon/t"
expect_value "the restored events policy is 0008's, verbatim" \
  "$(val "SELECT regexp_replace(pg_get_expr(polqual, polrelid), '\s+', '', 'g') FROM pg_policy WHERE polrelid = 'public.events'::regclass AND polname = 'select_events';")" \
  "((deleted_atISNULL)OR(organizer_id=(SELECTauth.uid()ASuid))ORis_admin())"
for m in 0235_revoke_boost_event_vc 0236_event_read_privacy 0237_organizer_review_attendance; do
  expect_ok "$m re-applies after undo" "$(cat "$MIG/$m.sql")"
done
"${PSQL[@]}" -q -c "CREATE POLICY select_events_extra ON public.events FOR SELECT TO public USING (true);"
"${PSQL[@]}" -q -c "SET vents.rollback_confirm = 'undo-0236';" -f "$RB/undo_0236.sql" >/dev/null
expect_error "0236 refuses when another SELECT policy would still expose events" "other SELECT policies" "$(cat "$MIG/0236_event_read_privacy.sql")"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES ACCESS HARDENING CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
