#!/usr/bin/env bash
# Security audit of the VENTS Earn representative reward payout gate
# (migration 0201): 27 real-execution checks.
#
#   1/2  earn_settings.payouts_enabled is enforced inside the function that
#        credits the earnings wallet, and nothing else can credit around it
#        (direct table writes, internal functions, unknown admin actions).
#   3/4  dual control: two distinct admins, the approver a super admin, and
#        neither the representative nor the organizer may request or
#        approve their own reward.
#   5    concurrent retries of the same claim credit exactly once.
#   6    app_config.disable_payouts (withdrawals) and payouts_enabled
#        (reward credit) work independently.
#   7    ordinary organizer withdrawals behave exactly as before.
#
# Builds on the same throwaway schema as
# run-representative-rewards-verification.sh (schema-vents-earn.sql,
# 0193/0196/0197, schema-representative-rewards.sql with the live
# maker-checker and payout functions), then applies 0201. auth.uid() reads
# the test.uid GUC; client calls run under SET ROLE authenticated.
#
# SAFETY: this script only ever talks to the local PostgreSQL server over its
# Unix socket, as the local `postgres` OS user, in a database it creates and
# drops itself. It refuses to start if the environment points anywhere else
# (see "Production safeguards" below) and verifies the connection before
# running a single test statement. It never reads .env files.
#
# Usage: scripts/local-pg-test/run-payout-gate-audit.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_payout_gate_audit"
SOCKET_DIR="/var/run/postgresql"

# ---------------------------------------------------------------------------
# Production safeguards
# ---------------------------------------------------------------------------
die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }

# 1. Nothing in the environment may point at a hosted database. Connection
#    strings and libpq variables are checked by name, and every value is
#    scanned for hosted-Postgres hostnames.
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then
    die "\$$var is set. Unset it; this audit only connects to the local Unix socket."
  fi
done
if env | grep -qiE 'supabase\.(co|com)|pooler\.|rds\.amazonaws\.com|neon\.tech|render\.com'; then
  die "an environment variable references a hosted database host."
fi

# 2. Only a fixed, clearly disposable database name is ever created/dropped.
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z_]+$ ]] || die "database name '$DB_NAME' is not a local test name."

# 3. Connect only through the local Unix socket, as the local postgres OS
#    user, with every libpq default cleared (sudo already resets the
#    environment; env -i makes that explicit).
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || die "no local PostgreSQL socket at $SOCKET_DIR (start it: pg_ctlcluster 16 main start)."
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }
PSQL=(pg -d "$DB_NAME")

# 4. Prove the server is local and not a Supabase-managed instance before
#    creating anything: a Unix-socket connection has no server address, and
#    a hosted Supabase cluster has the supabase_admin role.
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || die "connection is not a local, non-Supabase PostgreSQL server ($server_check)."

OUT=$(mktemp); ERR=$(mktemp)
cleanup() {
  rm -f "$OUT" "$ERR"
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------
REP="00000000-0000-0000-0000-0000000aa001"
ORG="00000000-0000-0000-0000-0000000aa002"
ORG_ADMIN="00000000-0000-0000-0000-0000000aa003"   # an admin who is also the referred organizer
REP2="00000000-0000-0000-0000-0000000aa004"
ADMIN_A="00000000-0000-0000-0000-0000000aa010"
ADMIN_B="00000000-0000-0000-0000-0000000aa011"
SUB="00000000-0000-0000-0000-0000000aa012"
PLAIN_ORG="00000000-0000-0000-0000-0000000aa020"    # an ordinary organizer with ticket revenue
OTHER="00000000-0000-0000-0000-0000000aa030"
E1="00000000-0000-0000-0000-0000000ee001"; E2="00000000-0000-0000-0000-0000000ee002"; E3="00000000-0000-0000-0000-0000000ee003"
REP_BANK="00000000-0000-0000-0000-0000000bb001"; ORG_BANK="00000000-0000-0000-0000-0000000bb003"

FAILS=0
PASSES=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }

