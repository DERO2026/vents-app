#!/usr/bin/env bash
# Real-execution verification for migration 0193 (VENTS Earn Stage 1:
# recruiter partnerships), covering the fixes made in response to PR #47
# review: withdraw_recruiter_invitation, revoke_recruiter_partnership's
# authorization branches, admin_set_recruiter_status, and the
# recruiters_select_partner status-scoping.
#
# Why this exists: src/lib/ventsEarnFoundation.security.test.ts only
# regex-matches the migration's SQL text -- it never runs it. This script
# applies the real migration to a real, local, throwaway Postgres database
# and calls the real SECURITY DEFINER functions (impersonating different
# callers via a session GUC auth.uid() reads -- see schema-vents-earn.sql)
# to prove the authorization logic and CHECK constraints actually hold at
# runtime, not just in the source text.
#
# Prerequisites: a local PostgreSQL server reachable via `sudo -u postgres
# psql` (this repo's dev container ships PostgreSQL 16 via
# pg_ctlcluster). None of this touches the real Supabase project.
#
# Usage:
#   scripts/local-pg-test/run-vents-earn-verification.sh [migration_file]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATION_FILE="${1:-$REPO_ROOT/supabase/migrations/0193_vents_earn_foundation.sql}"
DB_NAME="vents_local_pg_earn_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

RECRUITER="00000000-0000-0000-0000-00000000a001"
RECRUITER2="00000000-0000-0000-0000-00000000a006"
ORGANIZER="00000000-0000-0000-0000-00000000a002"
PROVIDER_OWNER="00000000-0000-0000-0000-00000000a003"
UNRELATED="00000000-0000-0000-0000-00000000a004"
ADMIN="00000000-0000-0000-0000-00000000a005"
EVENT1="00000000-0000-0000-0000-00000000b001"
PROVIDER1="00000000-0000-0000-0000-00000000b002"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }

# expect_error "<label>" "<expected substring>" "<sql>"
expect_error() {
  local label="$1" expected="$2" sql="$3"
  if sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "$sql" >/tmp/earn_out.log 2>/tmp/earn_err.log; then
    fail "$label (expected an exception, call succeeded)"
    return
  fi
  if grep -q "$expected" /tmp/earn_err.log; then
    pass "$label"
  else
    fail "$label (wrong error text)"; cat /tmp/earn_err.log >&2
  fi
}

# expect_ok "<label>" "<sql>"
expect_ok() {
  local label="$1" sql="$2"
  if sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "$sql" >/tmp/earn_out.log 2>/tmp/earn_err.log; then
    pass "$label"
  else
    fail "$label (expected success, got an exception)"; cat /tmp/earn_err.log >&2
  fi
}

# expect_count "<label>" "<sql returning one integer>" "<expected>"
expect_count() {
  local label="$1" sql="$2" expected="$3" actual
  actual=$(sudo -u postgres psql -tA -d "$DB_NAME" -c "$sql" | tail -n1)
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label (expected $expected, got $actual)"
  fi
}

echo "== Using migration: $MIGRATION_FILE =="

echo "== (Re)creating throwaway database '$DB_NAME' =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"

echo "== Applying minimal schema =="
"${PSQL[@]}" -f "$SCRIPT_DIR/schema-vents-earn.sql"

echo "== Applying migration under test =="
"${PSQL[@]}" -f "$MIGRATION_FILE"

echo "== Seeding users/events/service_providers =="
"${PSQL[@]}" <<SQL
INSERT INTO public.users (id, role) VALUES
  ('$RECRUITER', 'user'), ('$RECRUITER2', 'user'), ('$ORGANIZER', 'user'),
  ('$PROVIDER_OWNER', 'user'), ('$UNRELATED', 'user'), ('$ADMIN', 'admin');
INSERT INTO public.events (id, organizer_id, title) VALUES ('$EVENT1', '$ORGANIZER', 'Test Event');
INSERT INTO public.service_providers (id, user_id) VALUES ('$PROVIDER1', '$PROVIDER_OWNER');
SQL

echo "== Registering recruiters =="
expect_ok "register recruiter 1" "SET test.uid='$RECRUITER'; SELECT public.register_as_recruiter('R One', NULL);"
expect_ok "register recruiter 2" "SET test.uid='$RECRUITER2'; SELECT public.register_as_recruiter('R Two', NULL);"

echo "== withdraw_recruiter_invitation: authorization + lifecycle (finding #1) =="
expect_ok "recruiter 1 invites organizer" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$ORGANIZER', NULL, 500);"

expect_error "invited organizer cannot withdraw the invite" "Not authorized to withdraw this invitation" \
  "SET test.uid='$ORGANIZER'; SELECT public.withdraw_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER' AND organizer_id='$ORGANIZER' AND status='pending'));"

