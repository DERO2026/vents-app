#!/usr/bin/env bash
# Real-execution verification of migration 0214 (Admin Payouts list):
#
#   ordering     every scope (open, closed, all) is newest first
#                (created_at DESC, id DESC); a new withdrawal is row 1;
#   pagination   the keyset cursor (p_before_created_at, p_before_id) walks
#                every row exactly once, with equal timestamps, per scope;
#   actions      for each role (VENTS Admin, admin, sub-admin) and each
#                status (pending review, forwarded, rejection recommended,
#                approved, processing with and without a transfer reference,
#                paid, failed, rejected, cancelled, reversed) the can_* flags
#                equal what the acting functions actually allow: every flag
#                that is true is executed and succeeds, every one that is
#                false is executed and is refused;
#   bank         missing, inactive, unverified and changed-since-approval
#                accounts are named in bank_problem and cannot be forwarded,
#                approved or paid;
#   and 0214 is idempotent, keeps old two-argument calls working, refuses a
#   drifted 0213 body, and undo_0214 restores the exact 0213 state.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
#
# Usage: scripts/local-pg-test/run-payout-list-verification.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_payout_list"
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
LIST4="public.admin_list_withdrawals(text,integer,timestamptz,uuid)"
M14="$MIG/0214_admin_payouts_list_newest_first.sql"
U14="$REPO_ROOT/supabase/rollback/undo_0214.sql"
LIST_STATE="SELECT string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || COALESCE(array_to_string(p.proacl, ','), ''), '|' ORDER BY 1) || '/' || (SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_org_withdraw_created_id') FROM pg_proc p WHERE p.proname = 'admin_list_withdrawals';"
# replica: fixture-only edits of timestamps / legacy rows that the guards would refuse.
fixture() { "${PSQL[@]}" -q -c "SET session_replication_role = replica; $1" >/dev/null; }

echo "== Fixtures (0213, before 0214) =="
# The live admin_list_processing_payouts (0004, verbatim; Reconcile reads it)
# with production's grants (0011, 0111: authenticated, not anon).
"${PSQL[@]}" -q -c "$(awk '/^-- Function: admin_list_processing_payouts$/{f=1;next} f&&/^-- Function:/{exit} f' "$MIG/0004_functions.sql")"
"${PSQL[@]}" -q -c "REVOKE ALL ON FUNCTION public.admin_list_processing_payouts() FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION public.admin_list_processing_payouts() TO authenticated;"
"${PSQL[@]}" -q -c "$(as "$ORG" "SELECT public.set_my_withdrawal_pin('7391', '7391');")" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ORG2" "SELECT public.set_my_withdrawal_pin('4826', '4826');")" >/dev/null
"${PSQL[@]}" -q -c "$(asroot "SELECT public.admin_set_payout_pin('$PIN', '$PIN');")" >/dev/null
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES ('00000000-0000-0000-0000-000000000d11', '$ORG', 'Opay', '999', '0333333333', 'ADA ORGANIZER', 'RCP_ada2', true), ('00000000-0000-0000-0000-000000000d12', '$ORG2', 'Opay', '999', '0444444444', 'BOLA ORGANIZER', 'RCP_bola2', true);"
P_REVIEW=$(withdraw_id "$ORG" 510000 "$BANK" 7391 k-review)
P_FWD=$(withdraw_id "$ORG2" 520000 "$BANK2" 4826 k-fwd)
"${PSQL[@]}" -q -c "$(as "$SUB" "SELECT public.admin_review_withdrawal('$P_FWD', 520000, 'forward', 'Bank matches the profile');")" >/dev/null
P_RECREJ=$(withdraw_id "$ORG" 530000 "$BANK" 7391 k-recrej)
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_review_withdrawal('$P_RECREJ', 530000, 'recommend_reject', 'Name mismatch');")" >/dev/null
P_APPR=$(withdraw_id "$ORG2" 540000 "$BANK2" 4826 k-appr)
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$P_APPR', 540000);")" >/dev/null
P_PROC=$(withdraw_id "$ORG" 550000 "$BANK" 7391 k-proc)
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$P_PROC', 550000);")" >/dev/null
expect_value "fixture: processing via Authorize & Pay" "$(pay "$P_PROC" 550000 "$PIN" "$(newkey)")" "claimed:true"
P_PAID=$(withdraw_id "$ORG2" 560000 "$BANK2" 4826 k-paid)
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$P_PAID', 560000);")" >/dev/null
pay "$P_PAID" 560000 "$PIN" "$(newkey)" >/dev/null
"${PSQL[@]}" -q -c "SELECT * FROM public.complete_organizer_payout((SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$P_PAID'));" >/dev/null
P_FAIL=$(withdraw_id "$ORG" 570000 "$BANK" 7391 k-fail)
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.admin_approve_withdrawal_for_payment('$P_FAIL', 570000);")" >/dev/null
pay "$P_FAIL" 570000 "$PIN" "$(newkey)" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET transfer_code = 'TRF_fail' WHERE id = '$P_FAIL';"
"${PSQL[@]}" -q -c "SELECT * FROM public.fail_organizer_payout((SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$P_FAIL'), 'Paystack transfer.failed');" >/dev/null
P_REJ=$(withdraw_id "$ORG2" 580000 "$BANK2" 4826 k-rej)
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_reject_organizer_payout('$P_REJ', 'Wrong account');")" >/dev/null
# A pre-0202 processing row: claimed, but no transfer code or reference was ever recorded.
P_LEGACY=$(withdraw_id "$ORG" 590000 "$BANK" 7391 k-legacy)
fixture "UPDATE public.organizer_withdrawal_requests SET status = 'processing', paystack_reference = NULL, transfer_code = NULL WHERE id = '$P_LEGACY';"
P_CANC=$(withdraw_id "$ORG2" 600000 "$BANK2" 4826 k-canc)
fixture "UPDATE public.organizer_withdrawal_requests SET status = 'processing', paystack_reference = NULL, transfer_code = NULL WHERE id = '$P_CANC';"
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT * FROM public.admin_cancel_processing_payout('$P_CANC', 'Never reached Paystack');")" >/dev/null
expect_value "fixture statuses" "$(val "SELECT string_agg(status, ',' ORDER BY amount_kobo) FROM public.organizer_withdrawal_requests WHERE id IN ('$P_REVIEW','$P_FWD','$P_RECREJ','$P_APPR','$P_PROC','$P_PAID','$P_FAIL','$P_REJ','$P_LEGACY','$P_CANC');")" \
  "pending,pending,pending,pending,processing,completed,failed,rejected,processing,cancelled"
