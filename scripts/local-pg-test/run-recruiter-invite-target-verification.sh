#!/usr/bin/env bash
# Real-execution verification for migration 0196 (Representatives invite
# eligibility honours the Admin-granted Organizer capability).
#
# Reproduces the production report -- a user with users.is_organizer =
# true and users.is_service_provider = true (granted in the Admin
# Console) but no events and no service_providers row could not be
# invited -- against 0193 alone, then applies 0196 and proves:
#   - that exact user is now an invitable organizer, end to end
#   - users with genuinely neither role are still rejected, by both the
#     resolver and invite_recruiter_partnership itself
#   - every pre-existing eligibility rule still holds (events-based
#     organizers, approved-provider path, self-invite, inactive recruiter)
#
# Prerequisites and conventions: identical to
# run-vents-earn-verification.sh (local PostgreSQL via `sudo -u postgres
# psql`, auth.uid() backed by the `test.uid` GUC). Never touches the real
# Supabase project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
M0193="$REPO_ROOT/supabase/migrations/0193_vents_earn_foundation.sql"
M0196="$REPO_ROOT/supabase/migrations/0196_recruiter_invite_target_uses_organizer_capability.sql"
DB_NAME="vents_local_pg_invite_target_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

RECRUITER="00000000-0000-0000-0000-00000000c001"
CAP_ORG="00000000-0000-0000-0000-00000000c002"       # the "dero" shape
EVENT_ORG="00000000-0000-0000-0000-00000000c003"     # legacy: events, no flag
MULTI_ORG="00000000-0000-0000-0000-00000000c004"     # flag + 3 events
PROVIDER_OWNER="00000000-0000-0000-0000-00000000c005"
PENDING_PROVIDER_OWNER="00000000-0000-0000-0000-00000000c006"
SP_FLAG_ONLY="00000000-0000-0000-0000-00000000c007"  # is_service_provider flag, no row
PLAIN="00000000-0000-0000-0000-00000000c008"
DELETED_ORG="00000000-0000-0000-0000-00000000c009"
ADMIN="00000000-0000-0000-0000-00000000c00a"
REVOKED_ORG="00000000-0000-0000-0000-00000000c00b"   # capability granted then removed
PROVIDER1="00000000-0000-0000-0000-00000000d001"
PROVIDER_PENDING="00000000-0000-0000-0000-00000000d002"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }

