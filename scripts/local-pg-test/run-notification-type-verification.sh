#!/usr/bin/env bash
# Real-execution verification for migration 0198 (notifications_type_check
# allows 'announcement'; dead send_event_reminders() dropped).
#
# Builds the real announcement schema (0189) and the real
# admin_send_announcement (0191) on top of schema-vents-earn.sql, whose
# notifications table carries production's notifications_type_check
# verbatim, then:
#   - before 0198: reproduces the production failure (organizers /
#     service_providers sends violate the constraint and leave nothing
#     behind) while the 'everyone' send works
#   - applies 0198 in a single transaction and proves: the constraint is
#     exactly the original eight values plus 'announcement'; every original
#     type is still accepted; 'event_reminder' and the old recruiter types
#     are still rejected; role-scoped sends now deliver only to their
#     group's unmuted members; non-admins are still refused;
#     send_event_reminders() is gone
#
# Prerequisites and conventions: identical to
# run-vents-earn-verification.sh (local PostgreSQL via `sudo -u postgres
# psql`, auth.uid() backed by the `test.uid` GUC). Never touches the real
# Supabase project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
M0189="$MIG/0189_announcement_groups_schema_foundation.sql"
M0191="$MIG/0191_admin_send_announcement.sql"
M0198="$MIG/0198_notifications_type_check_allow_announcement.sql"
DB_NAME="vents_local_pg_notification_type_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

ADMIN="00000000-0000-0000-0000-00000000e001"
ORG1="00000000-0000-0000-0000-00000000e002"
ORG2="00000000-0000-0000-0000-00000000e003"   # mutes organizers
PROV="00000000-0000-0000-0000-00000000e004"
PLAIN="00000000-0000-0000-0000-00000000e005"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }

expect_error() {
  local label="$1" expected="$2" sql="$3"
  if sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "$sql" >/tmp/ntype_out.log 2>/tmp/ntype_err.log; then
    fail "$label (expected an exception, call succeeded)"; return
  fi
  if grep -q "$expected" /tmp/ntype_err.log; then pass "$label"; else fail "$label (wrong error text)"; cat /tmp/ntype_err.log >&2; fi
}
expect_ok() {
  local label="$1" sql="$2"
  if sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "$sql" >/tmp/ntype_out.log 2>/tmp/ntype_err.log; then
    pass "$label"; else fail "$label (expected success, got an exception)"; cat /tmp/ntype_err.log >&2; fi
}
# expect_value "<label>" "<sql returning one scalar>" "<expected>"
expect_value() {
  local label="$1" sql="$2" expected="$3" actual
  actual=$(sudo -u postgres psql -tA -d "$DB_NAME" -c "$sql" 2>&1 | tail -n1)
  if [ "$actual" = "$expected" ]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
send() { # send <caller> <audience>
  echo "SET test.uid='$1'; SELECT public.admin_send_announcement('$2', 'Title', 'Body');"
}
counts() { # "<announcement rows>/<announcement_sent logs>"
  echo "SELECT (SELECT count(*) FROM public.notifications WHERE type='announcement') || '/' || (SELECT count(*) FROM public.admin_logs WHERE action='announcement_sent');"
}

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null

# What 0189/0191 need beyond schema-vents-earn.sql. is_admin_or_root() is
# a stub with the same meaning as production's (root or role = 'admin').
# send_event_reminders() is a same-signature stand-in for 0004's (whose
# body needs the full tickets/events schema) -- 0198 only drops it.
"${PSQL[@]}" -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='project_admin') THEN CREATE ROLE project_admin; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.is_admin_or_root() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin') $$;
CREATE TABLE public.admin_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid,
  action text NOT NULL,
  target_user_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE FUNCTION public.send_event_reminders() RETURNS void LANGUAGE sql AS
$$ INSERT INTO public.notifications (user_id, type, title, body, icon) VALUES (NULL, 'event_reminder', 't', 'b', 'ticket') $$;
REVOKE ALL ON FUNCTION public.send_event_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_event_reminders() TO project_admin;
SQL

"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, is_service_provider) VALUES
  ('$ADMIN', 'admin', false, false),
  ('$ORG1', 'user', true, false),
  ('$ORG2', 'user', true, false),
  ('$PROV', 'user', false, true),
  ('$PLAIN', 'user', false, false);
