#!/usr/bin/env bash
# Real-execution verification for migration 0222 (stored announcements:
# draft -> edit -> publish, delivered through the existing notifications
# feed and push pipeline).
#
# Builds on schema-vents-earn.sql (production's notifications_type_check
# verbatim), applies the real 0189, 0191, 0198 and 0222, swaps the
# check_rate_limit stub for production's real definition (0004), then
# proves: authorization (non-admins and sub-admins refused, nothing
# written), RLS/grants (clients cannot read or write the table directly),
# validation, draft edit/delete, publish targeting identical to 0191
# (everyone / organizers / service_providers, mutes honoured), push_data
# linking every delivered row back to its announcement, immutability after
# publish, the double-publish guard, all-or-nothing publish, audit logging
# and the rate limit.
#
# Local PostgreSQL only (`sudo -u postgres psql`, auth.uid() backed by the
# `test.uid` GUC). Never touches the real Supabase project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_announcements_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

ADMIN="00000000-0000-0000-0000-00000000a001"
SUB="00000000-0000-0000-0000-00000000a006"     # sub-admin: refused (Super Admin tier only)
ORG1="00000000-0000-0000-0000-00000000a002"
ORG2="00000000-0000-0000-0000-00000000a003"    # mutes organizers
PROV="00000000-0000-0000-0000-00000000a004"
PLAIN="00000000-0000-0000-0000-00000000a005"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
ERR=$(mktemp); OUT=$(mktemp); trap 'rm -f "$ERR" "$OUT"' EXIT
expect_error() {
  local label="$1" expected="$2" sql="$3"
  if "${PSQL[@]}" -c "$sql" >"$OUT" 2>"$ERR"; then fail "$label (expected an exception, call succeeded)"; return; fi
  if grep -q "$expected" "$ERR"; then pass "$label"; else fail "$label (wrong error text)"; cat "$ERR" >&2; fi
}
expect_ok() {
  local label="$1" sql="$2"
  if "${PSQL[@]}" -c "$sql" >"$OUT" 2>"$ERR"; then pass "$label"; else fail "$label"; cat "$ERR" >&2; fi
}
expect_value() {
  local label="$1" sql="$2" expected="$3" actual
  actual=$("${PSQL[@]}" -tA -c "$sql" 2>&1 | tail -n1)
  if [ "$actual" = "$expected" ]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
as() { echo "SET test.uid='$1';"; }
save() { # save <caller> <id|NULL> <audience> <title> <body>  -> prints id
  "${PSQL[@]}" -tA -c "$(as "$1") SELECT public.admin_save_announcement_draft($2, '$3', '$4', '$5');" | tail -n1
}

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null

# is_root()/is_super_admin()/is_admin_or_root(): production's definitions
# VERBATIM (0004_functions.sql) -- not a simplified stub. They matter: with
# no auth.uid(), is_root() is NULL, so is_admin_or_root() can be NULL rather
# than false (release audit H2). check_rate_limit(): production's body (0004).
# service_role mirrors Supabase's default EXECUTE grant on new functions.
"${PSQL[@]}" -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='project_admin') THEN CREATE ROLE project_admin; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO project_admin, service_role;
CREATE OR REPLACE FUNCTION public.is_root()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid;
$function$;
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT public.is_root()
     OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin');
$function$;
CREATE OR REPLACE FUNCTION public.is_admin_or_root()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT public.is_super_admin();
$function$;
GRANT EXECUTE ON FUNCTION public.is_admin_or_root() TO authenticated;
CREATE TABLE public.admin_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid, action text NOT NULL,
  target_user_id uuid, details jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE public.rate_limits (key text NOT NULL, window_start bigint NOT NULL, count integer NOT NULL DEFAULT 1, PRIMARY KEY (key, window_start));
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
  IF v_count > p_max_attempts THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0429';
  END IF;
