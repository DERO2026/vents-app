#!/usr/bin/env bash
# Real-execution verification of migration 0213 (the VENTS Admin is the sole
# final payout authority; every payout needs the 10-digit Admin Payout PIN):
#
#   PIN        root only; 10 digits; confirmation; weak PINs; needs a password
#              entered in the last 5 minutes (amr); bcrypt cost 12 bound to the
#              root id; never readable; wrong PIN counted and committed; lock
#              after 5; reset required after 3 locks; a change pauses payouts
#              for an hour; notifications;
#   Path A     the VENTS Admin approves and pays with no review at all;
#   Path B     sub-admin / admin review (forward or recommend rejection), then
#              the VENTS Admin approves and pays;
#   bypasses   signed-out, users, sub-admins and admins cannot approve, verify
#              a PIN or claim; the old claim, the 0211 two-admin functions,
#              Admin Actions and raw UPDATEs cannot start a payout; a PIN
#              authorizes exactly one withdrawal, amount and bank account,
#              once; replays and concurrent clicks never claim twice; a bank
#              change after review or approval blocks payment;
#   Paystack   claim -> processing; success -> paid; failure -> money back;
#   and the ledger reconciles, 0213 is idempotent, undo_0213 restores the
#   exact 0211+0212 state (refusing while a VENTS-Admin-only approval is
#   open) and 0213 re-applies to the same state.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
#
# Usage: scripts/local-pg-test/run-payout-authorization-verification.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_payout_auth"
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

ORG="00000000-0000-0000-0000-000000000a01"      # organizer (withdraws)
ORG2="00000000-0000-0000-0000-000000000a02"     # second organizer
ORG_ADMIN="00000000-0000-0000-0000-000000000a03" # a full admin who also earns
ADMIN_A="00000000-0000-0000-0000-000000000b01"
ADMIN_B="00000000-0000-0000-0000-000000000b02"
SUB="00000000-0000-0000-0000-000000000b03"
SUB2="00000000-0000-0000-0000-000000000b04"
USER="00000000-0000-0000-0000-000000000c01"     # no wallet, not an admin
ROOT="c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832"     # the VENTS Super Admin (is_root)
BANK_R="00000000-0000-0000-0000-000000000d09"
BANK="00000000-0000-0000-0000-000000000d01"
BANK2="00000000-0000-0000-0000-000000000d02"
BANK_OA="00000000-0000-0000-0000-000000000d03"

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
# as_jwt <uid> <jwt json> <sql>: the caller's access-token claims (auth.jwt()).
as_jwt() { printf "SET test.uid='%s'; SET test.jwt='%s'; SET ROLE authenticated; %s" "$1" "$2" "$3"; }
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
expect_error() {
  if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an exception, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error)"; cat "$ERR" >&2; fi
}
now() { date +%s; }
wallet() { val "SELECT balance_kobo || '/' || pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$1';"; }
# request_withdrawal as <uid>: amount, bank, pin, key -> the jsonb result's code (or ok)
withdraw() { val "$(as "$1" "SELECT COALESCE(r->>'code', 'ok') FROM (SELECT public.request_withdrawal($2, '$3', '$4', '$5') r) s;")"; }
withdraw_id() { val "$(as "$1" "SELECT r->>'request_id' FROM (SELECT public.request_withdrawal($2, '$3', '$4', '$5') r) s;")"; }
stage_for() { val "$(as "$1" "SELECT stage FROM public.admin_list_withdrawals('all') WHERE request_id = '$2';")"; }
my_stage() { val "$(as "$1" "SELECT stage FROM public.get_my_withdrawals() WHERE request_id = '$2';")"; }
first() { as "$1" "SELECT public.admin_first_approve_withdrawal('$2', $3);"; }
second() { as "$1" "SELECT public.admin_approve_withdrawal('$2');"; }
claim() { val "$(as "$1" "SELECT claimed::text FROM public.admin_claim_payout_for_processing('$2');")"; }
reconciled() { val "$(as "$ADMIN_A" "SELECT count(*) FILTER (WHERE ledger_gap_kobo <> 0 OR pending_gap_kobo <> 0 OR 'negative_balance' = ANY(issues)) FROM public.admin_earnings_reconciliation();")"; }

echo "== Building throwaway database $DB_NAME (0193..0210 stack) =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
"${PSQL[@]}" -q -c "SET vents.migration_local_test = 'on';" -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) TO authenticated;
-- Production's grants on the withdrawal entry point (0123).
REVOKE ALL ON FUNCTION public.request_organizer_payout(bigint, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_organizer_payout(bigint, uuid, text) TO authenticated;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone_number text;
-- Supabase's auth.jwt() (the access token's claims), driven by a session
-- setting here, and the live assert_recent_auth (0004, verbatim) that 0211
-- replaces.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
\$\$ SELECT COALESCE(NULLIF(current_setting('test.jwt', true), ''), '{}')::jsonb \$\$;
GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;
SQL
"${PSQL[@]}" -q -c "$(awk '/^-- Function: assert_recent_auth$/{f=1;next} f&&/^-- Function:/{exit} f' "$MIG/0004_functions.sql")"
for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment \
         0208_ticket_fee_1_5_3_5 0209_representative_referral_links 0210_referral_connections; do
  expect_ok "$m applies" "$(cat "$MIG/$m.sql")"