# Distinct creation times, oldest = P_REVIEW; P_APPR and P_PROC share one (tie on id).
i=0
for id in "$P_REVIEW" "$P_FWD" "$P_RECREJ" "$P_APPR" "$P_PROC" "$P_PAID" "$P_FAIL" "$P_REJ" "$P_LEGACY" "$P_CANC"; do
  i=$((i+1)); t=$i; [ "$id" = "$P_PROC" ] && t=4
  fixture "UPDATE public.organizer_withdrawal_requests SET created_at = timestamptz '2026-11-01 10:00:00+00' + make_interval(hours => $t) WHERE id = '$id';"
done
OPEN_0213=$(val "$(as "$ROOT" "SELECT string_agg(request_id::text, ',') FROM (SELECT request_id FROM public.admin_list_withdrawals('open', 500)) s;")")
expect_value "0213 (the bug): open requests come oldest first" "$(echo "$OPEN_0213" | cut -d, -f1)" "$P_REVIEW"
PRE_0214=$(val "$LIST_STATE")

echo "== Applying 0214 =="
expect_ok "0214 applies on top of 0213 (drift guard passes)" "$(cat "$M14")"
POST_0214=$(val "$LIST_STATE")
expect_ok "0214 is idempotent (second run)" "$(cat "$M14")"
expect_value "a second run of 0214 changes nothing" "$(val "$LIST_STATE")" "$POST_0214"
expect_value "only the four-argument function exists; authenticated may call it, anon may not" \
  "$(val "SELECT (to_regprocedure('public.admin_list_withdrawals(text,integer)') IS NULL)::text || '/' || has_function_privilege('authenticated', '$LIST4', 'EXECUTE')::text || '/' || has_function_privilege('anon', '$LIST4', 'EXECUTE')::text;")" "true/true/false"