# as <uid> <sql>: run <sql> as an authenticated client
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_ok() {
  if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi
}
expect_error() {
  local label="$1" expected="$2" sql="$3"
  if "${PSQL[@]}" -c "$sql" >"$OUT" 2>"$ERR"; then fail "$label (expected an exception, call succeeded)"; return; fi
  if grep -q -- "$expected" "$ERR"; then pass "$label"; else fail "$label (wrong error)"; cat "$ERR" >&2; fi
}
expect_value() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi
}
# request <admin> <action_type> <payload json> -> request id
request() { val "$(as "$1" "SELECT public.request_admin_action('$2', 'vents_earn', NULL, 'test', '$3'::jsonb)->>'id';")"; }
approve() { as "$1" "SELECT public.approve_admin_action('$2');"; }
# earn <uid> -> available/pending/withdrawn/earned, or "none" when no earnings wallet row exists
earn() { val "SELECT COALESCE((SELECT balance_kobo || '/' || pending_kobo || '/' || total_withdrawn_kobo || '/' || total_earned_kobo FROM public.organizer_wallets WHERE organizer_id = '$1'), 'none');"; }

echo "== Building throwaway database $DB_NAME (local socket only) =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null

"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name) VALUES
  ('$REP', 'user', false, 'Rep'), ('$REP2', 'user', false, 'Rep Two'), ('$ORG', 'user', true, 'Org'),
  ('$ORG_ADMIN', 'admin', true, 'Org Admin'), ('$ADMIN_A', 'admin', false, 'Admin A'), ('$ADMIN_B', 'admin', false, 'Admin B'),
  ('$SUB', 'sub-admin', false, 'Sub'), ('$PLAIN_ORG', 'user', true, 'Plain Org'), ('$OTHER', 'user', false, 'Other');
-- Rule 4: rewards need an approved organizer verification. Every
-- organizer starts verified; the negative case is tested explicitly.
INSERT INTO public.organizer_verification_requests (user_id, status)
  SELECT id, 'approved' FROM public.users WHERE is_organizer;
UPDATE public.users SET is_verified = true WHERE is_organizer;  -- as admin_approve_organizer_verification does
SQL
for r in "$REP" "$REP2"; do "${PSQL[@]}" -q -c "$(as "$r" "SELECT public.register_as_recruiter('R', NULL);")" >/dev/null; done
link() {  # link <representative> <organizer>: invite + accept, which attributes the organizer
  "${PSQL[@]}" -q -c "$(as "$1" "SELECT public.invite_recruiter_partnership('$2', NULL, 10000);")" >/dev/null
  local pp; pp=$(val "SELECT id FROM public.recruiter_partnerships WHERE organizer_id = '$2' AND recruiter_id = '$1';")
  "${PSQL[@]}" -q -c "$(as "$2" "SELECT public.respond_to_recruiter_invitation('$pp', true);")" >/dev/null
}
link "$REP" "$ORG"
link "$REP2" "$ORG_ADMIN"
"${PSQL[@]}" -q <<SQL
INSERT INTO public.events (id, organizer_id, title, event_date, end_date) VALUES
  ('$E1', '$ORG', 'E1', now() - interval '40 days', now() - interval '30 days'),
  ('$E2', '$ORG_ADMIN', 'E2', now() - interval '40 days', now() - interval '30 days'),
  ('$E3', '$PLAIN_ORG', 'E3', now() - interval '40 days', now() - interval '30 days');
INSERT INTO public.tickets (id, event_id, amount, payment_status) VALUES
  ('00000000-0000-0000-0000-0000000ff001', '$E1', 10000, 'paid'),
  ('00000000-0000-0000-0000-0000000ff003', '$E3', 30000, 'paid');
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, ticket_sale_id, metadata) VALUES
  ('$ORG', 'credit', 1000000, '00000000-0000-0000-0000-0000000ff001', '{"buyer_fee_kobo": 20000000}'),
  ('$PLAIN_ORG', 'credit', 3000000, '00000000-0000-0000-0000-0000000ff003', '{"buyer_fee_kobo": 150000}');
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo) VALUES ('$PLAIN_ORG', 3000000, 3000000);
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, recipient_code, is_default) VALUES
  ('$ORG_BANK', '$PLAIN_ORG', 'Bank', 'RCP_org', true),
  ('$REP_BANK', '$REP', 'Bank', 'RCP_rep', true);