done
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email, username) VALUES
  ('$ORG', 'user', true, 'Ada Organizer', 'ada@example.test', 'ada'),
  ('$ORG2', 'user', true, 'Bola Organizer', 'bola@example.test', 'bola'),
  ('$ORG_ADMIN', 'admin', true, 'Chi AdminEarner', 'chi@example.test', 'chi'),
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test', 'admin_a'),
  ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test', 'admin_b'),
  ('$SUB', 'sub-admin', false, 'Sub One', 's1@example.test', 'sub1'),
  ('$SUB2', 'sub-admin', false, 'Sub Two', 's2@example.test', 'sub2'),
  ('$USER', 'user', false, 'Plain User', 'u@example.test', 'plain'),
  ('$ROOT', 'admin', true, 'VENTS Admin', 'root@example.test', 'vents');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES
  ('$BANK', '$ORG', 'GTBank', '058', '0123456789', 'ADA ORGANIZER', 'RCP_ada', true),
  ('$BANK2', '$ORG2', 'Access', '044', '0987654321', 'BOLA ORGANIZER', 'RCP_bola', true),
  ('$BANK_OA', '$ORG_ADMIN', 'Zenith', '057', '0111111111', 'CHI', 'RCP_chi', true),
  ('$BANK_R', '$ROOT', 'Kuda', '090', '0222222222', 'VENTS', 'RCP_root', true);
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo) VALUES
  ('$ORG', 10000000, 0, 10000000), ('$ORG2', 5000000, 0, 5000000), ('$ORG_ADMIN', 2000000, 0, 2000000), ('$ROOT', 1000000, 0, 1000000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES
  ('$ORG', 'credit', 10000000, 'ticket sales'), ('$ORG2', 'credit', 5000000, 'ticket sales'),
  ('$ORG_ADMIN', 'credit', 2000000, 'ticket sales'), ('$ROOT', 'credit', 1000000, 'ticket sales');
SQL

STATE_SQL="SELECT md5(string_agg(p.oid::regprocedure::text || ':' || p.prosrc || ':' || COALESCE(array_to_string(p.proacl, ','), ''), '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT md5(string_agg(conrelid::regclass::text || conname || pg_get_constraintdef(oid), '|' ORDER BY conrelid::regclass::text, conname)) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text NOT LIKE '%withdrawal_pin%') || '/' || (SELECT md5(string_agg(table_name || '.' || column_name || COALESCE(column_default, ''), '|' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema = 'public' AND table_name NOT LIKE 'withdrawal_pin%') || '/' || (SELECT md5(string_agg(tgrelid::regclass::text || tgname, '|' ORDER BY tgrelid::regclass::text, tgname)) FROM pg_trigger WHERE NOT tgisinternal) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"

# 0213 adds tables/columns it keeps on rollback (PIN hashes, reviews,
# authorizations: audit data); compare everything else.
KEEP_RE="withdrawal_reviews|admin_payout_pin|payout_authorizations"
STATE13_SQL="SELECT md5(string_agg(p.oid::regprocedure::text || ':' || p.prosrc || ':' || COALESCE(array_to_string(p.proacl, ','), ''), '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT md5(string_agg(conrelid::regclass::text || conname || pg_get_constraintdef(oid), '|' ORDER BY conrelid::regclass::text, conname)) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text NOT LIKE '%withdrawal_pin%' AND conrelid::regclass::text !~ '$KEEP_RE' AND conname NOT IN ('organizer_withdrawal_requests_payout_authorization_fk', 'organizer_withdrawal_requests_two_admins', 'organizer_withdrawal_requests_approval_parties')) || '/' || (SELECT md5(string_agg(table_name || '.' || column_name || COALESCE(column_default, ''), '|' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema = 'public' AND table_name NOT LIKE 'withdrawal_pin%' AND table_name !~ '$KEEP_RE' AND column_name NOT IN ('approved_bank_account_id', 'payout_authorization_id')) || '/' || (SELECT md5(string_agg(tgrelid::regclass::text || tgname, '|' ORDER BY tgrelid::regclass::text, tgname)) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text !~ '$KEEP_RE') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'payout_audit_row_immutable';"

echo "== Applying 0211 and 0212 =="
expect_ok "0211 applies" "$(cat "$MIG/0211_withdrawal_pin_and_two_admin_approval.sql")"
expect_ok "0212 applies" "$(cat "$MIG/0212_old_app_withdrawal_update_required.sql")"
# Production's grants on the old claim (pg_proc.proacl, 2026-11-10): postgres,
# authenticated, project_admin; no PUBLIC. Mirrored so the rollback is
# compared with the real starting point.
"${PSQL[@]}" -q -c "REVOKE ALL ON FUNCTION public.admin_claim_payout_for_processing(uuid) FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) TO authenticated, project_admin;"
PRE_0213=$(val "$STATE13_SQL")
FN_LIST="SELECT p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || COALESCE(array_to_string(p.proacl, ','), '-') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'payout_audit_row_immutable' ORDER BY 1;"
"${PSQL[@]}" -tA -c "$FN_LIST" > "$TMP/fn_pre"

echo "== Applying 0213 =="
M13="$MIG/0213_vents_admin_payout_authorization.sql"
expect_ok "0213 applies on top of 0211 and 0212 (drift guards pass)" "$(cat "$M13")"
POST_0213=$(val "$STATE13_SQL")
expect_ok "0213 is idempotent (second run)" "$(cat "$M13")"
expect_value "a second run of 0213 changes nothing" "$(val "$STATE13_SQL")" "$POST_0213"

pw() { printf '{"amr": [{"method": "password", "timestamp": %s}]}' "$(( $(now) - ${1:-0} ))"; }
asroot() { as_jwt "$ROOT" "$(pw)" "$1"; }
# Unique per call (each $(newkey) runs in its own subshell).
newkey() { echo "payout-key-$(date +%s%N)-$RANDOM$RANDOM"; }
pay() { val "$(as "$ROOT" "SELECT COALESCE(CASE WHEN (r->>'ok')::boolean THEN 'claimed:' || (r->>'claimed') ELSE r->>'code' END, 'none') FROM (SELECT public.admin_authorize_and_claim_payout('$1', $2, '$3', '$4') r) s;")"; }
stage13() { val "$(as "$1" "SELECT stage FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$2';")"; }
PIN="4826193057"

echo "== 1. Admin Payout PIN =="
for who in "$ADMIN_A" "$SUB" "$USER"; do
  expect_error "PIN status is VENTS Admin only ($who)" "VENTS Admin access required" "$(as "$who" "SELECT public.admin_payout_pin_status();")"
  expect_error "PIN creation is VENTS Admin only, even with a password ($who)" "VENTS Admin access required" "$(as_jwt "$who" "$(pw)" "SELECT public.admin_set_payout_pin('$PIN', '$PIN');")"
done
expect_error "signed out: no PIN status" "VENTS Admin access required\|permission denied" "SET ROLE anon; SELECT public.admin_payout_pin_status();"
expect_error "creating the PIN needs a password entered just now" "PASSWORD_CONFIRMATION_REQUIRED" "$(as "$ROOT" "SELECT public.admin_set_payout_pin('$PIN', '$PIN');")"
expect_error "...a password from an hour ago is refused" "PASSWORD_CONFIRMATION_REQUIRED" "$(as_jwt "$ROOT" "$(pw 3600)" "SELECT public.admin_set_payout_pin('$PIN', '$PIN');")"
expect_error "PIN must be 10 digits (9)" "exactly 10 digits" "$(asroot "SELECT public.admin_set_payout_pin('482619305', '482619305');")"
expect_error "PIN must be 10 digits (letters)" "exactly 10 digits" "$(asroot "SELECT public.admin_set_payout_pin('48261930a7', '48261930a7');")"
expect_error "PIN must be confirmed" "do not match" "$(asroot "SELECT public.admin_set_payout_pin('$PIN', '4826193058');")"
for weak in 0000000000 0123456789 9876543210 1212121212 1234512345 3456789012; do
  expect_error "weak PIN $weak refused" "too easy to guess" "$(asroot "SELECT public.admin_set_payout_pin('$weak', '$weak');")"
done
expect_value "PIN created" "$(val "$(asroot "SELECT public.admin_set_payout_pin('$PIN', '$PIN')->>'has_pin';")")" "true"
expect_value "stored as bcrypt cost 12, bound to the root id, never the PIN" \
  "$(val "SELECT (pin_hash LIKE '\$2a\$12\$%' AND position('$PIN' IN pin_hash) = 0 AND length(pin_hash) = 60)::text || '/' || public.admin_payout_pin_matches('$ADMIN_A', '$PIN', pin_hash)::text || '/' || public.admin_payout_pin_matches('$ROOT', '$PIN', pin_hash)::text FROM public.admin_payout_pins WHERE user_id = '$ROOT';")" "true/false/true"
expect_error "no client can read the PIN table, not even the VENTS Admin" "permission denied for table admin_payout_pins" "$(as "$ROOT" "SELECT pin_hash FROM public.admin_payout_pins;")"
expect_error "no client can call the internal PIN check" "permission denied for function admin_payout_pin_check" "$(as "$ROOT" "SELECT public.admin_payout_pin_check('$ROOT', '$PIN', NULL);")"
expect_value "the status never contains the PIN or hash" "$(val "$(as "$ROOT" "SELECT (position('$PIN' IN public.admin_payout_pin_status()::text) = 0 AND position('\$2a\$' IN public.admin_payout_pin_status()::text) = 0)::text;")")" "true"
expect_value "the VENTS account was notified" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ROOT' AND title = 'Admin Payout PIN created';")" "1"
expect_value "PIN events are audited (no PIN data)" "$(val "SELECT string_agg(event, ',') FROM public.admin_payout_pin_events WHERE user_id = '$ROOT';")" "created"

echo "== 2. Path A: the VENTS Admin pays with no review =="
"${PSQL[@]}" -q -c "$(as "$ORG" "SELECT public.set_my_withdrawal_pin('7391', '7391');")" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ORG2" "SELECT public.set_my_withdrawal_pin('4826', '4826');")" >/dev/null
W1=$(withdraw_id "$ORG" 3000000 "$BANK" 7391 k-w1)
expect_value "a withdrawal is requested (₦30,000 to pending)" "$([ -n "$W1" ] && echo yes)/$(wallet "$ORG")" "yes/7000000/3000000"
expect_value "stage: pending review, for everyone" "$(stage13 "$SUB" "$W1")/$(stage13 "$ROOT" "$W1")/$(val "$(as "$ORG" "SELECT stage FROM public.get_my_withdrawals() WHERE request_id = '$W1';")")" "pending_review/pending_review/pending_review"
expect_value "the user is told VENTS reviews it (not two admins)" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND title = 'Withdrawal requested' AND body LIKE '%review by VENTS.%';")" "1"
for who in "$ADMIN_A" "$SUB" "$USER" "$ORG"; do
  expect_error "only the VENTS Admin approves for payment ($who)" "VENTS Admin access required" "$(as "$who" "SELECT public.admin_approve_withdrawal_for_payment('$W1', 3000000);")"
  expect_error "only the VENTS Admin can authorize & pay ($who)" "VENTS Admin access required" "$(as "$who" "SELECT public.admin_authorize_and_claim_payout('$W1', 3000000, '$PIN', '$(newkey)');")"
done
expect_value "authorize & pay before approval: refused (not approved)" "$(pay "$W1" 3000000 "$PIN" "$(newkey)")" "not_approved"
expect_error "approval for a different amount refused" "does not match" "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$W1', 100);")"
expect_value "the VENTS Admin approves directly (no review)" "$(val "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$W1', 3000000)->>'stage';")")" "vents_admin_approved"
expect_value "approval recorded: VENTS Admin, recipient, bank account; no 0211 request; no reviewer" \
  "$(val "SELECT (approved_by = '$ROOT' AND approved_recipient_code = 'RCP_ada' AND approved_bank_account_id = '$BANK' AND approval_request_id IS NULL AND approval_requested_by IS NULL)::text FROM public.organizer_withdrawal_requests WHERE id = '$W1';")" "true"
expect_value "the user sees it approved and was told" "$(val "$(as "$ORG" "SELECT stage FROM public.get_my_withdrawals() WHERE request_id = '$W1';")")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND title = 'Withdrawal approved';")" "vents_admin_approved/1"
expect_error "a second approval is refused" "already approved" "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$W1', 3000000);")"
expect_error "the approval cannot be cleared by a raw UPDATE" "cannot be changed or cleared" "UPDATE public.organizer_withdrawal_requests SET approved_by = NULL WHERE id = '$W1';"
echo "-- every other path to 'processing' is closed --"
expect_error "old claim: no client role may call it" "permission denied for function admin_claim_payout_for_processing" "$(as "$ROOT" "SELECT * FROM public.admin_claim_payout_for_processing('$W1');")"
expect_error "old claim run as the owner still cannot skip the PIN (guard)" "needs the VENTS Admin Payout PIN" "SET test.uid = '$ROOT'; SELECT * FROM public.admin_claim_payout_for_processing('$W1');"
expect_error "raw UPDATE to processing refused (guard)" "needs the VENTS Admin Payout PIN" "UPDATE public.organizer_withdrawal_requests SET status = 'processing' WHERE id = '$W1';"
expect_error "0211 second approval is closed" "permission denied for function admin_approve_withdrawal" "$(as "$ADMIN_A" "SELECT public.admin_approve_withdrawal('$W1');")"
expect_error "0211 first approval is closed" "permission denied for function admin_first_approve_withdrawal" "$(as "$SUB" "SELECT public.admin_first_approve_withdrawal('$W1', 3000000);")"
expect_error "Admin Actions 'authorize_withdrawal' is closed" "moved to Payouts" \
  "$(as "$ADMIN_A" "SELECT public.request_admin_action('authorize_withdrawal', 'withdrawal', '$W1', 'x', '{\"request_id\":\"$W1\",\"amount_kobo\":3000000}'::jsonb);")"