expect_error "signed out: refused" "permission denied\|Admin access required" "SET ROLE anon; SELECT * FROM public.admin_list_withdrawals('open');"
expect_error "a plain user: refused" "Admin access required" "$(as "$USER" "SELECT * FROM public.admin_list_withdrawals('open');")"
expect_error "a cursor id without its timestamp is refused" "needs p_before_created_at" "$(as "$ROOT" "SELECT * FROM public.admin_list_withdrawals('all', 10, NULL, '$P_REVIEW');")"
expect_ok "old two-argument calls still work (the deployed screen)" "$(as "$SUB" "SELECT * FROM public.admin_list_withdrawals('open', 200);")"
expect_ok "...and named arguments (PostgREST)" "$(as "$SUB" "SELECT * FROM public.admin_list_withdrawals(p_scope => 'all', p_limit => 200);")"

echo "== 1. Newest first, every scope, every role =="
for scope in open closed all; do
  case $scope in open) w="status IN ('pending','processing')";; closed) w="status NOT IN ('pending','processing')";; all) w="true";; esac
  EXPECT=$(val "SELECT string_agg(id::text, ',' ORDER BY created_at DESC, id DESC) FROM public.organizer_withdrawal_requests WHERE $w;")
  for who in "$ROOT" "$ADMIN_A" "$SUB"; do
    GOT=$(val "$(as "$who" "SELECT string_agg(request_id::text, ',') FROM (SELECT request_id FROM public.admin_list_withdrawals('$scope', 500)) s;")")
    expect_value "$scope: created_at DESC, id DESC ($who)" "$GOT" "$EXPECT"
  done
done
expect_value "all: a closed request newer than an open one is above it (no open-first grouping)" \
  "$(val "$(as "$ROOT" "SELECT string_agg(request_id::text, ',') FROM (SELECT request_id FROM public.admin_list_withdrawals('all', 2)) s;")")" "$P_CANC,$P_LEGACY"
NEW=$(withdraw_id "$ORG2" 610000 "$BANK2" 4826 k-new)
for scope in open all; do
  expect_value "a withdrawal submitted now is row 1 in $scope" "$(val "$(as "$ROOT" "SELECT request_id FROM public.admin_list_withdrawals('$scope', 1);")")" "$NEW"
done
expect_value "the tie (same created_at) is broken by id, newest-first otherwise" \
  "$(val "$(as "$ROOT" "SELECT string_agg(request_id::text, ',') FROM (SELECT request_id FROM public.admin_list_withdrawals('all', 500)) s WHERE request_id IN ('$P_APPR', '$P_PROC');")")" \
  "$(val "SELECT string_agg(id::text, ',' ORDER BY id DESC) FROM public.organizer_withdrawal_requests WHERE id IN ('$P_APPR', '$P_PROC');")"

