#!/usr/bin/env bash
# Zero-cost local-Postgres execution test for migration 0194 (direct_messages
# column-grant hardening).
#
# Why this exists: a prior audit found that `authenticated` held table-level
# UPDATE on every column of public.direct_messages, not just `read_at` --
# meaning a sender or recipient could rewrite `body`/`sender_id`/
# `recipient_id`/etc. via a raw PostgREST PATCH while still passing the
# existing row-scoped RLS policy (RLS restricts which ROWS, not which
# COLUMNS, can be written). This script proves that under real Postgres,
# connected as the actual non-superuser `authenticated` role (not a
# superuser bypassing all grant/RLS checks):
# 1. the vulnerability is real before the fix (an authenticated recipient
#    CAN rewrite `body` on their own row today), and
# 2. after applying migration 0194, the same write is rejected at the
#    grant level while the legitimate read_at/deleted_by_sender paths
#    still succeed, including in combination.
#
# Prerequisites: a local PostgreSQL server reachable via `sudo -u postgres
# psql` (see run-rollback-verification.sh for the general pattern this
# mirrors).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DB_NAME="vents_dm_grant_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

echo "== (Re)creating throwaway database '$DB_NAME' =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"

echo "== Applying minimal auth/role/users base (reusing schema-vents-earn.sql's pattern) =="
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT current_setting('test.uid', true)::uuid $$;

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL DEFAULT 'user'
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;

-- public.direct_messages, matching the live production column list exactly
-- (id, sender_id, recipient_id, event_id, body, read_at, created_at,
-- image_url, media_type, deleted_by_sender, duration_seconds, reply_to_id).
CREATE TABLE public.direct_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  event_id uuid,
  body text,
  read_at timestamptz,
  created_at timestamptz DEFAULT now(),
  image_url text,
  media_type text,
  deleted_by_sender boolean DEFAULT false,
  duration_seconds integer,
  reply_to_id uuid
);

ALTER TABLE public.direct_messages ENABLE ROW LEVEL SECURITY;

-- The live dm_select / dm_update / dm_delete policies, verbatim shape.
CREATE POLICY dm_select ON public.direct_messages FOR SELECT TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
CREATE POLICY dm_update ON public.direct_messages FOR UPDATE TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id)
  WITH CHECK (auth.uid() = sender_id OR auth.uid() = recipient_id);
CREATE POLICY dm_delete ON public.direct_messages FOR DELETE TO authenticated
  USING (auth.uid() = sender_id);

GRANT SELECT, INSERT, DELETE ON public.direct_messages TO authenticated;
-- Reproduce the PRE-FIX, over-broad grant exactly as confirmed live, so the
-- "before" assertions below are testing the real vulnerability, not a
-- strawman.
GRANT UPDATE ON public.direct_messages TO authenticated;
SQL

echo "== Seeding two users and one message (sender -> recipient) =="
SENDER="00000000-0000-0000-0000-00000000a001"
RECIPIENT="00000000-0000-0000-0000-00000000a002"
"${PSQL[@]}" <<SQL
INSERT INTO public.users (id) VALUES ('$SENDER'), ('$RECIPIENT');
INSERT INTO public.direct_messages (id, sender_id, recipient_id, body)
VALUES ('00000000-0000-0000-0000-00000000b001', '$SENDER', '$RECIPIENT', 'original body');
SQL

PASS_COUNT=0
FAIL_COUNT=0

expect_ok() {
  local label="$1" sql="$2"
  if "${PSQL[@]}" -c "SET ROLE authenticated; $sql" >/tmp/dm_test_out 2>&1; then
    echo "PASS: $label (succeeded as expected)"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    echo "FAIL: $label -- expected success, got error:"; cat /tmp/dm_test_out
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
}

expect_denied() {
  local label="$1" sql="$2"
  if "${PSQL[@]}" -c "SET ROLE authenticated; $sql" >/tmp/dm_test_out 2>&1; then
    echo "FAIL: $label -- expected a permission-denied error, but it SUCCEEDED:"; cat /tmp/dm_test_out
    FAIL_COUNT=$((FAIL_COUNT+1))
  elif grep -qi "permission denied for table\|permission denied for column" /tmp/dm_test_out; then
    echo "PASS: $label (rejected: permission denied, as expected)"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    echo "FAIL: $label -- rejected, but NOT with a permission-denied error:"; cat /tmp/dm_test_out
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
}

echo
echo "===== BEFORE migration 0194 (reproducing the live vulnerability) ====="
expect_ok "VULN: recipient can currently rewrite body via raw UPDATE" \
  "SET SESSION AUTHORIZATION authenticated; SET test.uid='$RECIPIENT'; UPDATE public.direct_messages SET body='HACKED BY RECIPIENT' WHERE id='00000000-0000-0000-0000-00000000b001';"
"${PSQL[@]}" -c "UPDATE public.direct_messages SET body='original body' WHERE id='00000000-0000-0000-0000-00000000b001';" >/dev/null

echo
echo "== Applying migration 0194 =="
"${PSQL[@]}" -f "$REPO_ROOT/supabase/migrations/0194_direct_messages_column_grant_hardening.sql"

echo
echo "===== AFTER migration 0194 (fix verification) ====="

run_as() {
  local uid="$1" sql="$2"
  "${PSQL[@]}" <<SQL
SET SESSION AUTHORIZATION authenticated;
SET test.uid='$uid';
$sql
SQL
}