expect_error "the old entry point still only says update the app (0212)" "Please update VENTS to withdraw" "$(as "$ORG" "SELECT public.request_organizer_payout(500000, '$BANK', 'old');")"
echo "-- the PIN --"
expect_value "wrong PIN: refused, 4 attempts left" "$(val "$(as "$ROOT" "SELECT public.admin_authorize_and_claim_payout('$W1', 3000000, '1111111112', '$(newkey)')->>'attempts_left';")")" "4"
expect_value "...the attempt is committed and nothing moved" "$(val "SELECT failed_attempts FROM public.admin_payout_pins WHERE user_id = '$ROOT';")/$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '$W1';")/$(val "SELECT count(*) FROM public.payout_authorizations;")" "1/pending/0"
expect_value "a malformed PIN counts as wrong" "$(pay "$W1" 3000000 "12345" "$(newkey)")" "wrong_pin"
expect_error "a missing idempotency key is refused" "idempotency key" "$(as "$ROOT" "SELECT public.admin_authorize_and_claim_payout('$W1', 3000000, '$PIN', 'short');")"
expect_error "authorizing a different amount is refused" "does not match" "$(as "$ROOT" "SELECT public.admin_authorize_and_claim_payout('$W1', 2999999, '$PIN', '$(newkey)');")"
K1=$(newkey)
expect_value "correct PIN: claimed for Paystack" "$(pay "$W1" 3000000 "$PIN" "$K1")" "claimed:true"
expect_value "processing with the fixed reference; the PIN counter is reset" \
  "$(val "SELECT status || '|' || (paystack_reference = 'payout_' || replace(id::text, '-', ''))::text FROM public.organizer_withdrawal_requests WHERE id = '$W1';")/$(val "SELECT failed_attempts FROM public.admin_payout_pins WHERE user_id = '$ROOT';")" "processing|true/0"