END;
$function$;
-- 0198 drops this 0004 function; same-signature stand-in.
CREATE FUNCTION public.send_event_reminders() RETURNS void LANGUAGE sql AS $$ SELECT NULL $$;
SQL

"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, is_service_provider) VALUES
  ('$ADMIN', 'admin', false, false), ('$SUB', 'sub-admin', false, false),
  ('$ORG1', 'user', true, false), ('$ORG2', 'user', true, false),
  ('$PROV', 'user', false, true), ('$PLAIN', 'user', false, false);
SQL
"${PSQL[@]}" -q -f "$MIG/0189_announcement_groups_schema_foundation.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0191_admin_send_announcement.sql" >/dev/null
"${PSQL[@]}" -q -1 -f "$MIG/0198_notifications_type_check_allow_announcement.sql" >/dev/null
"${PSQL[@]}" -q -c "INSERT INTO public.announcement_mutes (user_id, group_id) SELECT '$ORG2', id FROM public.announcement_groups WHERE key='organizers';"
"${PSQL[@]}" -q -1 -f "$MIG/0222_announcements_drafts_publish.sql" >/dev/null
# Supabase's default privileges give service_role EXECUTE on every new
# function; 0222 revokes only PUBLIC/anon/authenticated, so mirror that here.
"${PSQL[@]}" -q -c "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;"
echo "== 0222 applied in one transaction =="
for fn in is_root is_super_admin is_admin_or_root; do
  live=$("${PSQL[@]}" -tA -c "SELECT md5(regexp_replace(prosrc, '\s+', ' ', 'g')) FROM pg_proc WHERE proname='$fn' AND pronamespace='public'::regnamespace")
  repo=$(python3 - "$MIG/0004_functions.sql" "$fn" <<'PY'
import re,sys,hashlib
t=open(sys.argv[1]).read(); m=re.search(r'CREATE OR REPLACE FUNCTION public\.'+sys.argv[2]+r'\(\)[\s\S]*?AS \$function\$([\s\S]*?)\$function\$', t)
print(hashlib.md5(re.sub(r'\s+',' ',m.group(1)).encode()).hexdigest())
PY
)
  if [ "$live" = "$repo" ]; then pass "harness $fn() is production's 0004 body verbatim"; else fail "harness $fn() differs from 0004"; fi
done

echo "== Authorization =="
for who in "$PLAIN:plain user" "$SUB:sub-admin" "$ORG1:organizer"; do
  uid="${who%%:*}"; label="${who#*:}"
  expect_error "$label cannot create a draft" "Only admins can manage announcements" \
    "$(as "$uid") SELECT public.admin_save_announcement_draft(NULL, 'everyone', 'T', 'B');"
done
expect_value "refused calls wrote nothing" "SELECT count(*) FROM public.announcements;" "0"

echo "== Fails closed with no auth.uid() (release audit H2) =="
expect_value "is_admin_or_root() with no uid is NULL (the case COALESCE guards)" "SELECT coalesce(public.is_admin_or_root()::text, 'NULL');" "NULL"
for r in project_admin service_role postgres; do
  set_role=""; [ "$r" != postgres ] && set_role="SET ROLE $r;"
  expect_error "$r with no uid cannot create a draft" "Only admins can manage announcements" "$set_role SELECT public.admin_save_announcement_draft(NULL, 'everyone', 'T', 'B');"
done
expect_value "no-uid attempts wrote nothing" "SELECT count(*) FROM public.announcements;" "0"

echo "== Validation =="
expect_error "invalid audience rejected" "Invalid audience" "$(as "$ADMIN") SELECT public.admin_save_announcement_draft(NULL, 'admins', 'T', 'B');"
expect_error "NULL audience rejected" "Invalid audience" "$(as "$ADMIN") SELECT public.admin_save_announcement_draft(NULL, NULL, 'T', 'B');"
expect_error "blank title rejected" "Title is required" "$(as "$ADMIN") SELECT public.admin_save_announcement_draft(NULL, 'everyone', '   ', 'B');"
expect_error "blank body rejected" "Message is required" "$(as "$ADMIN") SELECT public.admin_save_announcement_draft(NULL, 'everyone', 'T', '  ');"
expect_error "81-char title rejected" "80 characters" "$(as "$ADMIN") SELECT public.admin_save_announcement_draft(NULL, 'everyone', repeat('x',81), 'B');"
expect_error "501-char body rejected" "500 characters" "$(as "$ADMIN") SELECT public.admin_save_announcement_draft(NULL, 'everyone', 'T', repeat('x',501));"