expect_error "unrelated user cannot withdraw the invite" "Not authorized to withdraw this invitation" \
  "SET test.uid='$UNRELATED'; SELECT public.withdraw_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER' AND organizer_id='$ORGANIZER' AND status='pending'));"

expect_ok "recruiter withdraws their own pending invite" \
  "SET test.uid='$RECRUITER'; SELECT public.withdraw_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER' AND organizer_id='$ORGANIZER' AND status='pending'));"

expect_count "withdrawn row has status='withdrawn' and no responder (never responded)" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER' AND organizer_id='$ORGANIZER' AND status='withdrawn' AND responded_at IS NULL AND responded_by IS NULL;" "1"

expect_error "repeated withdrawal fails (no longer pending)" "Only a pending invitation can be withdrawn" \
  "SET test.uid='$RECRUITER'; SELECT public.withdraw_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER' AND organizer_id='$ORGANIZER' AND status='withdrawn'));"

expect_ok "reinvitation after withdrawal succeeds (uniqueness released -- the actual deadlock fix)" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$ORGANIZER', NULL, 250);"

expect_count "exactly one pending row now exists for (recruiter, organizer)" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER' AND organizer_id='$ORGANIZER' AND status='pending';" "1"

echo "== revoke_recruiter_partnership: authorization branches (finding #3 test gap) =="
expect_ok "recruiter2 invites organizer (separate pairing)" \
  "SET test.uid='$RECRUITER2'; SELECT public.invite_recruiter_partnership('$ORGANIZER', NULL, 1000);"
expect_ok "organizer accepts recruiter2's invite" \
  "SET test.uid='$ORGANIZER'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND organizer_id='$ORGANIZER' AND status='pending'), true);"

expect_error "unrelated user cannot revoke an accepted partnership" "Not authorized to revoke this partnership" \
  "SET test.uid='$UNRELATED'; SELECT public.revoke_recruiter_partnership((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND organizer_id='$ORGANIZER' AND status='accepted'));"

expect_ok "recruiter2 (a party) revokes their own accepted partnership" \
  "SET test.uid='$RECRUITER2'; SELECT public.revoke_recruiter_partnership((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND organizer_id='$ORGANIZER' AND status='accepted'));"

expect_error "revoking an already-revoked partnership fails (not accepted anymore)" "Only an accepted partnership can be revoked" \
  "SET test.uid='$RECRUITER2'; SELECT public.revoke_recruiter_partnership((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND organizer_id='$ORGANIZER' AND status='revoked'));"

expect_ok "recruiter2 invites provider1 (provider-side branch)" \
  "SET test.uid='$RECRUITER2'; SELECT public.invite_recruiter_partnership(NULL, '$PROVIDER1', 300);"
expect_ok "provider owner accepts" \
  "SET test.uid='$PROVIDER_OWNER'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND provider_id='$PROVIDER1' AND status='pending'), true);"
expect_ok "provider owner (the other party) revokes" \
  "SET test.uid='$PROVIDER_OWNER'; SELECT public.revoke_recruiter_partnership((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND provider_id='$PROVIDER1' AND status='accepted'));"

expect_ok "recruiter2 invites organizer again for an admin-revoke scenario" \
  "SET test.uid='$RECRUITER2'; SELECT public.invite_recruiter_partnership('$ORGANIZER', NULL, 400);"
expect_ok "organizer accepts (third pairing)" \
  "SET test.uid='$ORGANIZER'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND organizer_id='$ORGANIZER' AND status='pending'), true);"
expect_ok "admin (not a party) revokes via is_admin()" \
  "SET test.uid='$ADMIN'; SELECT public.revoke_recruiter_partnership((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND organizer_id='$ORGANIZER' AND status='accepted'));"

expect_ok "recruiter2 invites provider1 again, left pending" \
  "SET test.uid='$RECRUITER2'; SELECT public.invite_recruiter_partnership(NULL, '$PROVIDER1', 150);"
expect_error "revoke rejects a merely-pending partnership" "Only an accepted partnership can be revoked" \
  "SET test.uid='$RECRUITER2'; SELECT public.revoke_recruiter_partnership((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER2' AND provider_id='$PROVIDER1' AND status='pending'));"

echo "== admin_set_recruiter_status: real admin-only moderation (finding #2) =="
expect_error "non-admin cannot suspend a recruiter" "Not authorized" \
  "SET test.uid='$ORGANIZER'; SELECT public.admin_set_recruiter_status('$RECRUITER', 'suspended');"
expect_ok "admin suspends a recruiter" \
  "SET test.uid='$ADMIN'; SELECT public.admin_set_recruiter_status('$RECRUITER', 'suspended');"
expect_error "suspension actually blocks that recruiter's invites" "Caller is not a registered, active recruiter" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$ORGANIZER', NULL, 100);"
expect_error "admin cannot set an invalid status value" "Invalid status" \
  "SET test.uid='$ADMIN'; SELECT public.admin_set_recruiter_status('$RECRUITER', 'banned');"
