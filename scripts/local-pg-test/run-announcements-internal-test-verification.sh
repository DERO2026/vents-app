#!/usr/bin/env bash
# Real-execution verification for migration 0223 (Internal Test
# announcement audience: an explicit, Root-managed allowlist of at most 10
# accounts).
#
# Same base as run-announcements-verification.sh (schema-vents-earn.sql,
# production-verbatim is_root/is_super_admin/is_admin_or_root and
# check_rate_limit from 0004, real 0189/0191/0198/0222), then applies the
# real 0223 and proves: Root-only recipient management (admins, sub-admins,
# users, no-uid callers and anon refused, nothing written), audit logging of
# additions and removals, the 10-recipient cap (on add and on publish), the
# empty-list guard, delivery to designated accounts only (removed, deleted
# and suspended accounts excluded; roles and groups never imply
# membership), the three production audiences unchanged (function bodies
# byte-identical outside the internal_test additions, and same targeting
# results), and the undo script.
#
# Local PostgreSQL only (`sudo -u postgres psql`, auth.uid() backed by the
# `test.uid` GUC). Never touches the real Supabase project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_announcements_internal_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

ROOT="c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832"     # production is_root() uid
ADMIN="00000000-0000-0000-0000-00000000a001"    # Super Admin (role admin), not Root
SUB="00000000-0000-0000-0000-00000000a006"
ORG1="00000000-0000-0000-0000-00000000a002"
ORG2="00000000-0000-0000-0000-00000000a003"     # mutes organizers
PROV="00000000-0000-0000-0000-00000000a004"
PLAIN="00000000-0000-0000-0000-00000000a005"
spare() { printf '00000000-0000-0000-0000-0000000b00%02d' "$1"; }

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

# Production users columns 0223 reads (0002: username text, status text NOT NULL DEFAULT 'active').
"${PSQL[@]}" -q -c "ALTER TABLE public.users ADD COLUMN username text, ADD COLUMN status text NOT NULL DEFAULT 'active';"
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, is_service_provider, username) VALUES
  ('$ROOT', 'admin', false, false, 'root'),
  ('$ADMIN', 'admin', false, false, 'admin2'), ('$SUB', 'sub-admin', false, false, 'sub'),
  ('$ORG1', 'user', true, false, 'org1'), ('$ORG2', 'user', true, false, 'org2'),
  ('$PROV', 'user', false, true, 'prov'), ('$PLAIN', 'user', false, false, 'plain');
-- ten spare plain accounts for the cap tests
INSERT INTO public.users (id, role, username)
  SELECT ('00000000-0000-0000-0000-0000000b00' || lpad(g::text, 2, '0'))::uuid, 'user', 'spare' || g FROM generate_series(1, 11) g;