expect_value "the authorization is bound to this request, amount, bank account, recipient and the VENTS Admin" \
  "$(val "SELECT (a.request_id = '$W1' AND a.amount_kobo = 3000000 AND a.bank_account_id = '$BANK' AND a.recipient_code = 'RCP_ada' AND a.admin_id = '$ROOT' AND a.idempotency_key = '$K1' AND r.payout_authorization_id = a.id)::text FROM public.payout_authorizations a JOIN public.organizer_withdrawal_requests r ON r.id = a.request_id WHERE a.request_id = '$W1';")" "true"
expect_value "replaying the same key never claims again" "$(pay "$W1" 3000000 "$PIN" "$K1")" "claimed:false"
expect_value "a new key for the same request: already processing" "$(pay "$W1" 3000000 "$PIN" "$(newkey)")" "not_pending"
expect_error "authorization rows are immutable" "audit trail" "UPDATE public.payout_authorizations SET amount_kobo = 1 WHERE request_id = '$W1';"
expect_error "...and cannot be deleted" "audit trail" "DELETE FROM public.payout_authorizations WHERE request_id = '$W1';"
expect_value "user and admins see processing (not paid)" "$(stage13 "$SUB" "$W1")/$(val "$(as "$ORG" "SELECT stage FROM public.get_my_withdrawals() WHERE request_id = '$W1';")")" "processing/processing"
"${PSQL[@]}" -q -c "SELECT * FROM public.complete_organizer_payout((SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$W1'));" >/dev/null
expect_value "Paystack transfer.success -> paid; ledger reconciles" "$(stage13 "$ROOT" "$W1")/$(wallet "$ORG")/$(reconciled)" "paid/7000000/0/0"

