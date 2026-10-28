#!/usr/bin/env bash
# Real-execution verification for migration 0199 (private, authorized
# Realtime for private Chats and per-user activity).
#
# Reproduces the leak against the 0004 trigger definitions (identical to
# production's live pg_get_functiondef output, checked 2026-10-28): a new DM
# is broadcast with its body on the PUBLIC topic 'user:<recipient>'. Then
# applies 0199 and proves, connected as the real non-superuser
# `authenticated` / `anon` roles:
#   - DM and notification broadcasts are private and the DM payload has no body
#   - 'user:<uid>' can be received only by that uid, and nobody can send to it
#   - 'dm:<a>:<b>' can be received and sent only by its two participants,
#     in either id order, and by neither while either has blocked the other
#   - malformed topics, other users, anon and presence are all refused
#   - normal messaging still works (insert, recipient reads the row)
#
# How Realtime authorizes a private channel join: inside a transaction it
# sets the caller's role and JWT claims plus `realtime.topic`, then checks
# whether the caller can SELECT a broadcast row of that topic (receive) and
# INSERT one (send) on realtime.messages. This script performs exactly those
# two checks; `auth.uid()` is backed by the `test.uid` GUC as in the other
# local-pg-test scripts. Never touches the real Supabase project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
M0199="$REPO_ROOT/supabase/migrations/0199_private_realtime_user_and_dm_topics.sql"
DB_NAME="vents_local_pg_private_realtime_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME")

A="00000000-0000-0000-0000-00000000aa01"   # sender
B="00000000-0000-0000-0000-00000000bb02"   # recipient
C="00000000-0000-0000-0000-00000000cc03"   # stranger
DM_AB="dm:$A:$B"
DM_BA="dm:$B:$A"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
expect_value() {
  local label="$1" sql="$2" expected="$3" got
  got="$("${PSQL[@]}" -tA -c "$sql" 2>&1 | tail -1)"
  if [[ "$got" == "$expected" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$got')"; fi
}

# can_receive <role> <uid-or-empty> <topic> [extension] -> prints true/false
can_receive() {
  local role="$1" uid="$2" topic="$3" ext="${4:-broadcast}"
  "${PSQL[@]}" -tA <<SQL | tail -1
BEGIN;
INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES ('$topic', '$ext', 'probe', '{}', true);
SELECT set_config('test.uid', '$uid', true), set_config('realtime.topic', '$topic', true);
SET LOCAL ROLE $role;
SELECT CASE WHEN count(*) > 0 THEN 'true' ELSE 'false' END FROM realtime.messages WHERE topic = '$topic' AND extension = '$ext';
ROLLBACK;
SQL
}
# can_send <role> <uid-or-empty> <topic> -> prints true/false
can_send() {
  local role="$1" uid="$2" topic="$3"
  if "${PSQL[@]}" >/dev/null 2>&1 <<SQL
BEGIN;
SELECT set_config('test.uid', '$uid', true), set_config('realtime.topic', '$topic', true);
SET LOCAL ROLE $role;
INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES ('$topic', 'broadcast', 'typing', '{}', true);
ROLLBACK;
SQL
  then echo true; else echo false; fi
}
check() {  # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected $3, got $2)"; fi
}

echo "== (Re)creating throwaway database '$DB_NAME' =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB_NAME;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB_NAME;"

echo "== Base schema: auth, roles, users, blocked_users, direct_messages, notifications, realtime =="
"${PSQL[@]}" <<SQL
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
\$\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$\$;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END \$\$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;

CREATE TABLE public.users (id uuid PRIMARY KEY);
INSERT INTO public.users VALUES ('$A'), ('$B'), ('$C');

-- blocked_users and its live RLS (a user sees only rows where they are the blocker).
CREATE TABLE public.blocked_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), blocker_id uuid NOT NULL, blocked_id uuid NOT NULL, created_at timestamptz DEFAULT now(), UNIQUE (blocker_id, blocked_id));
ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY blocked_users_own_select ON public.blocked_users FOR SELECT TO public USING (auth.uid() = blocker_id);
GRANT SELECT ON public.blocked_users TO authenticated;

CREATE TABLE public.direct_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id uuid NOT NULL, recipient_id uuid NOT NULL, body text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.direct_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY dm_select ON public.direct_messages FOR SELECT TO authenticated USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
GRANT SELECT ON public.direct_messages TO authenticated;

CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.vc_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, amount integer NOT NULL, type text NOT NULL);

-- realtime schema: realtime.messages columns, RLS (enabled, no policies) and
-- anon/authenticated grants exactly as live; realtime.send / realtime.topic
-- verbatim from live pg_get_functiondef.
CREATE SCHEMA realtime;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated;
CREATE TABLE realtime.messages (
  topic text NOT NULL, extension text NOT NULL, payload jsonb, event text, private boolean DEFAULT false,
  updated_at timestamp NOT NULL DEFAULT now(), inserted_at timestamp NOT NULL DEFAULT now(),
  id uuid NOT NULL DEFAULT gen_random_uuid(), binary_payload bytea, skip_broadcast boolean
);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT INSERT, SELECT, UPDATE ON realtime.messages TO anon, authenticated;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS
\$\$ select nullif(current_setting('realtime.topic', true), '')::text; \$\$;
GRANT EXECUTE ON FUNCTION realtime.topic() TO anon, authenticated;
CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
 RETURNS void LANGUAGE plpgsql AS \$function\$