SQL
"${PSQL[@]}" -q -f "$MIG/0189_announcement_groups_schema_foundation.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0191_admin_send_announcement.sql" >/dev/null
"${PSQL[@]}" -q -1 -f "$MIG/0198_notifications_type_check_allow_announcement.sql" >/dev/null
"${PSQL[@]}" -q -c "INSERT INTO public.announcement_mutes (user_id, group_id) SELECT '$ORG2', id FROM public.announcement_groups WHERE key='organizers';"
"${PSQL[@]}" -q -1 -f "$MIG/0222_announcements_drafts_publish.sql" >/dev/null
# 0222 as it stands in production, captured before 0223 for the byte-identity checks.
P222_PUB=$("${PSQL[@]}" -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='admin_publish_announcement'")
P222_SAVE=$("${PSQL[@]}" -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='admin_save_announcement_draft'")
"${PSQL[@]}" -q -c "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;"
P222_ACL=$("${PSQL[@]}" -tA -c "SELECT string_agg(proname || '=' || proacl::text, ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('admin_publish_announcement','admin_save_announcement_draft')")
"${PSQL[@]}" -q -1 -f "$MIG/0223_announcement_internal_test_audience.sql" >/dev/null
# Supabase's default privileges give service_role EXECUTE on every new
# function; 0222 revokes only PUBLIC/anon/authenticated, so mirror that here.
"${PSQL[@]}" -q -c "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;"
echo "== 0222 then 0223 applied, each in one transaction =="
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


add() { "${PSQL[@]}" -tA -c "$(as "$1") SELECT public.admin_add_announcement_test_recipient('$2');" | tail -n1; }
pub() { "${PSQL[@]}" -tA -c "$(as "$1") SELECT public.admin_publish_announcement('$2')->>'recipients';" | tail -n1; }
rm_() { "${PSQL[@]}" -tA -c "$(as "$1") SELECT public.admin_remove_announcement_test_recipient('$2');" | tail -n1; }

echo "== The three production audiences are unchanged =="
python3 - "$MIG/0222_announcements_drafts_publish.sql" "$MIG/0223_announcement_internal_test_audience.sql" <<'PY' && pass "0223 publish = 0222 publish + only the internal_test guard and branch; save = 0222 + only the allow-list entry" || fail "0223 changed 0222 beyond the internal_test additions"
import re,sys
a=open(sys.argv[1]).read(); b=open(sys.argv[2]).read()
f=lambda s,n: re.search(r'CREATE OR REPLACE FUNCTION public\.'+n+r'\([\s\S]*?\$function\$;\n', s).group(0)
p2,p3=f(a,'admin_publish_announcement'),f(b,'admin_publish_announcement')
g=re.search(r"  -- Internal test \(0223\)[\s\S]*?  END IF;\n\n(?=  -- Same limiter)", p3).group(0)
w=re.search(r"\n    WHEN 'internal_test' THEN[\s\S]*?(?=  END CASE;)", p3).group(0)
assert p3.replace(g,'',1).replace(w,'',1)==p2
s2,s3=f(a,'admin_save_announcement_draft'),f(b,'admin_save_announcement_draft')
assert s3.replace(", 'internal_test')", ")",1)==s2
PY
expect_value "grants on the two re-created functions are unchanged" \
  "SELECT string_agg(proname || '=' || proacl::text, ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('admin_publish_announcement','admin_save_announcement_draft');" "$P222_ACL"
expect_value "admin_delete_announcement_draft not re-created" "SELECT count(*) FROM pg_proc WHERE proname='admin_delete_announcement_draft';" "1"
D=$(save "$ADMIN" NULL service_providers "SP" "b"); expect_value "service_providers -> provider only" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D')->>'recipients';" "1"
D=$(save "$ADMIN" NULL organizers "ORG" "b"); expect_value "organizers -> 1 recipient" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D')->>'recipients';" "1"
expect_value "organizers -> the unmuted organizer only" "SELECT string_agg(user_id::text, ',') FROM public.notifications WHERE title='ORG';" "$ORG1"
D=$(save "$ADMIN" NULL everyone "ALL" "b"); expect_value "everyone -> every non-admin user (sub-admin + 4 users + 11 spares, as 0222)" "SELECT '$(pub "$ADMIN" "$D")';" "16"
expect_value "everyone rows are type broadcast" "SELECT string_agg(DISTINCT type, ',') FROM public.notifications WHERE title='ALL';" "broadcast"
expect_value "root/admin did not receive the everyone announcement" "SELECT count(*) FROM public.notifications WHERE user_id IN ('$ROOT','$ADMIN');" "0"
expect_value "test recipient table untouched by the three audiences" "SELECT count(*) FROM public.announcement_test_recipients;" "0"

echo "== Recipient management is Root only =="
for who in "$ADMIN:super admin (role admin, not Root)" "$SUB:sub-admin" "$ORG1:organizer" "$PLAIN:plain user"; do
  uid="${who%%:*}"; label="${who#*:}"
  expect_error "$label cannot add a recipient" "Only Root can manage internal test recipients" "$(as "$uid") SELECT public.admin_add_announcement_test_recipient('$PLAIN');"
  expect_error "$label cannot remove a recipient" "Only Root can manage internal test recipients" "$(as "$uid") SELECT public.admin_remove_announcement_test_recipient('$PLAIN');"
done
expect_value "is_root() with no uid is NULL (the case COALESCE guards)" "SELECT coalesce(public.is_root()::text, 'NULL');" "NULL"
for r in project_admin service_role postgres; do
  set_role=""; [ "$r" != postgres ] && set_role="SET ROLE $r;"
  expect_error "$r with no uid cannot add" "Only Root can manage" "$set_role SELECT public.admin_add_announcement_test_recipient('$PLAIN');"
  expect_error "$r with no uid cannot remove" "Only Root can manage" "$set_role SELECT public.admin_remove_announcement_test_recipient('$PLAIN');"
  expect_error "$r with no uid cannot list" "Only admins can view internal test recipients" "$set_role SELECT * FROM public.admin_list_announcement_test_recipients();"
done
for fn in "admin_add_announcement_test_recipient(uuid)" "admin_remove_announcement_test_recipient(uuid)" "admin_list_announcement_test_recipients()"; do
  expect_value "anon has no EXECUTE on $fn" "SELECT has_function_privilege('anon','public.$fn','EXECUTE');" "f"
done
expect_error "anon cannot call add through the API role" "permission denied" "SET ROLE anon; SELECT public.admin_add_announcement_test_recipient('$PLAIN');"
expect_value "refused calls wrote nothing (table, logs)" "SELECT (SELECT count(*) FROM public.announcement_test_recipients) || '|' || (SELECT count(*) FROM public.admin_logs WHERE action LIKE 'announcement_test_recipient%');" "0|0"

echo "== The allowlist table is closed to clients =="
expect_error "admin (authenticated) cannot read it" "permission denied" "$(as "$ADMIN") SET ROLE authenticated; SELECT count(*) FROM public.announcement_test_recipients;"
expect_error "root (authenticated) cannot write it directly" "permission denied" "$(as "$ROOT") SET ROLE authenticated; INSERT INTO public.announcement_test_recipients (user_id) VALUES ('$PLAIN');"
expect_error "anon cannot read it" "permission denied" "SET ROLE anon; SELECT count(*) FROM public.announcement_test_recipients;"
expect_value "RLS enabled" "SELECT relrowsecurity FROM pg_class WHERE oid='public.announcement_test_recipients'::regclass;" "t"
expect_value "no policies" "SELECT count(*) FROM pg_policies WHERE tablename='announcement_test_recipients';" "0"

echo "== Empty-list safeguard =="
DI=$(save "$ROOT" NULL internal_test "Internal one" "Pipeline test")
expect_value "internal_test draft saved" "SELECT audience || '|' || status FROM public.announcements WHERE id='$DI';" "internal_test|draft"
expect_error "publishing to an empty internal list is refused" "Internal test audience has no recipients" "$(as "$ROOT") SELECT public.admin_publish_announcement('$DI');"
expect_value "refused publish stayed a draft, sent nothing, logged nothing" \
  "SELECT (SELECT status FROM public.announcements WHERE id='$DI') || '|' || (SELECT count(*) FROM public.notifications WHERE title='Internal one') || '|' || (SELECT count(*) FROM public.admin_logs WHERE details->>'title'='Internal one');" "draft|0|0"
expect_value "list is empty" "$(as "$ROOT") SELECT count(*) FROM public.admin_list_announcement_test_recipients();" "0"

echo "== Add / list / remove, with audit logging =="
R=$(add "$ROOT" "$ROOT"); expect_value "root adds root" "SELECT ('$R'::jsonb->>'success') || '|' || ('$R'::jsonb->>'already_active') || '|' || ('$R'::jsonb->>'active_recipients');" "true|false|1"
expect_value "audit: one 'added' entry by root targeting root" \
  "SELECT string_agg(admin_id::text || '>' || target_user_id::text || '>' || (details->>'active_recipients'), ',') FROM public.admin_logs WHERE action='announcement_test_recipient_added';" "$ROOT>$ROOT>1"
R=$(add "$ROOT" "$ROOT"); expect_value "re-add reports already_active" "SELECT '$R'::jsonb->>'already_active';" "true"
expect_value "re-add wrote no extra audit row" "SELECT count(*) FROM public.admin_logs WHERE action='announcement_test_recipient_added';" "1"
expect_value "super admin can list (what a publish would reach)" "$(as "$ADMIN") SELECT string_agg(username, ',') FROM public.admin_list_announcement_test_recipients();" "root"
expect_error "plain user cannot list" "Only admins can view" "$(as "$PLAIN") SELECT * FROM public.admin_list_announcement_test_recipients();"
expect_error "sub-admin cannot list" "Only admins can view" "$(as "$SUB") SELECT * FROM public.admin_list_announcement_test_recipients();"
expect_error "unknown user cannot be added" "User not found or not active" "$(as "$ROOT") SELECT public.admin_add_announcement_test_recipient(gen_random_uuid());"
"${PSQL[@]}" -q -c "UPDATE public.users SET status='suspended' WHERE id='$(spare 11)';"
expect_error "suspended user cannot be added" "User not found or not active" "$(as "$ROOT") SELECT public.admin_add_announcement_test_recipient('$(spare 11)');"
"${PSQL[@]}" -q -c "UPDATE public.users SET status='active', deleted_at=now() WHERE id='$(spare 11)';"
expect_error "deleted user cannot be added" "User not found or not active" "$(as "$ROOT") SELECT public.admin_add_announcement_test_recipient('$(spare 11)');"
expect_error "removing a non-recipient is refused" "Not an active internal test recipient" "$(as "$ROOT") SELECT public.admin_remove_announcement_test_recipient('$PLAIN');"

echo "== Delivery: designated accounts only =="
expect_value "internal_test publish -> 1 recipient (root)" "$(as "$ROOT") SELECT public.admin_publish_announcement('$DI')->>'recipients';" "1"
expect_value "delivered only to root, type announcement, 📢, unread, push_data links back" \
  "SELECT string_agg(user_id::text || '/' || type || '/' || icon || '/' || read || '/' || (push_data->>'type') || '/' || (push_data->>'announcementId' = '$DI') || '/' || (push_data->>'screen'), ',') FROM public.notifications WHERE title='Internal one';" \
  "$ROOT/announcement/📢/false/announcement/true/notifications"
expect_value "published, recipients=1, audit log records audience internal_test" \
  "SELECT (SELECT status || '|' || recipients FROM public.announcements WHERE id='$DI') || '|' || (SELECT details->>'audience' || '=' || (details->>'recipients') FROM public.admin_logs WHERE action='announcement_published' AND details->>'announcement_id'='$DI');" "published|1|internal_test=1"
expect_value "organizers/providers/plain users received nothing from it" "SELECT count(*) FROM public.notifications WHERE title='Internal one' AND user_id <> '$ROOT';" "0"

expect_ok "root adds an organizer explicitly" "$(as "$ROOT") SELECT public.admin_add_announcement_test_recipient('$ORG2');"
DM=$(save "$ROOT" NULL internal_test "Internal two" "b")
expect_value "publish with root + organizer designated -> 2" "SELECT '$(pub "$ROOT" "$DM")';" "2"
expect_value "explicitly added organizer receives it even though they mute 'organizers' (allowlist, not a group)" \
  "SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.notifications WHERE title='Internal two';" "00000000-0000-0000-0000-00000000a003,$ROOT"
expect_value "ORG1 (organizer, not designated) did not receive it" "SELECT count(*) FROM public.notifications WHERE title='Internal two' AND user_id='$ORG1';" "0"

R=$(rm_ "$ROOT" "$ORG2"); expect_value "root removes the organizer -> 1 active left" "SELECT '$R'::jsonb->>'active_recipients';" "1"
expect_value "audit: one 'removed' entry by root targeting the organizer" \
  "SELECT string_agg(admin_id::text || '>' || target_user_id::text || '>' || (details->>'active_recipients'), ',') FROM public.admin_logs WHERE action='announcement_test_recipient_removed';" "$ROOT>$ORG2>1"
expect_value "soft removal keeps who/when" "SELECT active || '|' || (removed_by = '$ROOT') || '|' || (removed_at IS NOT NULL) FROM public.announcement_test_recipients WHERE user_id='$ORG2';" "false|true|true"
D3=$(save "$ROOT" NULL internal_test "Internal three" "b")
expect_value "after removal publish -> 1" "SELECT '$(pub "$ROOT" "$D3")';" "1"
expect_value "removed recipient no longer receives" "SELECT count(*) FROM public.notifications WHERE title='Internal three' AND user_id='$ORG2';" "0"

expect_ok "root adds plain user" "$(as "$ROOT") SELECT public.admin_add_announcement_test_recipient('$PLAIN');"
"${PSQL[@]}" -q -c "UPDATE public.users SET status='suspended' WHERE id='$PLAIN';"
D4=$(save "$ROOT" NULL internal_test "Internal four" "b")
expect_value "a recipient suspended after being added is excluded from delivery" "SELECT '$(pub "$ROOT" "$D4")';" "1"
expect_value "... and from the list the panel shows" "$(as "$ROOT") SELECT string_agg(username, ',') FROM public.admin_list_announcement_test_recipients();" "root"
"${PSQL[@]}" -q -c "UPDATE public.users SET status='active', deleted_at=now() WHERE id='$PLAIN';"
D5=$(save "$ROOT" NULL internal_test "Internal five" "b")
expect_value "a recipient deleted after being added is excluded" "SELECT '$(pub "$ROOT" "$D5")';" "1"
expect_value "... nothing delivered to them" "SELECT count(*) FROM public.notifications WHERE title='Internal five' AND user_id='$PLAIN';" "0"
"${PSQL[@]}" -q -c "UPDATE public.users SET deleted_at=NULL WHERE id='$PLAIN';"
expect_ok "root removes plain user" "$(as "$ROOT") SELECT public.admin_remove_announcement_test_recipient('$PLAIN');"

echo "== 10-recipient cap =="
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits;"
for i in $(seq 1 9); do add "$ROOT" "$(spare "$i")" >/dev/null; done
expect_value "10 active (root + 9)" "SELECT count(*) FROM public.announcement_test_recipients WHERE active;" "10"
expect_error "11th recipient refused" "limited to 10 recipients" "$(as "$ROOT") SELECT public.admin_add_announcement_test_recipient('$(spare 10)');"
expect_error "re-activating a removed recipient also counts against the cap" "limited to 10 recipients" "$(as "$ROOT") SELECT public.admin_add_announcement_test_recipient('$ORG2');"
expect_value "re-adding an already-active one at the cap is still a no-op success" "SELECT '$(add "$ROOT" "$(spare 1)")'::jsonb->>'already_active';" "true"
expect_value "refused adds wrote no row and no log (spare10 never added; ORG2's only 'added' log is the earlier one)" "SELECT (SELECT count(*) FROM public.announcement_test_recipients WHERE active) || '|' || (SELECT count(*) FROM public.announcement_test_recipients WHERE user_id='$(spare 10)') || '|' || (SELECT count(*) FROM public.admin_logs WHERE action='announcement_test_recipient_added' AND target_user_id IN ('$(spare 10)','$ORG2'));" "10|0|1"
D10=$(save "$ROOT" NULL internal_test "Internal ten" "b")
expect_value "publish at exactly 10 delivers 10" "$(as "$ROOT") SELECT public.admin_publish_announcement('$D10')->>'recipients';" "10"
expect_ok "after a removal a new one fits" "$(as "$ROOT") SELECT public.admin_remove_announcement_test_recipient('$(spare 9)'); SELECT public.admin_add_announcement_test_recipient('$(spare 10)');"
# Defence in depth: even if the table were over-filled outside the functions
# (e.g. a manual SQL Editor insert), publish refuses rather than over-delivering.
"${PSQL[@]}" -q -c "INSERT INTO public.announcement_test_recipients (user_id, added_by) VALUES ('$(spare 9)', '$ROOT') ON CONFLICT (user_id) DO UPDATE SET active=true, removed_at=NULL, removed_by=NULL;"
D11=$(save "$ROOT" NULL internal_test "Internal eleven" "b")
expect_error "publish refuses an over-filled list (11)" "exceeds the 10-recipient limit" "$(as "$ROOT") SELECT public.admin_publish_announcement('$D11');"
expect_value "over-limit publish sent nothing and stayed a draft" "SELECT (SELECT status FROM public.announcements WHERE id='$D11') || '|' || (SELECT count(*) FROM public.notifications WHERE title='Internal eleven');" "draft|0"
"${PSQL[@]}" -q -c "UPDATE public.announcement_test_recipients SET active=false, removed_at=now() WHERE user_id='$(spare 9)';"

echo "== Concurrent adds cannot exceed the cap =="
"${PSQL[@]}" -q -c "UPDATE public.announcement_test_recipients SET active=false, removed_at=now() WHERE user_id='$(spare 8)';"
expect_value "9 active before the race" "SELECT count(*) FROM public.announcement_test_recipients WHERE active;" "9"
( "${PSQL[@]}" -c "$(as "$ROOT") BEGIN; SELECT public.admin_add_announcement_test_recipient('$(spare 8)'); SELECT pg_sleep(1); COMMIT;" >/dev/null 2>&1 & )
sleep 0.3
"${PSQL[@]}" -c "$(as "$ROOT") SELECT public.admin_add_announcement_test_recipient('$ORG2');" >/dev/null 2>"$ERR" || true
sleep 1.2
if grep -q "limited to 10 recipients" "$ERR"; then pass "second concurrent add waited on the advisory lock and was refused"; else fail "concurrent add not serialized"; cat "$ERR" >&2; fi
expect_value "exactly 10 active after the race" "SELECT count(*) FROM public.announcement_test_recipients WHERE active;" "10"

echo "== Non-root Super Admin may publish to internal_test (same tier as every audience) but not change who is on it =="
DA=$(save "$ADMIN" NULL internal_test "Admin internal" "b")
expect_value "admin publish reaches only the 10 designated accounts" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$DA')->>'recipients';" "10"
expect_value "none of them is outside the allowlist" "SELECT count(*) FROM public.notifications n WHERE n.title='Admin internal' AND NOT EXISTS (SELECT 1 FROM public.announcement_test_recipients r WHERE r.user_id=n.user_id AND r.active);" "0"

echo "== Validation still applies =="
expect_error "unknown audience still rejected" "Invalid audience" "$(as "$ROOT") SELECT public.admin_save_announcement_draft(NULL, 'internal', 'T', 'B');"
expect_error "direct CHECK still rejects unknown audience" "announcements_audience_check" "INSERT INTO public.announcements (title, body, audience) VALUES ('t','b','admins');"

echo "== Rollback: supabase/rollback/undo_0223.sql =="
UNDO="$REPO_ROOT/supabase/rollback/undo_0223.sql"
NOTIF_BEFORE=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM public.notifications;")
LOGS_BEFORE=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM public.admin_logs;")
NON_IT=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM public.announcements WHERE audience <> 'internal_test';")
expect_error "undo refused without confirmation" "undo_0223 refused: set vents.rollback_confirm" "$(cat "$UNDO")"
expect_error "undo refused while internal_test announcements exist" "internal_test announcement" "SET vents.rollback_confirm = 'undo-0223'; $(cat "$UNDO")"
expect_value "refused undos changed nothing" "SELECT (to_regclass('public.announcement_test_recipients') IS NOT NULL) || '|' || (SELECT count(*) FROM public.announcements WHERE audience='internal_test' AND title='Admin internal');" "true|1"
expect_ok "undo runs in one transaction with both confirmations" "BEGIN; SET LOCAL vents.rollback_confirm = 'undo-0223'; SET LOCAL vents.rollback_discard_internal_test = 'yes'; $(cat "$UNDO") COMMIT;"
expect_value "allowlist table and the three recipient functions are gone" \
  "SELECT (to_regclass('public.announcement_test_recipients') IS NULL) || '|' || (SELECT count(*) FROM pg_proc WHERE proname LIKE '%announcement_test_recipient%');" "true|0"
expect_value "publish and save bodies are byte-identical to 0222 again" \
  "SELECT (SELECT md5(prosrc) FROM pg_proc WHERE proname='admin_publish_announcement') = '$P222_PUB' AND (SELECT md5(prosrc) FROM pg_proc WHERE proname='admin_save_announcement_draft') = '$P222_SAVE';" "t"
expect_value "grants are 0222's" "SELECT string_agg(proname || '=' || proacl::text, ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('admin_publish_announcement','admin_save_announcement_draft');" "$P222_ACL"
expect_value "0222's audience CHECK restored" "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='announcements_audience_check';" "CHECK ((audience = ANY (ARRAY['everyone'::text, 'organizers'::text, 'service_providers'::text])))"
expect_value "other announcements, delivered notifications and audit logs survive" \
  "SELECT (SELECT count(*) FROM public.announcements) || '|' || (SELECT count(*) FROM public.notifications) || '|' || (SELECT count(*) FROM public.admin_logs);" "$NON_IT|$NOTIF_BEFORE|$LOGS_BEFORE"
expect_error "internal_test is rejected again after undo" "Invalid audience" "$(as "$ROOT") SELECT public.admin_save_announcement_draft(NULL, 'internal_test', 'T', 'B');"
D=$(save "$ADMIN" NULL service_providers "After undo" "b"); expect_value "0222 publish works after undo" "$(as "$ADMIN") SELECT public.admin_publish_announcement('$D')->>'recipients';" "1"
expect_ok "undo is re-runnable" "BEGIN; SET LOCAL vents.rollback_confirm = 'undo-0223'; $(cat "$UNDO") COMMIT;"
expect_ok "0223 re-applies cleanly after undo" "BEGIN; $(cat "$MIG/0223_announcement_internal_test_audience.sql") COMMIT;"

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED" >&2; exit 1; fi