echo "== 2. Keyset pagination =="
walk() { # walk <uid> <scope> <page size> -> ids joined by ',' and page count
  local uid=$1 scope=$2 size=$3 cur_t="" cur_id="" out="" pages=0 page n last
  while :; do
    if [ -z "$cur_t" ]; then args="'$scope', $size"; else args="'$scope', $size, '$cur_t'::timestamptz, '$cur_id'::uuid"; fi
    page=$(val "$(as "$uid" "SELECT COALESCE(string_agg(request_id::text || '@' || created_at::text, ','), '') FROM (SELECT request_id, created_at FROM public.admin_list_withdrawals($args)) s;")")
    [ -z "$page" ] && break
    pages=$((pages+1))
    n=$(echo "$page" | tr ',' '\n' | wc -l)
    out="$out${out:+,}$(echo "$page" | tr ',' '\n' | cut -d@ -f1 | paste -sd,)"
    last=$(echo "$page" | tr ',' '\n' | tail -n1)
    cur_id=${last%@*}; cur_t=${last#*@}
    [ "$n" -lt "$size" ] && break
    [ "$pages" -gt 50 ] && break
  done
  echo "$out/$pages"
}
for scope in open closed all; do
  FULL=$(val "$(as "$ROOT" "SELECT string_agg(request_id::text, ',') FROM (SELECT request_id FROM public.admin_list_withdrawals('$scope', 500)) s;")")
  for size in 1 2 3; do
    W=$(walk "$ROOT" "$scope" "$size")
    expect_value "$scope, pages of $size: every row exactly once, in order" "${W%/*}" "$FULL"
  done
done
expect_value "the tie pair is split across pages without loss (size 1 walk includes both)" \
  "$(walk "$SUB" all 1 | cut -d/ -f1 | tr ',' '\n' | grep -cE "^($P_APPR|$P_PROC)$")" "2"

row() { val "$(as "$1" "SELECT $3 FROM public.admin_list_withdrawals('all', 500) WHERE request_id = '$2';")"; }
FLAGS="can_review::int || '' || can_forward::int || can_approve::int || can_authorize_pay::int || can_reject::int || can_reconcile::int || can_cancel::int || can_request_bank_change::int"

echo "== 3. Action flags by role and status (review forward approve pay reject reconcile cancel bank-change) =="
declare -A WANT=(
  ["$P_REVIEW:root"]=00101001 ["$P_REVIEW:admin"]=11001001 ["$P_REVIEW:sub"]=11000001
  ["$P_FWD:root"]=00101001    ["$P_FWD:admin"]=11001001    ["$P_FWD:sub"]=11000001
  ["$P_RECREJ:root"]=00101001 ["$P_RECREJ:admin"]=11001001 ["$P_RECREJ:sub"]=11000001
  ["$P_APPR:root"]=00011000   ["$P_APPR:admin"]=00001000   ["$P_APPR:sub"]=00000000
  ["$P_PROC:root"]=00000100   ["$P_PROC:admin"]=00000100   ["$P_PROC:sub"]=00000000
  ["$P_LEGACY:root"]=00000110 ["$P_LEGACY:admin"]=00000110 ["$P_LEGACY:sub"]=00000000
  ["$P_PAID:root"]=00000000   ["$P_PAID:admin"]=00000000   ["$P_PAID:sub"]=00000000
  ["$P_FAIL:root"]=00000000   ["$P_FAIL:admin"]=00000000   ["$P_FAIL:sub"]=00000000
  ["$P_REJ:root"]=00000000    ["$P_REJ:admin"]=00000000    ["$P_REJ:sub"]=00000000
  ["$P_CANC:root"]=00000000   ["$P_CANC:admin"]=00000000   ["$P_CANC:sub"]=00000000
)
uid_of() { case $1 in root) echo "$ROOT";; admin) echo "$ADMIN_A";; sub) echo "$SUB";; esac; }
for key in "${!WANT[@]}"; do
  id=${key%%:*}; who=${key##*:}
  expect_value "flags $(row "$ROOT" "$id" stage) / $who" "$(row "$(uid_of "$who")" "$id" "$FLAGS")" "${WANT[$key]}"
done

echo "== 4. Every flag matches what the acting function really allows =="
# Each action is executed in a transaction that is rolled back: nothing changes.
try() { # try <uid> <sql> -> ok | refused
  local q; q=$(printf "BEGIN; SET test.uid='%s'; SET test.jwt='%s'; SET ROLE authenticated; %s ROLLBACK;" "$1" "$(pw)" "$2")
  if "${PSQL[@]}" -c "$q" >"$OUT" 2>"$ERR"; then echo ok; else echo refused; fi
}
act_sql() { # act_sql <action> <id> <amount>
  case $1 in
    review)    echo "SELECT public.admin_review_withdrawal('$2', $3, 'recommend_reject', 'checked it');";;
    forward)   echo "SELECT public.admin_review_withdrawal('$2', $3, 'forward', 'checked it');";;
    approve)   echo "SELECT public.admin_approve_withdrawal_for_payment('$2', $3);";;
    pay)       echo "DO \$x\$ BEGIN IF (public.admin_authorize_and_claim_payout('$2', $3, '$PIN', 'try-key-0000000000001')->>'claimed') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'not claimed'; END IF; END \$x\$;";;
    reject)    echo "SELECT public.admin_reject_organizer_payout('$2', 'checked');";;
    reconcile) echo "SELECT * FROM public.admin_list_processing_payouts();";;
    cancel)    echo "SELECT * FROM public.admin_cancel_processing_payout('$2', 'checked');";;
    bankchange) echo "SELECT public.admin_request_withdrawal_bank_reassignment('$2', '$(val "SELECT b.id FROM public.organizer_bank_accounts b JOIN public.organizer_withdrawal_requests r ON r.organizer_id = b.organizer_id WHERE r.id = '$2' AND b.id IS DISTINCT FROM r.bank_account_id ORDER BY b.id DESC LIMIT 1;")', 'Move to the verified second account');";;
  esac
}
ACTIONS=(review forward approve pay reject reconcile cancel bankchange)
MISMATCH=0; CHECKED=0
for id in "$P_REVIEW" "$P_FWD" "$P_RECREJ" "$P_APPR" "$P_PROC" "$P_LEGACY" "$P_PAID" "$P_FAIL" "$P_REJ" "$P_CANC"; do
  amt=$(val "SELECT amount_kobo FROM public.organizer_withdrawal_requests WHERE id = '$id';")
  for who in root admin sub; do
    uid=$(uid_of "$who"); flags=$(row "$uid" "$id" "$FLAGS")
    for k in 0 1 2 3 4 5 6 7; do
      a=${ACTIONS[$k]}; f=${flags:$k:1}
      r=$(try "$uid" "$(act_sql "$a" "$id" "$amt")")
      # reconcile lists every processing payout (not per row): only meaningful on processing rows.
      if [ "$a" = reconcile ] && [ "$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '$id';")" != processing ]; then continue; fi
      CHECKED=$((CHECKED+1))
      if { [ "$f" = 1 ] && [ "$r" = ok ]; } || { [ "$f" = 0 ] && [ "$r" = refused ]; }; then :; else
        MISMATCH=$((MISMATCH+1)); echo "  mismatch: $a on $(row "$ROOT" "$id" stage) as $who: flag $f, function $r" >&2; cat "$ERR" >&2
      fi
    done
  done