SQL
"${PSQL[@]}" -q -f "$M0189" >/dev/null   # backfills group membership from the flags above
"${PSQL[@]}" -q -f "$M0191" >/dev/null
"${PSQL[@]}" -q -c "INSERT INTO public.announcement_mutes (user_id, group_id) SELECT '$ORG2', id FROM public.announcement_groups WHERE key='organizers';"

echo "== Before 0198: reproduce the production failure =="
expect_value "group membership: 2 organizers, 1 service provider" \
  "SELECT string_agg(g.key || '=' || n, ',' ORDER BY g.key) FROM (SELECT group_id, count(*) n FROM public.announcement_group_members GROUP BY group_id) m JOIN public.announcement_groups g ON g.id = m.group_id;" \
  "organizers=2,service_providers=1"
expect_error "organizers send violates notifications_type_check" 'violates check constraint "notifications_type_check"' "$(send "$ADMIN" organizers)"
expect_error "service_providers send violates notifications_type_check" 'violates check constraint "notifications_type_check"' "$(send "$ADMIN" service_providers)"
expect_value "failed sends left nothing behind (no notifications, no admin_logs)" "$(counts)" "0/0"
expect_ok "everyone send works ('broadcast')" "$(send "$ADMIN" everyone)"
expect_value "everyone send reached the 4 non-admin users" "SELECT count(*) FROM public.notifications WHERE type='broadcast';" "4"
expect_error "send_event_reminders() also violates it ('event_reminder')" 'violates check constraint "notifications_type_check"' \
  "SELECT public.send_event_reminders();"

"${PSQL[@]}" -q -1 -f "$M0198" >/dev/null
echo "== After 0198 =="
expect_value "constraint is exactly the original eight plus 'announcement'" \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='notifications_type_check' AND conrelid='public.notifications'::regclass;" \
  "CHECK ((type = ANY (ARRAY['reminder'::text, 'booking'::text, 'promo'::text, 'social'::text, 'broadcast'::text, 'message'::text, 'sale'::text, 'event_update'::text, 'announcement'::text])))"
expect_value "exactly one notifications_type_check exists" \
  "SELECT count(*) FROM pg_constraint WHERE conname='notifications_type_check';" "1"
expect_value "existing rows survived the constraint swap" "SELECT count(*) FROM public.notifications;" "4"
for t in reminder booking promo social broadcast message sale event_update announcement; do
  expect_ok "type '$t' is accepted" "BEGIN; INSERT INTO public.notifications (type) VALUES ('$t'); ROLLBACK;"
done
for t in event_reminder recruiter_invitation recruiter_invitation_response bogus; do
  expect_error "type '$t' is still rejected" 'violates check constraint "notifications_type_check"' \
    "INSERT INTO public.notifications (type) VALUES ('$t');"
done

expect_ok "organizers send succeeds" "$(send "$ADMIN" organizers)"
expect_value "organizers send reached only the unmuted organizer" \
  "SELECT string_agg(user_id::text, ',') FROM public.notifications WHERE type='announcement';" "$ORG1"
expect_ok "service_providers send succeeds" "$(send "$ADMIN" service_providers)"
expect_value "service_providers send reached the provider" \
  "SELECT count(*) FROM public.notifications WHERE type='announcement' AND user_id='$PROV';" "1"
expect_value "each successful send logged once with its recipient count" \
  "SELECT string_agg((details->>'audience') || '=' || (details->>'recipients'), ',' ORDER BY details->>'audience') FROM public.admin_logs WHERE action='announcement_sent';" \
  "everyone=4,organizers=1,service_providers=1"
expect_error "a non-admin is still refused" "Only admins can send announcements" "$(send "$PLAIN" organizers)"

expect_value "send_event_reminders() no longer exists" \
  "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname='send_event_reminders';" "0"
expect_value "admin_send_announcement grants unchanged (authenticated + project_admin, not anon)" \
  "SELECT has_function_privilege('authenticated', 'public.admin_send_announcement(text,text,text)', 'EXECUTE') || ',' || has_function_privilege('project_admin', 'public.admin_send_announcement(text,text,text)', 'EXECUTE') || ',' || has_function_privilege('anon', 'public.admin_send_announcement(text,text,text)', 'EXECUTE');" \
  "true,true,false"

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED" >&2; exit 1; fi