check_denied() {
  local label="$1" uid="$2" sql="$3"
  if run_as "$uid" "$sql" >/tmp/dm_test_out 2>&1; then
    echo "FAIL: $label -- expected permission denied, but it SUCCEEDED:"; cat /tmp/dm_test_out
    FAIL_COUNT=$((FAIL_COUNT+1))
  elif grep -qi "permission denied for table\|permission denied for column" /tmp/dm_test_out; then
    echo "PASS: $label (rejected: permission denied)"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    echo "FAIL: $label -- rejected, but not with permission-denied:"; cat /tmp/dm_test_out
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
}

check_ok() {
  local label="$1" uid="$2" sql="$3"
  if run_as "$uid" "$sql" >/tmp/dm_test_out 2>&1; then
    echo "PASS: $label (succeeded)"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    echo "FAIL: $label -- expected success, got error:"; cat /tmp/dm_test_out
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
}

check_denied "recipient cannot rewrite body" "$RECIPIENT" \
  "UPDATE public.direct_messages SET body='STILL HACKED' WHERE id='00000000-0000-0000-0000-00000000b001';"

check_denied "sender cannot rewrite recipient_id" "$SENDER" \
  "UPDATE public.direct_messages SET recipient_id='$SENDER' WHERE id='00000000-0000-0000-0000-00000000b001';"

check_denied "recipient cannot rewrite sender_id" "$RECIPIENT" \
  "UPDATE public.direct_messages SET sender_id='$RECIPIENT' WHERE id='00000000-0000-0000-0000-00000000b001';"

check_denied "combined read_at+body update is rejected in full (no partial apply)" "$RECIPIENT" \
  "UPDATE public.direct_messages SET read_at=now(), body='SNEAKY' WHERE id='00000000-0000-0000-0000-00000000b001';"

# Confirm the above combined attempt didn't partially apply read_at despite
# the statement erroring overall.
READ_AT_AFTER_COMBINED=$("${PSQL[@]}" -tAc "SELECT read_at IS NULL FROM public.direct_messages WHERE id='00000000-0000-0000-0000-00000000b001';")
if [ "$READ_AT_AFTER_COMBINED" = "t" ]; then
  echo "PASS: combined update left read_at untouched (whole statement atomically rejected)"
  PASS_COUNT=$((PASS_COUNT+1))
else
  echo "FAIL: combined update partially applied read_at despite body being rejected"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

check_ok "recipient CAN still mark read_at (legitimate path)" "$RECIPIENT" \
  "UPDATE public.direct_messages SET read_at=now() WHERE id='00000000-0000-0000-0000-00000000b001';"

check_ok "sender CAN still soft-delete via deleted_by_sender (legitimate path)" "$SENDER" \
  "UPDATE public.direct_messages SET deleted_by_sender=true WHERE id='00000000-0000-0000-0000-00000000b001';"

# Reset deleted_by_sender for the next check, as postgres (unrestricted).
"${PSQL[@]}" -c "UPDATE public.direct_messages SET deleted_by_sender=false, read_at=NULL WHERE id='00000000-0000-0000-0000-00000000b001';" >/dev/null

check_ok "recipient CAN update both read_at and deleted_by_sender together" "$RECIPIENT" \
  "UPDATE public.direct_messages SET read_at=now(), deleted_by_sender=true WHERE id='00000000-0000-0000-0000-00000000b001';"

if "${PSQL[@]}" -c "SET SESSION AUTHORIZATION anon; UPDATE public.direct_messages SET read_at=now() WHERE id='00000000-0000-0000-0000-00000000b001';" >/tmp/dm_test_out 2>&1; then
  echo "FAIL: anon has no UPDATE at all post-fix -- expected permission denied, SUCCEEDED:"; cat /tmp/dm_test_out
  FAIL_COUNT=$((FAIL_COUNT+1))
elif grep -qi "permission denied for table\|permission denied for column" /tmp/dm_test_out; then
  echo "PASS: anon has no UPDATE at all post-fix (rejected: permission denied)"
  PASS_COUNT=$((PASS_COUNT+1))
else
  echo "FAIL: anon has no UPDATE at all post-fix -- rejected, but not with permission-denied:"; cat /tmp/dm_test_out
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

# service_role-equivalent: migration 0194 only touches authenticated/anon
# grants, so postgres (standing in for service_role / SECURITY DEFINER
# function owner, which runs independent of caller grants) must remain
# fully unaffected.
echo
echo "== Confirming unrestricted (service_role-equivalent) write path is unaffected =="
if "${PSQL[@]}" -c "UPDATE public.direct_messages SET body='owner-path write', sender_id='$SENDER', recipient_id='$RECIPIENT' WHERE id='00000000-0000-0000-0000-00000000b001';" >/tmp/dm_test_out 2>&1; then
  echo "PASS: unrestricted/service-role-equivalent path can still write body/sender_id/recipient_id"
  PASS_COUNT=$((PASS_COUNT+1))
else
  echo "FAIL: unrestricted path unexpectedly rejected:"; cat /tmp/dm_test_out
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

echo
echo "===== Results: $PASS_COUNT passed, $FAIL_COUNT failed ====="
if [ "$FAIL_COUNT" -ne 0 ]; then
  exit 1
fi