expect_error() {
  local label="$1" expected="$2" sql="$3"
  if sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "$sql" >/tmp/invt_out.log 2>/tmp/invt_err.log; then
    fail "$label (expected an exception, call succeeded)"; return
  fi
  if grep -q "$expected" /tmp/invt_err.log; then pass "$label"; else fail "$label (wrong error text)"; cat /tmp/invt_err.log >&2; fi
}
expect_ok() {
  local label="$1" sql="$2"
  if sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "$sql" >/tmp/invt_out.log 2>/tmp/invt_err.log; then
    pass "$label"; else fail "$label (expected success, got an exception)"; cat /tmp/invt_err.log >&2; fi
}
# expect_value "<label>" "<sql returning one scalar>" "<expected>"
expect_value() {
  local label="$1" sql="$2" expected="$3" actual
  actual=$(sudo -u postgres psql -tA -d "$DB_NAME" -c "$sql" 2>&1 | tail -n1)
  if [ "$actual" = "$expected" ]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
target() { # target <caller> <user> -> "is_organizer|provider_id"
  echo "SET ROLE authenticated; SET test.uid='$1'; SELECT target_is_organizer || '|' || coalesce(target_provider_id::text, '') FROM public.get_recruiter_invite_target('$2');"
}

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
"${PSQL[@]}" -q -f "$M0193" >/dev/null

"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, is_service_provider, deleted_at) VALUES
  ('$RECRUITER', 'user', false, false, NULL),
  ('$CAP_ORG', 'user', true, true, NULL),
  ('$EVENT_ORG', 'user', false, false, NULL),
  ('$MULTI_ORG', 'user', true, false, NULL),
  ('$PROVIDER_OWNER', 'user', false, true, NULL),
  ('$PENDING_PROVIDER_OWNER', 'user', false, false, NULL),
  ('$SP_FLAG_ONLY', 'user', false, true, NULL),
  ('$PLAIN', 'user', false, false, NULL),
  ('$DELETED_ORG', 'user', true, false, now()),
  ('$ADMIN', 'admin', false, false, NULL),
  ('$REVOKED_ORG', 'user', false, false, NULL);
INSERT INTO public.events (organizer_id, title) VALUES
  ('$EVENT_ORG', 'Legacy'), ('$MULTI_ORG', 'M1'), ('$MULTI_ORG', 'M2'), ('$MULTI_ORG', 'M3');
INSERT INTO public.service_providers (id, user_id, status) VALUES
  ('$PROVIDER1', '$PROVIDER_OWNER', 'approved'),
  ('$PROVIDER_PENDING', '$PENDING_PROVIDER_OWNER', 'pending');
SQL
expect_ok "register recruiter" "SET test.uid='$RECRUITER'; SELECT public.register_as_recruiter('R', NULL);"

echo "== Before 0196: reproduce the reported bug =="
expect_error "0193 rejects a capability-granted organizer with no events (the dero case)" \
  "Target organizer not found" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$CAP_ORG', NULL, 10000);"

"${PSQL[@]}" -q -f "$M0196" >/dev/null
echo "== After 0196 =="

echo "-- Regression: the exact reported case --"
expect_value "resolver: dero-shaped user is an organizer with no provider row" "$(target "$RECRUITER" "$CAP_ORG")" "true|"
expect_ok "invite_recruiter_partnership accepts the dero-shaped user as organizer" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$CAP_ORG', NULL, 10000);"
expect_value "the pending partnership and the recipient notification exist" \
  "SELECT (SELECT count(*) FROM public.recruiter_partnerships WHERE recruiter_id='$RECRUITER' AND organizer_id='$CAP_ORG' AND status='pending') || '/' || (SELECT count(*) FROM public.notifications WHERE user_id='$CAP_ORG' AND type='recruiter_invitation');" "1/1"
expect_error "a second pending invite to the same organizer is still blocked by 0193's uniqueness" \
  "duplicate key" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$CAP_ORG', NULL, 10000);"

echo "-- Preserved rules --"
expect_value "resolver: legacy organizer with events but no capability flag is still an organizer" "$(target "$RECRUITER" "$EVENT_ORG")" "true|"
expect_ok "invite still accepts a legacy events-only organizer" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$EVENT_ORG', NULL, 10000);"
expect_value "resolver: organizer with multiple events resolves (no single-row assumption)" "$(target "$RECRUITER" "$MULTI_ORG")" "true|"
expect_value "resolver: approved provider returns its service_providers.id" "$(target "$RECRUITER" "$PROVIDER_OWNER")" "false|$PROVIDER1"
expect_ok "provider-side invite still works with the resolved id" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership(NULL, '$PROVIDER1', 10000);"
expect_error "self-invite as organizer is still rejected even with the capability flag" \
  "Cannot form a partnership with yourself" \
  "UPDATE public.users SET is_organizer = true WHERE id='$RECRUITER'; SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$RECRUITER', NULL, 10000);"
"${PSQL[@]}" -q -c "UPDATE public.users SET is_organizer = false WHERE id='$RECRUITER';"
expect_error "a non-recruiter still cannot invite a capability organizer" \
  "Caller is not a registered, active recruiter" \
  "SET test.uid='$PLAIN'; SELECT public.invite_recruiter_partnership('$MULTI_ORG', NULL, 10000);"

echo "-- Negative: users who genuinely have neither eligible role --"
expect_value "resolver: plain user is neither" "$(target "$RECRUITER" "$PLAIN")" "false|"
expect_error "invite rejects a plain user as organizer" "Target organizer not found" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$PLAIN', NULL, 10000);"
expect_value "resolver: bare is_service_provider flag with no service_providers row is neither" "$(target "$RECRUITER" "$SP_FLAG_ONLY")" "false|"
expect_error "invite rejects a bare is_service_provider-flag user as organizer" "Target organizer not found" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$SP_FLAG_ONLY', NULL, 10000);"
expect_value "resolver: a pending (unapproved) provider row is not exposed or invitable via the resolver" "$(target "$RECRUITER" "$PENDING_PROVIDER_OWNER")" "false|"
expect_value "resolver: soft-deleted account with the organizer flag is not an organizer" "$(target "$RECRUITER" "$DELETED_ORG")" "false|"
expect_error "invite rejects a soft-deleted capability organizer" "Target organizer not found" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$DELETED_ORG', NULL, 10000);"
expect_value "resolver: admin role is not an implicit invitable organizer" "$(target "$RECRUITER" "$ADMIN")" "false|"
expect_error "invite rejects an admin with no organizer capability or events" "Target organizer not found" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$ADMIN', NULL, 10000);"
"${PSQL[@]}" -q -c "UPDATE public.users SET is_organizer = true WHERE id='$REVOKED_ORG'; UPDATE public.users SET is_organizer = false WHERE id='$REVOKED_ORG';"
expect_error "capability removed in the Admin Console -> no longer invitable (reads live flag, no cache)" \
  "Target organizer not found" \
  "SET test.uid='$RECRUITER'; SELECT public.invite_recruiter_partnership('$REVOKED_ORG', NULL, 10000);"

echo "-- Grants --"
expect_error "anon cannot call the resolver" "permission denied" \
  "SET ROLE anon; SELECT * FROM public.get_recruiter_invite_target('$CAP_ORG');"
expect_error "an unauthenticated session cannot use the resolver" "Not authenticated" \
  "SET ROLE authenticated; SELECT * FROM public.get_recruiter_invite_target('$CAP_ORG');"
expect_error "authenticated cannot call the internal helper directly" "permission denied" \
  "SET ROLE authenticated; SET test.uid='$RECRUITER'; SELECT public.recruiter_target_is_organizer('$CAP_ORG');"

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
echo
if [ "$FAILS" -eq 0 ]; then echo "ALL RECRUITER INVITE TARGET CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; exit 1; fi