echo "== 3. Path B: reviewed, then the VENTS Admin pays =="
W2=$(withdraw_id "$ORG2" 1000000 "$BANK2" 4826 k-w2)
expect_error "a review needs a note" "review note" "$(as "$SUB" "SELECT public.admin_review_withdrawal('$W2', 1000000, 'forward', '');")"
expect_error "a review for a different amount is refused" "does not match" "$(as "$SUB" "SELECT public.admin_review_withdrawal('$W2', 1, 'forward', 'Checked the bank account');")"
expect_error "a plain user cannot review" "Admin access required" "$(as "$USER" "SELECT public.admin_review_withdrawal('$W2', 1000000, 'forward', 'ok ok');")"
expect_error "the VENTS Admin does not review (approves or rejects directly)" "approves or rejects directly" "$(as "$ROOT" "SELECT public.admin_review_withdrawal('$W2', 1000000, 'forward', 'ok ok');")"
expect_value "a sub-admin reviews and forwards" "$(val "$(as "$SUB" "SELECT public.admin_review_withdrawal('$W2', 1000000, 'forward', 'Bank account matches the profile')->>'stage';")")" "forwarded_to_vents_admin"
expect_value "admins and the VENTS Admin see it forwarded; the user only sees 'in review'" "$(stage13 "$ADMIN_A" "$W2")/$(stage13 "$ROOT" "$W2")/$(val "$(as "$ORG2" "SELECT stage FROM public.get_my_withdrawals() WHERE request_id = '$W2';")")" "forwarded_to_vents_admin/forwarded_to_vents_admin/pending_review"
expect_value "the review history is visible with the reviewer's name, tier and note" \
  "$(val "$(as "$ROOT" "SELECT (reviews->0->>'reviewer_name') || '|' || (reviews->0->>'reviewer_tier') || '|' || (reviews->0->>'note') || '|' || (reviews->0->>'current') FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$W2';")")" "Sub One|sub|Bank account matches the profile|true"
expect_value "the VENTS Admin was notified" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ROOT' AND title = 'Withdrawal forwarded for your approval';")" "1"
expect_error "reviews are immutable" "audit trail" "UPDATE public.withdrawal_reviews SET note = 'changed' WHERE request_id = '$W2';"
expect_value "a second reviewer (admin) can add a review" "$(val "$(as "$ADMIN_A" "SELECT public.admin_review_withdrawal('$W2', 1000000, 'forward', 'Second look: fine')->>'stage';")")" "forwarded_to_vents_admin"
expect_error "a sub-admin cannot approve or pay a forwarded request" "VENTS Admin access required" "$(as "$SUB" "SELECT public.admin_approve_withdrawal_for_payment('$W2', 1000000);")"
expect_error "a sub-admin cannot reject (full admins only, unchanged)" "access required" "$(as "$SUB2" "SELECT public.admin_reject_organizer_payout('$W2', 'x');")"
expect_value "the VENTS Admin approves the forwarded request" "$(val "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$W2', 1000000)->>'stage';")")" "vents_admin_approved"
expect_value "...the forwarding reviewer is recorded" "$(val "SELECT (approval_requested_by = '$ADMIN_A')::text FROM public.organizer_withdrawal_requests WHERE id = '$W2';")" "true"
expect_error "no review after approval" "already approved" "$(as "$SUB2" "SELECT public.admin_review_withdrawal('$W2', 1000000, 'forward', 'late review');")"
expect_value "the VENTS Admin pays it with the PIN" "$(pay "$W2" 1000000 "$PIN" "$(newkey)")" "claimed:true"
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET transfer_code = 'TRF_b' WHERE id = '$W2';"
"${PSQL[@]}" -q -c "SELECT * FROM public.fail_organizer_payout((SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$W2'), 'Paystack transfer.failed');" >/dev/null 2>&1 || true
expect_value "Paystack transfer.failed -> failed (never paid), money back" "$(stage13 "$ROOT" "$W2")/$(wallet "$ORG2")/$(reconciled)" "failed/5000000/0/0"