expect_ok "admin reinstates the recruiter" \
  "SET test.uid='$ADMIN'; SELECT public.admin_set_recruiter_status('$RECRUITER', 'active');"

echo "== recruiters_select_partner RLS scoping (finding #4) =="
# ORGANIZER currently has: a 'pending' invite from RECRUITER (reinvited
# above), and only 'revoked' history with RECRUITER2 (both accepted
# partnerships with RECRUITER2 were revoked above). Expect visibility
# into RECRUITER's profile (pending counts) but NOT into RECRUITER2's
# (only revoked history remains).
expect_count "organizer can see recruiter 1's profile (has a live pending invite)" \
  "SET ROLE authenticated; SET test.uid='$ORGANIZER'; SELECT count(*) FROM public.recruiters WHERE id='$RECRUITER';" "1"
expect_count "organizer can no longer see recruiter 2's profile (only revoked history)" \
  "SET ROLE authenticated; SET test.uid='$ORGANIZER'; SELECT count(*) FROM public.recruiters WHERE id='$RECRUITER2';" "0"

echo "== Frontend integration fixes (PR #49 review): real-SQL proof, not mocked-client (findings #1-#3) =="

echo "-- Finding #1: register_as_recruiter requires p_display_name (no default) --"
expect_error "calling register_as_recruiter() with zero arguments fails (the UI's original bug)" \
  "function public.register_as_recruiter() does not exist" \
  "SELECT public.register_as_recruiter();"
expect_count "calling it correctly (named p_display_name) creates exactly one row with that name" \
  "SET test.uid='$UNRELATED'; SELECT public.register_as_recruiter(p_display_name := 'Fix Check', p_bio := NULL); SELECT count(*) FROM public.recruiters WHERE id='$UNRELATED' AND display_name='Fix Check';" "1"

echo "-- Finding #2: recruiters.id IS the user's auth id; there is no recruiters.user_id column --"
expect_error "querying the nonexistent recruiters.user_id column fails outright" \
  "column \"user_id\" does not exist" \
  "SELECT user_id FROM public.recruiters LIMIT 1;"
expect_count "the correct lookup (id = auth id) finds a registered recruiter" \
  "SELECT count(*) FROM public.recruiters WHERE id='$UNRELATED';" "1"
expect_count "the correct lookup returns zero for a user who never registered" \
  "SELECT count(*) FROM public.recruiters WHERE id='$ADMIN';" "0"

echo "-- Finding #3: recruiter_partnerships.provider_id references service_providers.id, not the owner's auth id --"
expect_ok "recruiter1 invites provider1 for the provider-id-resolution check" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership(NULL, '$PROVIDER1', 200);"
expect_count "filtering by the owner's raw auth id finds nothing (the UI's original bug, reproduced in SQL)" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE status='pending' AND (organizer_id='$PROVIDER_OWNER' OR provider_id='$PROVIDER_OWNER');" "0"
expect_count "filtering by the resolved service_providers.id correctly surfaces this recruiter's invitation" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE status='pending' AND recruiter_id='$RECRUITER' AND (organizer_id='$PROVIDER_OWNER' OR provider_id=(SELECT id FROM public.service_providers WHERE user_id='$PROVIDER_OWNER'));" "1"
expect_ok "a user with no service_providers row can run the same resolve-then-filter query without erroring" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE status='pending' AND (organizer_id='$UNRELATED' OR provider_id=(SELECT id FROM public.service_providers WHERE user_id='$UNRELATED'));"

echo "== Finding #4 (this pass): inviting a service provider was structurally impossible =="
echo "-- Before: the UI's old call shape always sent the target's raw user id as p_organizer_id --"
expect_error "old broken call shape (provider's raw user id as p_organizer_id) is rejected" \
  "Target organizer not found" \
  "SET test.uid='$UNRELATED'; SELECT public.invite_recruiter_partnership('$PROVIDER_OWNER', NULL, 100);"
echo "-- After: the fixed call shape resolves the target's service_providers.id first --"
expect_ok "fixed call shape (resolved service_providers.id as p_provider_id) succeeds" \
  "SET test.uid='$UNRELATED'; SELECT public.invite_recruiter_partnership(NULL, (SELECT id FROM public.service_providers WHERE user_id='$PROVIDER_OWNER'), 100);"
expect_count "the resulting row is attributed to the correct provider, not the raw user id" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE recruiter_id='$UNRELATED' AND provider_id='$PROVIDER1' AND status='pending';" "1"
echo "-- Regression guard: inviting an organizer via the fixed call shape still works --"
expect_error "a user with no events row is not a valid organizer target" \
  "Target organizer not found" \
  "SET test.uid='$UNRELATED'; SELECT public.invite_recruiter_partnership('$ADMIN', NULL, 100);"