done
expect_value "all $CHECKED role x status x action combinations: flag = server decision" "$MISMATCH" "0"
expect_value "...and nothing changed (every try was rolled back)" "$(val "SELECT string_agg(status, ',' ORDER BY amount_kobo) FROM public.organizer_withdrawal_requests WHERE id IN ('$P_REVIEW','$P_FWD','$P_RECREJ','$P_APPR','$P_PROC','$P_PAID','$P_FAIL','$P_REJ','$P_LEGACY','$P_CANC');")" \
  "pending,pending,pending,pending,processing,completed,failed,rejected,processing,cancelled"

echo "== 5. Own withdrawal and the kill switch =="
"${PSQL[@]}" -q -c "$(as "$ROOT" "SELECT public.set_my_withdrawal_pin('5937', '5937');")" >/dev/null
P_OWN=$(withdraw_id "$ROOT" 620000 "$BANK_R" 5937 k-own)
expect_value "the VENTS Admin's own withdrawal: no approve, no pay; an admin may reject it" "$(row "$ROOT" "$P_OWN" "$FLAGS")/$(row "$ADMIN_A" "$P_OWN" "$FLAGS")" "00001000/11001001"
expect_value "...and the server agrees (approve refused)" "$(try "$ROOT" "$(act_sql approve "$P_OWN" 620000)")" "refused"
if "${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = true;" 2>/dev/null && [ "$(val "SELECT public.payouts_disabled()::text;")" = "true" ]; then
  expect_value "kill switch: no approve, pay, reject or cancel for anyone; review and reconcile stay" \
    "$(row "$ROOT" "$P_REVIEW" "$FLAGS")/$(row "$ADMIN_A" "$P_REVIEW" "$FLAGS")/$(row "$ROOT" "$P_APPR" "$FLAGS")/$(row "$ADMIN_A" "$P_LEGACY" "$FLAGS")" "00000001/11000001/00000000/00000100"
  expect_value "...and the server agrees (reject and cancel refused)" "$(try "$ADMIN_A" "$(act_sql reject "$P_REVIEW" 510000)")/$(try "$ADMIN_A" "$(act_sql cancel "$P_LEGACY" 590000)")" "refused/refused"
  "${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = false;"
else echo "info: no app_config kill switch row on this stack; skipped"; fi