SQL
"${PSQL[@]}" -q -c "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_update_settings '{"legacy_commission_reconciled": true, "note": "x"}')")" >/dev/null
"${PSQL[@]}" -q -c "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_recognize_event_profit "{\"event_id\":\"$E1\",\"cost_deductions_kobo\":0,\"note\":\"x\"}")")" >/dev/null
"${PSQL[@]}" -q -c "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG', '$E1');")" >/dev/null
C1=$(val "SELECT id FROM public.representative_reward_claims WHERE organizer_id = '$ORG';")
"${PSQL[@]}" -q -c "$(as "$ORG" "SELECT public.respond_to_representative_reward_claim('$C1', true);")" >/dev/null

echo "== Checks 3/4: dual control and parties =="
R=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C1\",\"event_verified\":true}")
expect_error "same admin cannot request and approve" "Cannot approve your own request" "$(approve "$ADMIN_A" "$R")"
expect_error "sub-admin cannot be the approving admin" "Super Admin access required" "$(approve "$SUB" "$R")"
expect_error "the representative (not an admin) cannot approve" "Super Admin access required" "$(approve "$REP" "$R")"
expect_error "executor not callable directly, even by an admin" "permission denied" "$(as "$ADMIN_B" "SELECT public.earn_execute_admin_action('$R');")"
expect_error "admin_action_requests cannot be forged by direct insert" "permission denied" \
  "$(as "$ADMIN_A" "INSERT INTO public.admin_action_requests (action_type, payload, requested_by) VALUES ('earn_approve_reward', '{}', '$ADMIN_B');")"
expect_error "a pending request cannot be re-attributed to another admin" "permission denied" \
  "$(as "$ADMIN_A" "UPDATE public.admin_action_requests SET requested_by = '$ADMIN_B' WHERE id = '$R';")"
expect_ok "two distinct admins approve" "$(approve "$ADMIN_B" "$R")"
expect_error "an approved request cannot be approved again" "Request already approved" "$(approve "$ADMIN_B" "$R")"
"${PSQL[@]}" -q -c "$(as "$REP2" "SELECT public.submit_representative_reward_claim('$ORG_ADMIN', '$E2');")" >/dev/null
C2=$(val "SELECT id FROM public.representative_reward_claims WHERE organizer_id = '$ORG_ADMIN';")
"${PSQL[@]}" -q -c "$(as "$ORG_ADMIN" "SELECT public.respond_to_representative_reward_claim('$C2', true);")" >/dev/null
R2=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C2\",\"event_verified\":true,\"free_event_verified\":true}")
expect_error "the organizer (an admin) cannot approve a reward for their own referral" "cannot request or approve their own reward" "$(approve "$ORG_ADMIN" "$R2")"
R2B=$(request "$ORG_ADMIN" earn_approve_reward "{\"claim_id\":\"$C2\",\"event_verified\":true,\"free_event_verified\":true}")
expect_error "the organizer (an admin) cannot request approval of it either" "cannot request or approve their own reward" "$(approve "$ADMIN_B" "$R2B")"

echo "== Checks 1/2: the reward-credit gate =="
expect_value "claim with payouts_enabled=false only reserves" \
  "$(val "$(as "$REP" "SELECT public.claim_representative_reward('$C1', '11111111-1111-1111-1111-111111111111')->>'status';")")/$(earn "$REP")" "funded/none"
expect_error "clients cannot flip earn_settings directly" "permission denied" "$(as "$ADMIN_A" "UPDATE public.earn_settings SET payouts_enabled = true;")"
expect_error "clients cannot write organizer_wallets (admin policy has no table grant)" "permission denied" \
  "$(as "$ADMIN_A" "UPDATE public.organizer_wallets SET balance_kobo = balance_kobo + 1 WHERE organizer_id = '$PLAIN_ORG';")"
expect_error "clients cannot insert a reward ledger row" "permission denied" \
  "$(as "$ADMIN_A" "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, metadata) VALUES ('$REP', 'representative_reward', 5000000, jsonb_build_object('representative_reward_claim_id', '$C1'));")"