expect_ok "a user with an events row as organizer is still a valid organizer-invite target" \
  "SET test.uid='$RECRUITER2'; SELECT public.invite_recruiter_partnership('$ORGANIZER', NULL, 100);"

echo "== respond_to_recruiter_invitation: decline path (p_accept=false), test-enumeration gap closed =="
# Fresh, isolated actors so this section doesn't depend on or disturb any
# fixture state set up/consumed by the sections above.
RECRUITER3="00000000-0000-0000-0000-00000000a007"
ORGANIZER2="00000000-0000-0000-0000-00000000a008"
PROVIDER_OWNER2="00000000-0000-0000-0000-00000000a009"
UNRELATED2="00000000-0000-0000-0000-00000000a00a"
EVENT2="00000000-0000-0000-0000-00000000b003"
PROVIDER2="00000000-0000-0000-0000-00000000b004"

"${PSQL[@]}" <<SQL
INSERT INTO public.users (id, role) VALUES
  ('$RECRUITER3', 'user'), ('$ORGANIZER2', 'user'), ('$PROVIDER_OWNER2', 'user'), ('$UNRELATED2', 'user');
INSERT INTO public.events (id, organizer_id, title) VALUES ('$EVENT2', '$ORGANIZER2', 'Test Event 2');
INSERT INTO public.service_providers (id, user_id) VALUES ('$PROVIDER2', '$PROVIDER_OWNER2');
SQL
expect_ok "register recruiter 3" \
  "SET test.uid='$RECRUITER3'; SELECT public.register_as_recruiter('R Three', NULL);"

echo "-- Authorized decline (organizer side) --"
expect_ok "recruiter3 invites organizer2" \
  "SET test.uid='$RECRUITER3'; SELECT public.invite_recruiter_partnership('$ORGANIZER2', NULL, 500);"
expect_error "the recruiter cannot decline their own invitation" "The recruiter cannot respond to their own invitation" \
  "SET test.uid='$RECRUITER3'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND organizer_id='$ORGANIZER2' AND status='pending'), false);"
expect_error "an unrelated user cannot decline someone else's invitation" "Not authorized to respond to this invitation" \
  "SET test.uid='$UNRELATED2'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND organizer_id='$ORGANIZER2' AND status='pending'), false);"
expect_ok "the organizer declines their own pending invitation" \
  "SET test.uid='$ORGANIZER2'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND organizer_id='$ORGANIZER2' AND status='pending'), false);"
expect_count "the declined row has status='declined'" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND organizer_id='$ORGANIZER2' AND status='declined';" "1"
expect_count "responded_by is set to the organizer, not the recruiter" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND organizer_id='$ORGANIZER2' AND status='declined' AND responded_by='$ORGANIZER2' AND responded_at IS NOT NULL;" "1"

echo "-- Decline on a non-pending row fails cleanly --"
expect_error "declining an already-declined row fails (not pending anymore)" "Partnership is not pending (status=declined)" \
  "SET test.uid='$ORGANIZER2'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND organizer_id='$ORGANIZER2' AND status='declined'), false);"

echo "-- A declined row doesn't block a fresh invite (same terminal-state behavior as revoked/withdrawn) --"
expect_ok "recruiter3 can send a fresh invite to organizer2 after the decline" \
  "SET test.uid='$RECRUITER3'; SELECT public.invite_recruiter_partnership('$ORGANIZER2', NULL, 600);"
expect_count "exactly one pending row now exists for (recruiter3, organizer2) alongside the declined one" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND organizer_id='$ORGANIZER2' AND status='pending';" "1"

echo "-- Authorized decline (provider side), to confirm the provider branch behaves identically --"
expect_ok "recruiter3 invites provider2" \
  "SET test.uid='$RECRUITER3'; SELECT public.invite_recruiter_partnership(NULL, '$PROVIDER2', 500);"
expect_error "an unrelated user cannot decline the provider-side invitation either" "Not authorized to respond to this invitation" \
  "SET test.uid='$UNRELATED2'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND provider_id='$PROVIDER2' AND status='pending'), false);"
expect_ok "the provider owner declines their own pending invitation" \
  "SET test.uid='$PROVIDER_OWNER2'; SELECT public.respond_to_recruiter_invitation((SELECT id FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND provider_id='$PROVIDER2' AND status='pending'), false);"
expect_count "the provider-side declined row has status='declined' and responded_by=provider owner" \
  "SELECT count(*) FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER3' AND provider_id='$PROVIDER2' AND status='declined' AND responded_by='$PROVIDER_OWNER2' AND responded_at IS NOT NULL;" "1"

echo "== Cleanup =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL VENTS EARN VERIFICATION CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED"
  exit 1
fi