echo "== 6. Bank account problems =="
bp() { row "$1" "$2" "COALESCE(bank_problem, 'none') || '|' || can_forward::int || can_approve::int || can_authorize_pay::int"; }
expect_value "a verified account: no problem" "$(bp "$ROOT" "$P_REVIEW")" "none|010"
expect_value "...sub-admin view (forward allowed)" "$(bp "$SUB" "$P_REVIEW")" "none|100"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET is_active = false WHERE id = '$BANK';"
expect_value "inactive account: named; no forward, no approve" "$(bp "$ROOT" "$P_REVIEW")/$(bp "$SUB" "$P_REVIEW")" "inactive|000/inactive|000"
expect_value "...the server refuses forward and approve; recommend-rejection and reject still work" \
  "$(try "$SUB" "$(act_sql forward "$P_REVIEW" 510000)")/$(try "$ROOT" "$(act_sql approve "$P_REVIEW" 510000)")/$(try "$SUB" "$(act_sql review "$P_REVIEW" 510000)")/$(try "$ADMIN_A" "$(act_sql reject "$P_REVIEW" 510000)")" "refused/refused/ok/ok"
expect_value "...the sub-admin note says recommend rejection (not reject)" "$(row "$SUB" "$P_REVIEW" "action_note")" "The bank account is missing, inactive or not verified by Paystack, so it cannot be forwarded or paid. Recommend rejection."
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET is_active = true, recipient_code = NULL WHERE id = '$BANK';"
expect_value "unverified account (no Paystack recipient): named; nothing can be sent" "$(bp "$ROOT" "$P_REVIEW")/$(try "$ROOT" "$(act_sql approve "$P_REVIEW" 510000)")" "unverified|000/refused"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_ada' WHERE id = '$BANK';"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_bola_new' WHERE id = '$BANK2';"
expect_value "changed after approval: named; Authorize & Pay is off and refused" "$(bp "$ROOT" "$P_APPR")/$(try "$ROOT" "$(act_sql pay "$P_APPR" 540000)")" "changed_since_approval|000/refused"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_bola' WHERE id = '$BANK2';"
P_NOBANK=$(withdraw_id "$ORG" 630000 "$BANK" 7391 k-nobank)
fixture "UPDATE public.organizer_withdrawal_requests SET bank_account_id = NULL WHERE id = '$P_NOBANK';"
expect_value "missing account: named; no approve" "$(bp "$ROOT" "$P_NOBANK")/$(try "$ROOT" "$(act_sql approve "$P_NOBANK" 630000)")" "missing|000/refused"
expect_value "final states carry no bank problem" "$(row "$ROOT" "$P_PAID" "COALESCE(bank_problem, 'none')")" "none"
expect_value "sub-admins still see only the masked number" "$(row "$SUB" "$P_FWD" "COALESCE(account_number, 'hidden') || '|' || account_number_masked")" "hidden|****4321"
expect_value "ledger = available + pending for every wallet" "$(reconciled)" "0"

echo "== 7. Drift guard and rollback =="
expect_error "undo_0213 refuses while 0214 is applied" "run undo_0214 first" "SET vents.rollback_confirm = 'undo-0213'; $(cat "$REPO_ROOT/supabase/rollback/undo_0213.sql")"
expect_error "undo_0214 needs its confirmation" "to confirm" "$(cat "$U14")"
expect_ok "undo_0214 runs" "SET vents.rollback_confirm = 'undo-0214'; $(cat "$U14")"
expect_value "after undo_0214 the list function, grants and indexes are exactly 0213's" "$(val "$LIST_STATE")" "$PRE_0214"
expect_value "...with 0213's ordering back (oldest open first)" "$(val "$(as "$ROOT" "SELECT request_id FROM public.admin_list_withdrawals('open', 1);")")" "$P_REVIEW"
expect_error "0214 refuses a drifted 0213 body" "is not the 0213 version" \
  "BEGIN; UPDATE pg_proc SET prosrc = prosrc || ' ' WHERE oid = 'public.admin_list_withdrawals(text,integer)'::regprocedure; $(cat "$M14") ROLLBACK;"
expect_value "...and changed nothing" "$(val "$LIST_STATE")" "$PRE_0214"
expect_ok "0214 re-applies" "$(cat "$M14")"
expect_value "re-applied state equals the first apply" "$(val "$LIST_STATE")" "$POST_0214"
expect_value "ledger still reconciles" "$(reconciled)" "0"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL $PASSES ADMIN PAYOUTS LIST (0214) CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1
fi