expect_error "client cannot call earn_pool_move" "permission denied" "$(as "$ADMIN_A" "SELECT public.earn_pool_move('credit', 5000000, NULL, '$C1', NULL);")"
expect_error "client cannot call earn_execute_admin_action" "permission denied" "$(as "$ADMIN_A" "SELECT public.earn_execute_admin_action('$R');")"
expect_error "request_admin_action has no direct wallet-credit action" "Unknown action_type" \
  "$(as "$ADMIN_A" "SELECT public.request_admin_action('credit_earnings_wallet', 'x', NULL, 'x', '{}'::jsonb);")"
expect_value "retrying the claim while disabled still credits nothing" \
  "$(val "$(as "$REP" "SELECT public.claim_representative_reward('$C1', gen_random_uuid())->>'status';")")/$(earn "$REP")" "funded/none"
expect_error "an unapproved claim cannot be credited by claiming" "cannot be claimed" "$(as "$REP2" "SELECT public.claim_representative_reward('$C2', gen_random_uuid());")"

echo "== Check 5: concurrent retries on the same claim (reward credit on, withdrawals off) =="
"${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = true;"
"${PSQL[@]}" -q -c "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_update_settings '{"payouts_enabled": true, "note": "x"}')")" >/dev/null
for _ in 1 2 3 4 5 6; do
  ( "${PSQL[@]}" -tA -c "$(as "$REP" "SELECT public.claim_representative_reward('$C1', gen_random_uuid())->>'status';")" >/dev/null 2>&1 || true ) &
done
wait
expect_value "six concurrent claims: one credit, one ledger row, one pool move" \
  "$(earn "$REP")/$(val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'representative_reward';")/$(val "SELECT count(*) FROM public.earn_profit_ledger WHERE claim_id = '$C1' AND entry_type = 'credit';")" \
  "5000000/0/0/5000000/1/1"

echo "== Check 6: the two switches are independent =="
expect_error "global disable_payouts blocks withdrawing the reward" "payouts_disabled" \
  "$(as "$REP" "SELECT public.request_organizer_payout(1000000, '$REP_BANK', 'k');")"
expect_error "global disable_payouts blocks an ordinary organizer too" "payouts_disabled" \
  "$(as "$PLAIN_ORG" "SELECT public.request_organizer_payout(1000000, '$ORG_BANK', 'k');")"
"${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = false;"
"${PSQL[@]}" -q -c "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_update_settings '{"payouts_enabled": false, "note": "x"}')")" >/dev/null
expect_value "turning reward credit off does not block withdrawing already-credited money" \
  "$(val "$(as "$REP" "SELECT (public.request_organizer_payout(1000000, '$REP_BANK', 'k1') IS NOT NULL)::text;")")/$(earn "$REP")" \
  "true/4000000/1000000/0/5000000"

echo "== Check 7: ordinary organizer withdrawals unchanged =="
W=$(val "$(as "$PLAIN_ORG" "SELECT public.request_organizer_payout(1000000, '$ORG_BANK', 'org-k1');")")
expect_value "organizer withdrawal holds funds exactly as before" "$(earn "$PLAIN_ORG")" "2000000/1000000/0/3000000"
expect_value "organizer withdrawal completes exactly as before" \
  "$(val "SELECT status FROM public.complete_organizer_payout('$W');")/$(earn "$PLAIN_ORG")" "completed/2000000/0/1000000/3000000"
expect_value "organizer ledger only has its own credit and payout rows" \
  "$(val "SELECT string_agg(type, ',' ORDER BY type) FROM public.organizer_transactions WHERE organizer_id = '$PLAIN_ORG';")" "credit,payout"
expect_ok "a ticket credit (type 'credit') still inserts under the widened type check" \
  "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, ticket_sale_id) VALUES ('$PLAIN_ORG', 'credit', 1, '00000000-0000-0000-0000-0000000ff003');"

echo
EXPECTED_CHECKS=27
if [ "$FAILS" -eq 0 ] && [ "$PASSES" -eq "$EXPECTED_CHECKS" ]; then
  echo "ALL $PASSES/$EXPECTED_CHECKS PAYOUT-GATE AUDIT CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED, $PASSES/$EXPECTED_CHECKS PASSED"
  exit 1
fi