echo "== Drafts: create, edit, delete; nothing is delivered =="
D1=$(save "$ADMIN" NULL organizers "  Draft one  " "First body")
expect_value "draft created, trimmed, status draft" "SELECT title || '|' || status || '|' || audience FROM public.announcements WHERE id='$D1';" "Draft one|draft|organizers"
expect_value "saving a draft sends no notifications" "SELECT count(*) FROM public.notifications;" "0"
D1B=$(save "$ADMIN" "'$D1'" service_providers "Edited title" "Edited body")
expect_value "editing returns the same id" "SELECT '$D1B' = '$D1';" "t"
expect_value "edit replaced title/body/audience" "SELECT title || '|' || body || '|' || audience FROM public.announcements WHERE id='$D1';" "Edited title|Edited body|service_providers"
expect_error "editing an unknown id fails" "Announcement not found" "$(as "$ADMIN") SELECT public.admin_save_announcement_draft(gen_random_uuid(), 'everyone', 'T', 'B');"
D2=$(save "$ADMIN" NULL everyone "Throwaway" "Delete me")
expect_error "non-admin cannot delete a draft" "Only admins" "$(as "$PLAIN") SELECT public.admin_delete_announcement_draft('$D2');"
expect_ok "admin deletes a draft" "$(as "$ADMIN") SELECT public.admin_delete_announcement_draft('$D2');"
expect_value "deleted draft is gone" "SELECT count(*) FROM public.announcements WHERE id='$D2';" "0"

echo "== Client access to the table (RLS + grants) =="
expect_value "admin (authenticated) can read drafts" "$(as "$ADMIN") SET ROLE authenticated; SELECT count(*) FROM public.announcements;" "1"
expect_value "plain user sees no drafts" "$(as "$PLAIN") SET ROLE authenticated; SELECT count(*) FROM public.announcements;" "0"
expect_value "sub-admin sees no drafts" "$(as "$SUB") SET ROLE authenticated; SELECT count(*) FROM public.announcements;" "0"
expect_error "admin cannot INSERT directly" "permission denied" "$(as "$ADMIN") SET ROLE authenticated; INSERT INTO public.announcements (title, body, audience) VALUES ('t','b','everyone');"
expect_error "admin cannot UPDATE directly (e.g. fake published)" "permission denied" "$(as "$ADMIN") SET ROLE authenticated; UPDATE public.announcements SET status='published';"
expect_error "anon cannot read" "permission denied" "SET ROLE anon; SELECT count(*) FROM public.announcements;"
expect_value "anon cannot execute publish" "SELECT has_function_privilege('anon','public.admin_publish_announcement(uuid)','EXECUTE');" "f"
expect_value "authenticated can execute publish (body gates on is_admin_or_root)" "SELECT has_function_privilege('authenticated','public.admin_publish_announcement(uuid)','EXECUTE');" "t"
expect_error "non-admin publish through the RPC is refused" "Only admins can publish" "$(as "$PLAIN") SET ROLE authenticated; SELECT public.admin_publish_announcement('$D1');"
for r in project_admin service_role postgres; do
  set_role=""; [ "$r" != postgres ] && set_role="SET ROLE $r;"
  expect_error "$r with no uid cannot publish" "Only admins can publish" "$set_role SELECT public.admin_publish_announcement('$D1');"
  expect_error "$r with no uid cannot delete a draft" "Only admins can manage announcements" "$set_role SELECT public.admin_delete_announcement_draft('$D1');"