echo "== 4. Bypass and replay =="
K_W1="$K1"
W3=$(withdraw_id "$ORG" 2000000 "$BANK" 7391 k-w3)
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$W3', 2000000);")" >/dev/null
expect_error "a PIN key used for one withdrawal cannot authorize another" "already used for another withdrawal" "$(as "$ROOT" "SELECT public.admin_authorize_and_claim_payout('$W3', 2000000, '$PIN', '$K_W1');")"
expect_error "an earlier authorization cannot be attached to another withdrawal (raw UPDATE)" "Admin Payout PIN\|authorization can only be set" \
  "SET test.uid = '$ROOT'; UPDATE public.organizer_withdrawal_requests SET status = 'processing', payout_authorization_id = (SELECT id FROM public.payout_authorizations WHERE request_id = '$W1') WHERE id = '$W3';"
expect_error "...nor a fresh-looking authorization inserted by hand in another transaction (txid)" "Admin Payout PIN" \
  "SET test.uid = '$ROOT'; BEGIN; INSERT INTO public.payout_authorizations (id, request_id, admin_id, amount_kobo, bank_account_id, recipient_code, idempotency_key, txid, expires_at) VALUES ('00000000-0000-0000-0000-0000000fa001', '$W3', '$ROOT', 2000000, '$BANK', 'RCP_ada', 'forged-key-000000001', 1, now() + interval '1 hour'); UPDATE public.organizer_withdrawal_requests SET status = 'processing', payout_authorization_id = '00000000-0000-0000-0000-0000000fa001' WHERE id = '$W3'; COMMIT;"
expect_value "W3 is still approved and unpaid" "$(stage13 "$ROOT" "$W3")" "vents_admin_approved"
echo "-- two concurrent Authorize & Pay clicks (different keys) -> one claim --"
for k in c1 c2; do
  ( "${PSQL[@]}" -tA -c "$(as "$ROOT" "SELECT COALESCE(CASE WHEN (r->>'ok')::boolean THEN 'claimed:' || (r->>'claimed') ELSE r->>'code' END, 'none') FROM (SELECT public.admin_authorize_and_claim_payout('$W3', 2000000, '$PIN', 'concurrent-key-$k-000000') r) s;")" > "$TMP/pc_$k" 2>&1 ) &
done
wait
expect_value "exactly one claimed, the other was told it is processing" "$(cat "$TMP/pc_c1" "$TMP/pc_c2" | grep -E '^(claimed:true|not_pending)$' | sort | tr '\n' ',')$(val "SELECT count(*) FROM public.payout_authorizations WHERE request_id = '$W3';")" "claimed:true,not_pending,1"
"${PSQL[@]}" -q -c "SET test.uid = '$ROOT'; SELECT public.admin_release_payout_claim('$W3', 'Paystack: nothing sent');" >/dev/null
expect_error "only the VENTS Admin may release a claim" "VENTS Admin access required" "$(as "$SUB" "SELECT public.admin_release_payout_claim('$W3', 'x');")"
WON_KEY=$(val "SELECT idempotency_key FROM public.payout_authorizations WHERE request_id = '$W3';")
expect_value "after a release (Paystack sent nothing) the old authorization is spent: a new PIN entry is needed" "$(stage13 "$ROOT" "$W3")/$(pay "$W3" 2000000 "$PIN" "$WON_KEY")" "vents_admin_approved/claimed:false"
expect_value "...and a fresh PIN entry claims it" "$(pay "$W3" 2000000 "$PIN" "$(newkey)")" "claimed:true"
"${PSQL[@]}" -q -c "SELECT * FROM public.complete_organizer_payout((SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$W3'));" >/dev/null

echo "== 5. Bank account changes =="
W4=$(withdraw_id "$ORG" 1500000 "$BANK" 7391 k-w4)
"${PSQL[@]}" -q -c "$(as "$SUB" "SELECT public.admin_review_withdrawal('$W4', 1500000, 'forward', 'Looks right');")" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_ada_new' WHERE id = '$BANK';"
expect_value "a bank change after review voids the review (back to pending review)" "$(stage13 "$ROOT" "$W4")/$(val "$(as "$ROOT" "SELECT reviews->0->>'current' FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$W4';")")" "pending_review/false"
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$W4', 1500000);")" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_ada_other' WHERE id = '$BANK';"
expect_value "a bank change after approval blocks payment" "$(pay "$W4" 1500000 "$PIN" "$(newkey)")/$(val "$(as "$ROOT" "SELECT can_authorize_pay::text FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$W4';")")" "bank_changed/false"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_ada' WHERE id = '$BANK';"
expect_value "...the PIN was never consulted for it (no attempt counted)" "$(val "SELECT failed_attempts FROM public.admin_payout_pins WHERE user_id = '$ROOT';")" "0"
expect_ok "a full admin can reject an approved request (money back)" "$(as "$ADMIN_A" "SELECT public.admin_reject_organizer_payout('$W4', 'Bank changed');")"