DECLARE
  generated_id uuid;
  final_payload jsonb;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();
    IF payload ? 'id' THEN
      final_payload := payload;
    ELSE
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    END IF;
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);
    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
\$function\$;
SQL

echo "== Pre-0199 trigger definitions (0004_functions.sql / live) =="
"${PSQL[@]}" <<'SQL'
CREATE FUNCTION public.notify_new_direct_message() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('id', NEW.id, 'sender_id', NEW.sender_id, 'recipient_id', NEW.recipient_id, 'body', NEW.body, 'created_at', NEW.created_at),
    'new_message', 'user:' || NEW.recipient_id::text, false);
  RETURN NEW;
END;
$function$;
CREATE FUNCTION public.notify_new_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('id', NEW.id, 'user_id', NEW.user_id, 'type', NEW.type, 'created_at', NEW.created_at),
    'new_notification', 'user:' || NEW.user_id::text, false);
  RETURN NEW;
END;
$function$;
CREATE FUNCTION public.notify_vc_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('user_id', NEW.user_id, 'amount', NEW.amount, 'type', NEW.type),
    'vc_updated', 'user:' || NEW.user_id::text, false);
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_realtime_vc AFTER INSERT ON public.vc_transactions FOR EACH ROW EXECUTE FUNCTION public.notify_vc_update();
CREATE TRIGGER trg_realtime_new_dm AFTER INSERT ON public.direct_messages FOR EACH ROW EXECUTE FUNCTION public.notify_new_direct_message();
CREATE TRIGGER trg_realtime_new_notification AFTER INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.notify_new_notification();
SQL

echo "== Reproduce the leak (before 0199) =="
"${PSQL[@]}" -c "INSERT INTO public.direct_messages (sender_id, recipient_id, body) VALUES ('$A', '$B', 'secret before');"
expect_value "pre-0199: DM broadcast is PUBLIC (private=false)" \
  "SELECT private FROM realtime.messages WHERE event='new_message' ORDER BY inserted_at DESC LIMIT 1" "f"
"${PSQL[@]}" -c "INSERT INTO public.vc_transactions (user_id, amount, type) VALUES ('$B', 50, 'earn');"
expect_value "pre-0199: VC broadcast is PUBLIC (private=false)" \
  "SELECT private FROM realtime.messages WHERE event='vc_updated'" "f"
expect_value "pre-0199: DM broadcast payload carries the message body" \
  "SELECT payload->>'body' FROM realtime.messages WHERE event='new_message' ORDER BY inserted_at DESC LIMIT 1" "secret before"
"${PSQL[@]}" -c "DELETE FROM realtime.messages;"

echo "== Apply 0199 (twice: must be re-runnable) =="
"${PSQL[@]}" -f "$M0199"
"${PSQL[@]}" -f "$M0199"
pass "0199 applies cleanly and re-applies cleanly"

echo "== Broadcast payloads after 0199 =="
"${PSQL[@]}" -c "INSERT INTO public.direct_messages (sender_id, recipient_id, body) VALUES ('$A', '$B', 'secret after');"
"${PSQL[@]}" -c "INSERT INTO public.notifications (user_id, type) VALUES ('$B', 'message');"
expect_value "DM broadcast is private" \
  "SELECT private FROM realtime.messages WHERE event='new_message'" "t"
expect_value "DM broadcast goes to the recipient's personal topic" \
  "SELECT topic FROM realtime.messages WHERE event='new_message'" "user:$B"
expect_value "DM broadcast payload has exactly id/sender_id/recipient_id/created_at (no body)" \
  "SELECT string_agg(k, ',' ORDER BY k) FROM realtime.messages, jsonb_object_keys(payload) k WHERE event='new_message'" "created_at,id,recipient_id,sender_id"
expect_value "the message text appears nowhere in realtime.messages" \
  "SELECT count(*) FROM realtime.messages WHERE payload::text LIKE '%secret after%'" "0"
expect_value "notification broadcast is private" \
  "SELECT private FROM realtime.messages WHERE event='new_notification'" "t"
"${PSQL[@]}" -c "INSERT INTO public.vc_transactions (user_id, amount, type) VALUES ('$B', 50, 'earn');"
expect_value "VC broadcast is private, to the user's own topic" \
  "SELECT private::text || ' ' || topic FROM realtime.messages WHERE event='vc_updated'" "true user:$B"
expect_value "no broadcast is public after 0199" \
  "SELECT count(*) FROM realtime.messages WHERE private IS NOT TRUE" "0"