done
expect_value "refused publish left it a draft and sent nothing" "SELECT status || '|' || (SELECT count(*) FROM public.notifications) FROM public.announcements WHERE id='$D1';" "draft|0"

echo "== Publish: targeting identical to 0191 =="
expect_value "service_providers publish -> 1 recipient" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D1')->>'recipients';" "1"
expect_value "delivered only to the provider, type announcement, unread" \
  "SELECT string_agg(user_id::text || '/' || type || '/' || read, ',') FROM public.notifications;" "$PROV/announcement/false"
expect_value "delivered row carries push_data linking to the announcement, plus screen for older builds" \
  "SELECT push_data->>'type' || '|' || (push_data->>'announcementId' = '$D1') || '|' || (push_data->>'screen') FROM public.notifications;" "announcement|true|notifications"
expect_value "announcement marked published with recipients and time" \
  "SELECT status || '|' || recipients || '|' || (published_at IS NOT NULL) || '|' || (published_by = '$ADMIN') FROM public.announcements WHERE id='$D1';" "published|1|true|true"
expect_error "published announcement cannot be edited" "cannot be edited" "$(as "$ADMIN") SELECT public.admin_save_announcement_draft('$D1', 'everyone', 'Sneaky', 'Rewrite');"
expect_error "published announcement cannot be deleted" "cannot be deleted" "$(as "$ADMIN") SELECT public.admin_delete_announcement_draft('$D1');"
expect_error "publishing twice is refused" "already published" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D1');"
expect_value "second publish sent nothing more" "SELECT count(*) FROM public.notifications;" "1"

D3=$(save "$ADMIN" NULL organizers "Org news" "For organizers")
expect_value "organizers publish -> only the unmuted organizer" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D3')->>'recipients';" "1"
expect_value "muted organizer did not receive it" \
  "SELECT string_agg(user_id::text, ',') FROM public.notifications WHERE push_data->>'announcementId'='$D3';" "$ORG1"
D4=$(save "$ADMIN" NULL everyone "Hello all" "For everyone")
expect_value "everyone publish -> every non-admin user (5), mutes do not apply" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D4')->>'recipients';" "5"
expect_value "everyone rows use type broadcast (same as 0191)" \
  "SELECT string_agg(DISTINCT type, ',') FROM public.notifications WHERE push_data->>'announcementId'='$D4';" "broadcast"
expect_value "admin did not receive the everyone announcement" \
  "SELECT count(*) FROM public.notifications WHERE user_id='$ADMIN';" "0"
# Push queueing is not checked here: the harness notifications table has no
# push_sent column. In production push_sent is NOT NULL DEFAULT false (0002)
# and 0222's INSERT does not set it, so every delivered row is queued for push.

echo "== Recipients read their own copies only (existing notifications RLS untouched) =="
expect_value "each recipient's own row is readable via the existing feed" \
  "SELECT count(*) FROM public.notifications WHERE user_id='$PROV';" "2"

echo "== Audit log =="
expect_value "one announcement_published log per publish" \
  "SELECT string_agg((details->>'audience') || '=' || (details->>'recipients'), ',' ORDER BY details->>'audience') FROM public.admin_logs WHERE action='announcement_published';" \
  "everyone=5,organizers=1,service_providers=1"

echo "== All-or-nothing publish =="
D5=$(save "$ADMIN" NULL everyone "Atomic" "Rollback test")
"${PSQL[@]}" -q -c "CREATE FUNCTION public.boom() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN IF NEW.title = 'Atomic' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END \$\$; CREATE TRIGGER t_boom BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.boom();"
expect_error "publish fails mid-fan-out" "boom" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D5');"
expect_value "failed publish left the draft unpublished, no rows, no log" \
  "SELECT (SELECT status FROM public.announcements WHERE id='$D5') || '|' || (SELECT count(*) FROM public.notifications WHERE title='Atomic') || '|' || (SELECT count(*) FROM public.admin_logs WHERE details->>'title'='Atomic');" "draft|0|0"