echo "== 6. Own withdrawal, kill switch, lockout =="
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.set_my_withdrawal_pin('5937', '5937');")" >/dev/null
WR=$(withdraw_id "$ROOT" 500000 "$BANK_R" 5937 k-root)
expect_error "the VENTS Admin cannot approve their own withdrawal" "your own withdrawal" "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$WR', 500000);")"
expect_ok "...an admin can reject it" "$(as "$ADMIN_A" "SELECT public.admin_reject_organizer_payout('$WR', 'own');")"
W5=$(withdraw_id "$ORG" 1100000 "$BANK" 7391 k-w5)
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$W5', 1100000);")" >/dev/null
if "${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = true;" 2>/dev/null && [ "$(val "SELECT public.payouts_disabled()::text;")" = "true" ]; then
  expect_error "kill switch: no payout" "payouts_disabled" "$(as "$ROOT" "SELECT public.admin_authorize_and_claim_payout('$W5', 1100000, '$PIN', '$(newkey)');")"
  "${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = false;"
else echo "info: no app_config kill switch row on this stack; skipped"; fi
for i in 1 2 3 4; do pay "$W5" 1100000 0000000001 "$(newkey)" >/dev/null; done
expect_value "5th wrong PIN locks payouts" "$(pay "$W5" 1100000 0000000001 "$(newkey)")" "pin_locked"
expect_value "while locked the correct PIN is refused" "$(pay "$W5" 1100000 "$PIN" "$(newkey)")" "pin_locked"
expect_value "lock lasts 30 minutes; the VENTS account was told" "$(val "SELECT (locked_until BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes')::text FROM public.admin_payout_pins WHERE user_id = '$ROOT';")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ROOT' AND title = 'Admin Payout PIN locked';")" "true/1"
for lock in 2 3; do
  "${PSQL[@]}" -q -c "UPDATE public.admin_payout_pins SET locked_until = now() - interval '1 second' WHERE user_id = '$ROOT';"
  for i in 1 2 3 4 5; do pay "$W5" 1100000 0000000001 "$(newkey)" >/dev/null; done
done
expect_value "the 3rd lock in a row requires a reset" "$(pay "$W5" 1100000 "$PIN" "$(newkey)")" "pin_reset_required"
expect_value "W5 never moved" "$(stage13 "$ROOT" "$W5")/$(val "SELECT count(*) FROM public.payout_authorizations WHERE request_id = '$W5';")" "vents_admin_approved/0"
expect_error "reset needs the password" "PASSWORD_CONFIRMATION_REQUIRED" "$(as "$ROOT" "SELECT public.admin_set_payout_pin('7391058264', '7391058264');")"
expect_value "reset with the password: unlocked" "$(val "$(asroot "SELECT public.admin_set_payout_pin('7391058264', '7391058264')->>'locked';")")" "false"
expect_value "the old PIN no longer works / a change pauses payouts for an hour" "$(pay "$W5" 1100000 "$PIN" "$(newkey)")" "pin_recently_changed"
expect_value "the VENTS account was told the PIN changed" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ROOT' AND title = 'Admin Payout PIN changed';")" "1"
"${PSQL[@]}" -q -c "UPDATE public.admin_payout_pins SET changed_at = now() - interval '61 minutes' WHERE user_id = '$ROOT';"
expect_value "after the pause the old PIN is wrong" "$(pay "$W5" 1100000 "$PIN" "$(newkey)")" "wrong_pin"
expect_value "...and the new one pays" "$(pay "$W5" 1100000 7391058264 "$(newkey)")" "claimed:true"
"${PSQL[@]}" -q -c "SELECT * FROM public.complete_organizer_payout((SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$W5'));" >/dev/null
expect_value "PIN events audited" "$(val "SELECT string_agg(DISTINCT event, ',' ORDER BY event) FROM public.admin_payout_pin_events WHERE user_id = '$ROOT';")" "changed,created,failed,locked,reset_required,verified"

echo "== 7. One authoritative view and totals =="
W6=$(withdraw_id "$ORG2" 700000 "$BANK2" 4826 k-w6)
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_review_withdrawal('$W6', 700000, 'recommend_reject', 'Name does not match');")" >/dev/null
expect_value "recommend rejection: the VENTS Admin decides" "$(stage13 "$SUB" "$W6")/$(val "$(as "$ROOT" "SELECT can_approve::text || '|' || can_reject::text FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$W6';")")" "rejection_recommended/true|true"
VIEW="SELECT md5(string_agg(request_id::text || stage || status || amount_kobo || COALESCE(approved_by::text, '-'), '|' ORDER BY request_id)) FROM public.admin_list_withdrawals('all', 500)"
expect_value "sub-admins, admins and the VENTS Admin see the same rows and stages" "$(val "$(as "$SUB" "$VIEW")")/$(val "$(as "$ADMIN_A" "$VIEW")")" "$(val "$(as "$ROOT" "$VIEW")")/$(val "$(as "$ROOT" "$VIEW")")"
expect_value "buttons: sub-admin review only; VENTS Admin approve/reject; nobody else pays" \
  "$(val "$(as "$SUB" "SELECT (can_review AND NOT can_approve AND NOT can_authorize_pay AND NOT can_reject)::text FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$W6';")")/$(val "$(as "$ADMIN_A" "SELECT (can_review AND NOT can_approve AND NOT can_authorize_pay AND can_reject)::text FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$W6';")")/$(val "$(as "$ROOT" "SELECT (NOT can_review AND can_approve AND NOT can_authorize_pay AND can_reject)::text FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$W6';")")" "true/true/true"
expect_value "sub-admins see only the masked account number" "$(val "$(as "$SUB" "SELECT COALESCE(account_number, 'hidden') || '|' || account_number_masked FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$W6';")")" "hidden|****4321"
EXPECTED_OUT=$(val "SELECT COALESCE(sum(amount_kobo), 0) FROM public.organizer_withdrawal_requests WHERE status IN ('pending', 'processing');")
expect_value "overview: outstanding = every pending + processing request (server-side)" "$(val "$(as "$SUB" "SELECT public.admin_payout_overview()->>'outstanding_kobo';")")" "$EXPECTED_OUT"
expect_value "overview: paid = every completed request" "$(val "$(as "$ROOT" "SELECT public.admin_payout_overview()->>'paid_kobo';")")" "$(val "SELECT COALESCE(sum(amount_kobo), 0) FROM public.organizer_withdrawal_requests WHERE status = 'completed';")"
expect_value "overview: the same for every role" "$(val "$(as "$SUB" "SELECT (public.admin_payout_overview()->'stages')::text;")")" "$(val "$(as "$ROOT" "SELECT (public.admin_payout_overview()->'stages')::text;")")"
expect_error "overview: admins only" "Admin access required" "$(as "$USER" "SELECT public.admin_payout_overview();")"
expect_error "no client table write can bypass any of this" "permission denied" "$(as "$ROOT" "INSERT INTO public.payout_authorizations (request_id, admin_id, amount_kobo, bank_account_id, recipient_code, idempotency_key, expires_at) VALUES ('$W6', '$ROOT', 700000, '$BANK2', 'RCP_bola', 'client-forged-key-0001', now());")"
expect_value "ledger = available + pending for every wallet" "$(reconciled)" "0"

echo "== 8. Rollback and re-apply =="
expect_error "undo_0213 needs its confirmation" "to confirm" "$(cat "$REPO_ROOT/supabase/rollback/undo_0213.sql")"
OPEN_ROOT_APPROVALS=$(val "SELECT count(*) FROM public.organizer_withdrawal_requests WHERE status = 'pending' AND approved_by IS NOT NULL AND approval_request_id IS NULL;")
W7=$(withdraw_id "$ORG2" 600000 "$BANK2" 4826 k-w7)
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$W7', 600000);")" >/dev/null
expect_error "undo_0213 refuses while a VENTS-Admin-only approval is unpaid" "approved only by the VENTS Admin" \
  "SET vents.rollback_confirm = 'undo-0213'; $(cat "$REPO_ROOT/supabase/rollback/undo_0213.sql")"
"${PSQL[@]}" -q -c "SET test.uid = '$ADMIN_A'; SELECT public.admin_reject_organizer_payout('$W7', 'before rollback');" >/dev/null
KEPT_BEFORE=$(val "SELECT (SELECT count(*) FROM public.withdrawal_reviews) || '/' || (SELECT count(*) FROM public.payout_authorizations) || '/' || (SELECT count(*) FROM public.admin_payout_pins) || '/' || (SELECT count(*) FROM public.organizer_withdrawal_requests);")
expect_ok "undo_0213 runs" "SET vents.rollback_confirm = 'undo-0213'; $(cat "$REPO_ROOT/supabase/rollback/undo_0213.sql")"
"${PSQL[@]}" -tA -c "$FN_LIST" > "$TMP/fn_post"
diff "$TMP/fn_pre" "$TMP/fn_post" >&2 || true
expect_value "after undo_0213 the database is exactly the 0211+0212 state" "$(val "$STATE13_SQL")" "$PRE_0213"
expect_value "...with 0203's two-admin constraint back (NOT VALID: past VENTS-Admin approvals stay as history)" \
  "$(val "SELECT convalidated::text FROM pg_constraint WHERE conname = 'organizer_withdrawal_requests_two_admins';")/$(val "SELECT count(*) FROM pg_constraint WHERE conname = 'organizer_withdrawal_requests_approval_parties';")" "false/0"
expect_value "reviews, authorizations, the PIN and every withdrawal are kept" "$(val "SELECT (SELECT count(*) FROM public.withdrawal_reviews) || '/' || (SELECT count(*) FROM public.payout_authorizations) || '/' || (SELECT count(*) FROM public.admin_payout_pins) || '/' || (SELECT count(*) FROM public.organizer_withdrawal_requests);")" "$KEPT_BEFORE"
expect_value "...and stay closed to clients" "$(val "SELECT has_table_privilege('authenticated', 'public.admin_payout_pins', 'SELECT')::text || has_table_privilege('authenticated', 'public.payout_authorizations', 'SELECT')::text;")" "falsefalse"
expect_value "money reconciles after the rollback" "$(reconciled)" "0"
expect_ok "0213 re-applies" "$(cat "$M13")"
expect_value "re-applied state equals the first apply" "$(val "$STATE13_SQL")" "$POST_0213"
expect_value "the VENTS Admin keeps the PIN after re-applying" "$(val "$(as "$ROOT" "SELECT public.admin_payout_pin_status()->>'has_pin';")")" "true"
: "$OPEN_ROOT_APPROVALS"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL $PASSES VENTS ADMIN PAYOUT AUTHORIZATION CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1
fi