echo "== Normal messaging still works =="
expect_value "the DM row was stored" \
  "SELECT count(*) FROM public.direct_messages WHERE body='secret after'" "1"
got="$("${PSQL[@]}" -tA <<SQL
BEGIN; SELECT set_config('test.uid', '$B', true) \gset
SET LOCAL ROLE authenticated;
SELECT body FROM public.direct_messages WHERE body='secret after';
ROLLBACK;
SQL
)"; check "recipient reads the stored body via RLS" "$(echo "$got" | grep -c 'secret after')" "1"
got="$("${PSQL[@]}" -tA <<SQL
BEGIN; SELECT set_config('test.uid', '$C', true) \gset
SET LOCAL ROLE authenticated;
SELECT count(*) FROM public.direct_messages;
ROLLBACK;
SQL
)"; check "a stranger still reads no DM rows" "$(echo "$got" | tail -1)" "0"

echo "== Personal topic user:<uid> =="
check "recipient can receive on own user:B"            "$(can_receive authenticated "$B" "user:$B")" "true"
check "stranger cannot receive on user:B"               "$(can_receive authenticated "$C" "user:$B")" "false"
check "sender cannot receive on recipient's user:B"     "$(can_receive authenticated "$A" "user:$B")" "false"
check "anon cannot receive on user:B"                   "$(can_receive anon "" "user:$B")" "false"
check "unauthenticated 'authenticated' cannot receive"  "$(can_receive authenticated "" "user:$B")" "false"
check "presence on own user:B is refused"               "$(can_receive authenticated "$B" "user:$B" presence)" "false"
check "owner cannot send into own user:B"               "$(can_send authenticated "$B" "user:$B")" "false"
check "stranger cannot send into user:B (no spoofing)"  "$(can_send authenticated "$C" "user:$B")" "false"
check "anon cannot send into user:B"                    "$(can_send anon "" "user:$B")" "false"

echo "== Conversation topic dm:<a>:<b> =="
check "participant A can receive on dm:A:B"   "$(can_receive authenticated "$A" "$DM_AB")" "true"
check "participant B can receive on dm:A:B"   "$(can_receive authenticated "$B" "$DM_AB")" "true"
check "participant A can send typing on dm:A:B" "$(can_send authenticated "$A" "$DM_AB")" "true"
check "participant B can send typing on dm:A:B" "$(can_send authenticated "$B" "$DM_AB")" "true"
check "reverse id order dm:B:A also works for A" "$(can_send authenticated "$A" "$DM_BA")" "true"
check "stranger cannot receive on dm:A:B"     "$(can_receive authenticated "$C" "$DM_AB")" "false"
check "stranger cannot send on dm:A:B"        "$(can_send authenticated "$C" "$DM_AB")" "false"
check "anon cannot receive on dm:A:B"         "$(can_receive anon "" "$DM_AB")" "false"
check "self topic dm:A:A is refused"          "$(can_receive authenticated "$A" "dm:$A:$A")" "false"
check "truncated topic dm:A is refused"       "$(can_receive authenticated "$A" "dm:$A")" "false"
check "extra segment dm:A:B:x is refused"     "$(can_receive authenticated "$A" "$DM_AB:x")" "false"
check "non-uuid topic dm:A:all is refused"    "$(can_receive authenticated "$A" "dm:$A:all")" "false"
check "other private topics get no access"    "$(can_receive authenticated "$A" "admin:stats")" "false"

echo "== Blocking closes the conversation topic in both directions =="
"${PSQL[@]}" -c "INSERT INTO public.blocked_users (blocker_id, blocked_id) VALUES ('$B', '$A');"
check "blocked sender A can no longer receive on dm:A:B" "$(can_receive authenticated "$A" "$DM_AB")" "false"
check "blocked sender A can no longer send on dm:A:B"    "$(can_send authenticated "$A" "$DM_AB")" "false"
check "blocker B can no longer send on dm:A:B"           "$(can_send authenticated "$B" "$DM_AB")" "false"
check "blocking does not affect B's own user:B"          "$(can_receive authenticated "$B" "user:$B")" "true"
"${PSQL[@]}" -c "DELETE FROM public.blocked_users;"
check "after unblock, A can send on dm:A:B again"        "$(can_send authenticated "$A" "$DM_AB")" "true"

echo "== Function privileges =="
expect_value "can_access_dm_realtime_topic is SECURITY DEFINER with empty search_path" \
  "SELECT prosecdef::text || ' ' || array_to_string(proconfig, ',') FROM pg_proc WHERE proname='can_access_dm_realtime_topic'" "true search_path=\"\""
expect_value "anon cannot execute can_access_dm_realtime_topic" \
  "SELECT has_function_privilege('anon', 'public.can_access_dm_realtime_topic(text)', 'EXECUTE')" "f"
expect_value "authenticated can execute can_access_dm_realtime_topic" \
  "SELECT has_function_privilege('authenticated', 'public.can_access_dm_realtime_topic(text)', 'EXECUTE')" "t"

sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
echo
if [[ $FAILS -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED" >&2; exit 1; fi