"${PSQL[@]}" -q -c "DROP TRIGGER t_boom ON public.notifications; DROP FUNCTION public.boom();"

echo "== Concurrent publish of the same draft sends once =="
D6=$(save "$ADMIN" NULL service_providers "Race" "Only once")
( "${PSQL[@]}" -c "$(as "$ADMIN") BEGIN; SELECT public.admin_publish_announcement('$D6'); SELECT pg_sleep(1); COMMIT;" >/dev/null 2>&1 & )
sleep 0.3
"${PSQL[@]}" -c "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D6');" >/dev/null 2>"$ERR" || true
sleep 1.2
if grep -q "already published" "$ERR"; then pass "second concurrent publish waited on the lock and was refused"; else fail "second concurrent publish not refused"; cat "$ERR" >&2; fi
expect_value "race delivered exactly one copy" "SELECT count(*) FROM public.notifications WHERE title='Race';" "1"

echo "== Rate limit (production check_rate_limit: 10 per 5 min per admin) =="
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits;"
for i in $(seq 1 10); do id=$(save "$ADMIN" NULL service_providers "RL $i" "b"); "${PSQL[@]}" -q -c "$(as "$ADMIN") SELECT public.admin_publish_announcement('$id');" >/dev/null; done
RL=$(save "$ADMIN" NULL service_providers "RL 11" "b")
expect_error "11th publish in the window is rate limited" "rate_limited" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$RL');"
expect_value "rate-limited draft stays a draft" "SELECT status FROM public.announcements WHERE id='$RL';" "draft"

echo "== 0191 still works alongside (installed app builds) =="
expect_ok "admin_send_announcement unchanged and callable" "$(as "$ADMIN") SELECT public.admin_send_announcement('organizers', 'Legacy', 'Still works');"

echo "== Rollback: supabase/rollback/undo_0222.sql =="
UNDO="$REPO_ROOT/supabase/rollback/undo_0222.sql"
NOTIF_BEFORE=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM public.notifications;")
expect_error "undo refused without confirmation" "undo_0222 refused: set vents.rollback_confirm" "$(cat "$UNDO")"
expect_error "undo refused while drafts exist unless discarding is confirmed" "unpublished draft" "SET vents.rollback_confirm = 'undo-0222'; $(cat "$UNDO")"
expect_value "refused undos changed nothing" "SELECT (to_regclass('public.announcements') IS NOT NULL) || '|' || (SELECT count(*) FROM pg_proc WHERE proname LIKE 'admin_%announcement%' AND pronamespace='public'::regnamespace);" "true|4"
expect_ok "undo runs in one transaction with both confirmations" "BEGIN; SET LOCAL vents.rollback_confirm = 'undo-0222'; SET LOCAL vents.rollback_discard_drafts = 'yes'; $(cat "$UNDO") COMMIT;"
expect_value "only 0222's objects are gone; 0191's admin_send_announcement remains" \
  "SELECT (to_regclass('public.announcements') IS NULL) || '|' || string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE proname LIKE 'admin_%announcement%' AND pronamespace='public'::regnamespace;" "true|admin_send_announcement"
expect_value "delivered notifications survive the undo" "SELECT count(*) FROM public.notifications;" "$NOTIF_BEFORE"
expect_value "0189 announcement tables untouched" "SELECT count(*) FROM public.announcement_groups;" "2"
expect_ok "legacy send still works after undo" "$(as "$ADMIN") SELECT public.admin_send_announcement('everyone', 'After undo', 'Still works');"
expect_ok "undo is re-runnable (IF EXISTS)" "BEGIN; SET LOCAL vents.rollback_confirm = 'undo-0222'; $(cat "$UNDO") COMMIT;"
expect_ok "0222 re-applies cleanly after undo" "$(cat "$MIG/0222_announcements_drafts_publish.sql")"

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED" >&2; exit 1; fi
