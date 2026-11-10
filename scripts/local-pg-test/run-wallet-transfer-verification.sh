#!/usr/bin/env bash
# Real-execution verification of migration 0215 (VENTS-to-VENTS transfers
# between spendable VENTS Wallets):
#
#   switch      off after applying; only the VENTS Admin turns it on;
#   lookup      exact, unambiguous username; public fields only; never self,
#               suspended, banned or deleted accounts; rate-limited;
#   transfer    one transaction: sender debited, recipient credited, two
#               ledger rows with one reference, a transfer record, two
#               notifications -- or nothing; money is conserved;
#   security    PIN (wrong attempts counted and committed, lockout, reset
#               pause), verified email, account age, limits (min, max,
#               daily amount, daily count), note length, kill switch,
#               attempt rate limit, idempotency (replay, conflicting reuse),
#               no client table access, immutable records;
#   concurrency parallel overspend attempts, parallel same-key retries and
#               opposite transfers (no deadlock, never negative);
#   unchanged   earnings (organizer_wallets) and the ledger of everyone else
#               (VENTS Cents: 0215 references no VC table, checked by a unit test); received money buys a ticket immediately and a
#               refund returns to the wallet through the existing functions;
#   rollback    undo_0215 restores the exact pre-0215 schema when unused,
#               keeps all records when transfers exist; 0215 re-applies.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses hosted databases. No network.
#
# Usage: scripts/local-pg-test/run-wallet-transfer-verification.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_wallet_transfer"
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
M15="$MIG/0215_wallet_transfers.sql"
U15="$REPO_ROOT/supabase/rollback/undo_0215.sql"
EV="00000000-0000-0000-0000-0000000e0001"
X1="00000000-0000-0000-0000-000000000e11"   # suspended
X2="00000000-0000-0000-0000-000000000e12"   # banned
X3="00000000-0000-0000-0000-000000000e13"   # deleted
X4="00000000-0000-0000-0000-000000000e14"   # "Dup" (case twin of "dup")
X5="00000000-0000-0000-0000-000000000e15"   # "dup"
NEWBIE="00000000-0000-0000-0000-000000000e16"
WSTATE="SELECT md5(string_agg(p.oid::regprocedure::text || ':' || p.prosrc || ':' || COALESCE(array_to_string(p.proacl, ','), ''), '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT md5(string_agg(conrelid::regclass::text || conname || pg_get_constraintdef(oid), '|' ORDER BY conrelid::regclass::text, conname)) FROM pg_constraint WHERE connamespace = 'public'::regnamespace) || '/' || (SELECT md5(string_agg(table_name || '.' || column_name || COALESCE(column_default, ''), '|' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema = 'public') || '/' || (SELECT md5(string_agg(indexname || indexdef, '|' ORDER BY indexname)) FROM pg_indexes WHERE schemaname = 'public') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
bal() { val "SELECT COALESCE((SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$1'), 0);"; }
total() { val "SELECT COALESCE(sum(balance_kobo), 0) FROM public.user_wallets;"; }
# Every wallet equals its ledger: credits (deposit, refund, vc_conversion, transfer_in) minus debits (spend, transfer_out).
ledger_ok() { val "SELECT count(*) FROM public.user_wallets w WHERE w.balance_kobo <> COALESCE((SELECT sum(CASE WHEN t.type IN ('spend', 'transfer_out') THEN -t.amount_kobo ELSE t.amount_kobo END) FROM public.user_wallet_transactions t WHERE t.user_id = w.user_id), 0);"; }
deposit() { "${PSQL[@]}" -q -c "INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$1', $2) ON CONFLICT (user_id) DO UPDATE SET balance_kobo = public.user_wallets.balance_kobo + $2; INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id) VALUES ('$1', 'deposit', $2, 'test deposit', 'wdep_' || md5(random()::text));" >/dev/null; }
tkey() { echo "transfer-key-$(date +%s%N)-$RANDOM$RANDOM"; }
# send <from> <to> <kobo> <pin> <key> [note] -> code | ok | ok:replayed
send() { val "$(as_jwt "$1" '{}' "SELECT CASE WHEN (r->>'ok')::boolean THEN 'ok' || CASE WHEN (r->>'replayed')::boolean THEN ':replayed' ELSE '' END ELSE r->>'code' END FROM (SELECT public.transfer_wallet_funds('$2', $3, $(printf "%s" "${6:-NULL}"), '$4', '$5') r) s;")"; }
lookup() { val "$(as "$1" "SELECT COALESCE(r->'recipient'->>'username', r->>'code') FROM (SELECT public.find_wallet_transfer_recipient('$2') r) s;")"; }

echo "== Fixtures =="
"${PSQL[@]}" -q <<SQL
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false;
-- Production's check_rate_limit (0004, verbatim) instead of the stack's no-op stub.
CREATE TABLE IF NOT EXISTS public.rate_limits (key text NOT NULL, window_start bigint NOT NULL, count integer NOT NULL DEFAULT 0, PRIMARY KEY (key, window_start));
SQL
"${PSQL[@]}" -q -c "$(awk '/^-- Function: check_rate_limit$/{f=1;next} f&&/^-- Function:/{exit} f' "$MIG/0004_functions.sql")"
# Production's get_my_wallet_transactions (0065, verbatim).
"${PSQL[@]}" -q -c "$(awk '/^CREATE OR REPLACE FUNCTION public.get_my_wallet_transactions/{f=1} f{print} f&&/^GRANT EXECUTE ON FUNCTION public.get_my_wallet_transactions/{exit}' "$MIG/0065_user_wallets.sql")"
"${PSQL[@]}" -q <<SQL
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
INSERT INTO public.users (id, role, full_name, email, username, status, banned_until, deleted_at) VALUES
  ('$X1', 'user', 'Sus Pended', 'x1@example.test', 'suspended1', 'suspended', NULL, NULL),
  ('$X2', 'user', 'Ban Ned', 'x2@example.test', 'banned1', 'active', now() + interval '7 days', NULL),
  ('$X3', 'user', 'Gone', 'x3@example.test', 'gone1', 'deleted', NULL, now()),
  ('$X4', 'user', 'Dup Upper', 'x4@example.test', 'Dup', 'active', NULL, NULL),
  ('$X5', 'user', 'Dup Lower', 'x5@example.test', 'dup', 'active', NULL, NULL),
  ('$NEWBIE', 'user', 'New Bie', 'nb@example.test', 'newbie', 'active', NULL, NULL);
UPDATE public.users SET created_at = now() - interval '30 days' WHERE id <> '$NEWBIE';
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.confirm_ticket_payment_via_wallet(text), public.refund_ticket(uuid,text) TO authenticated;
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EV', '$ORG2', 'Wallet show', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]');
SQL
for who in "$ORG:7391" "$ORG2:4826" "$USER:5937" "$NEWBIE:6152"; do
  "${PSQL[@]}" -q -c "$(as "${who%%:*}" "SELECT public.set_my_withdrawal_pin('${who##*:}', '${who##*:}');")" >/dev/null
done
"${PSQL[@]}" -q -c "UPDATE public.withdrawal_pins SET reset_at = NULL, changed_at = now() - interval '30 days';"
ORGW_BEFORE=$(val "SELECT md5(string_agg(organizer_id::text || balance_kobo || '/' || pending_kobo, ',' ORDER BY organizer_id)) FROM public.organizer_wallets;")
PRE=$(val "$WSTATE")

echo "== Applying 0215 =="
expect_error "0215 refuses a ledger type constraint that drifted from 0146" "expected 0146's four types" \
  "BEGIN; ALTER TABLE public.user_wallet_transactions DROP CONSTRAINT user_wallet_transactions_type_check; ALTER TABLE public.user_wallet_transactions ADD CONSTRAINT user_wallet_transactions_type_check CHECK (type = ANY (ARRAY['deposit', 'spend', 'refund', 'vc_conversion', 'mystery'])); $(cat "$M15") ROLLBACK;"
expect_value "...and changed nothing" "$(val "$WSTATE")" "$PRE"
expect_ok "0215 applies" "$(cat "$M15")"
POST=$(val "$WSTATE")
expect_ok "0215 is idempotent" "$(cat "$M15")"
expect_value "a second run changes nothing" "$(val "$WSTATE")" "$POST"
expect_value "transfers are OFF after applying" "$(val "SELECT public.wallet_transfers_disabled()::text;")" "true"
expect_error "undo_0215 needs its confirmation" "to confirm" "$(cat "$U15")"
expect_ok "undo_0215 with no transfers" "SET vents.rollback_confirm = 'undo-0215'; $(cat "$U15")"
expect_value "...restores the exact pre-0215 schema" "$(val "$WSTATE")" "$PRE"
expect_ok "0215 re-applies" "$(cat "$M15")"
expect_value "...to the same state" "$(val "$WSTATE")" "$POST"

echo "== 1. Kill switch and access =="
deposit "$ORG" 10000000   # N100,000
deposit "$USER" 500000    # N5,000
deposit "$NEWBIE" 500000
expect_value "while off, a transfer is refused and nothing moves" "$(send "$ORG" "$ORG2" 100000 7391 "$(tkey)")/$(bal "$ORG")/$(bal "$ORG2")" "transfers_disabled/10000000/0"
for who in "$ADMIN_A" "$SUB" "$USER"; do
  expect_error "only the VENTS Admin can turn transfers on ($who)" "VENTS Admin access required" "$(as "$who" "SELECT public.admin_set_wallet_transfers_enabled(true);")"
done
expect_error "signed out: cannot transfer" "permission denied" "SET ROLE anon; SELECT public.transfer_wallet_funds('$ORG2', 100000, NULL, '7391', 'anon-key-0000000000001');"
expect_value "the VENTS Admin turns transfers on (audited)" "$(val "$(as "$ROOT" "SELECT public.admin_set_wallet_transfers_enabled(true)::text;")")/$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'set_wallet_transfers_enabled';")" "true/1"
expect_error "clients cannot read transfer records directly" "permission denied" "$(as "$ORG" "SELECT * FROM public.wallet_transfers;")"
expect_error "clients cannot write the ledger" "permission denied" "$(as "$ORG" "INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo) VALUES ('$ORG', 'transfer_in', 1);")"
expect_error "clients cannot change a balance" "permission denied" "$(as "$ORG" "UPDATE public.user_wallets SET balance_kobo = 99999999 WHERE user_id = '$ORG';")"

echo "== 2. Recipient lookup =="
expect_value "exact username" "$(lookup "$ORG" bola)" "bola"
expect_value "@ prefix and case are ignored" "$(lookup "$ORG" '@BOLA')" "bola"
expect_value "not found" "$(lookup "$ORG" nobody_here)" "not_found"
expect_value "partial usernames do not match" "$(lookup "$ORG" bol)" "not_found"
expect_value "yourself" "$(lookup "$ORG" ada)" "self"
expect_value "suspended account (reported as not found: status is never revealed)" "$(lookup "$ORG" suspended1)" "not_found"
expect_value "banned account" "$(lookup "$ORG" banned1)" "not_found"
expect_value "deleted account" "$(lookup "$ORG" gone1)" "not_found"
expect_value "two accounts differing only by case: ambiguous, refused" "$(lookup "$ORG" dup)" "ambiguous"
expect_value "only public fields are returned (no balance, email or phone)" \
  "$(val "$(as "$ORG" "SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(public.find_wallet_transfer_recipient('bola')->'recipient') k;")")" "avatar_url,id,is_verified,name,username"
expect_value "junk input is refused" "$(lookup "$ORG" "x;drop table users --")/$(lookup "$ORG" "a")" "invalid_username/invalid_username"

echo "== 3. A transfer =="
TOTAL0=$(total)
K1=$(tkey)
expect_value "Ada sends Bola N5,000 with a note" "$(send "$ORG" "$ORG2" 500000 7391 "$K1" "'Dinner'")" "ok"
expect_value "sender debited, recipient credited" "$(bal "$ORG")/$(bal "$ORG2")" "9500000/500000"
expect_value "money is conserved" "$(total)" "$TOTAL0"
REF=$(val "SELECT reference FROM public.wallet_transfers WHERE idempotency_key = '$K1';")
expect_value "two ledger rows, one reference, opposite types" \
  "$(val "SELECT string_agg(type || ':' || user_id::text || ':' || amount_kobo, ',' ORDER BY type) FROM public.user_wallet_transactions WHERE reference_id = '$REF';")" \
  "transfer_in:$ORG2:500000,transfer_out:$ORG:500000"
expect_value "ledger descriptions and counterparties" \
  "$(val "SELECT string_agg(description || '|' || (metadata->>'counterparty_username') || '|' || (metadata->>'note'), ',' ORDER BY type) FROM public.user_wallet_transactions WHERE reference_id = '$REF';")" \
  "Received from @ada|ada|Dinner,Sent to @bola|bola|Dinner"
expect_value "both users notified" "$(val "SELECT string_agg(title, ',' ORDER BY title) FROM public.notifications WHERE push_data->>'reference' = '$REF';")" "Money received,Money sent"
expect_value "every wallet equals its ledger" "$(ledger_ok)" "0"
expect_value "the receipt is visible to both parties" \
  "$(val "$(as "$ORG" "SELECT public.get_my_wallet_transfer('$REF')->>'direction';")")/$(val "$(as "$ORG2" "SELECT public.get_my_wallet_transfer('$REF')->>'direction';")")" "out/in"
expect_value "...and to no one else" "$(val "$(as "$USER" "SELECT COALESCE(public.get_my_wallet_transfer('$REF')::text, 'none');")")" "none"
expect_value "both histories show it (get_my_wallet_transactions)" \
  "$(val "$(as "$ORG" "SELECT type FROM public.get_my_wallet_transactions(5, 0) WHERE reference_id = '$REF';")")/$(val "$(as "$ORG2" "SELECT type FROM public.get_my_wallet_transactions(5, 0) WHERE reference_id = '$REF';")")" "transfer_out/transfer_in"

echo "== 4. Idempotency and duplicates =="
expect_value "the same key again: replayed, nothing moves" "$(send "$ORG" "$ORG2" 500000 7391 "$K1")/$(bal "$ORG")/$(bal "$ORG2")" "ok:replayed/9500000/500000"
expect_value "the same key for a different amount: refused" "$(send "$ORG" "$ORG2" 600000 7391 "$K1")" "idempotency_conflict"
expect_value "the same key for a different recipient: refused" "$(send "$ORG" "$USER" 500000 7391 "$K1")" "idempotency_conflict"
expect_value "a malformed key: refused" "$(send "$ORG" "$ORG2" 500000 7391 short)" "bad_request"

echo "== 5. Rules =="
expect_value "to yourself" "$(send "$ORG" "$ORG" 100000 7391 "$(tkey)")" "self"
expect_value "to a suspended account" "$(send "$ORG" "$X1" 100000 7391 "$(tkey)")" "recipient_unavailable"
expect_value "to a banned account" "$(send "$ORG" "$X2" 100000 7391 "$(tkey)")" "recipient_unavailable"
expect_value "to a deleted account" "$(send "$ORG" "$X3" 100000 7391 "$(tkey)")" "recipient_unavailable"
expect_value "below the minimum (N99.99)" "$(send "$ORG" "$ORG2" 9999 7391 "$(tkey)")" "amount_too_small"
expect_value "above the maximum (N200,000.01)" "$(send "$ORG" "$ORG2" 20000001 7391 "$(tkey)")" "amount_too_large"
expect_value "zero / negative" "$(send "$ORG" "$ORG2" 0 7391 "$(tkey)")/$(send "$ORG" "$ORG2" -500 7391 "$(tkey)")" "amount_too_small/amount_too_small"
expect_value "a note over 140 characters" "$(send "$ORG" "$ORG2" 100000 7391 "$(tkey)" "'$(printf 'x%.0s' $(seq 1 141))'")" "note_too_long"
expect_value "more than the balance: refused, nothing moves" "$(send "$USER" "$ORG2" 600000 5937 "$(tkey)")/$(bal "$USER")" "insufficient_funds/500000"
expect_value "an account under 24 hours old" "$(send "$NEWBIE" "$ORG2" 100000 6152 "$(tkey)")" "account_too_new"
"${PSQL[@]}" -q -c "UPDATE public.users SET status = 'suspended' WHERE id = '$USER';"
expect_value "a suspended sender" "$(send "$USER" "$ORG2" 100000 5937 "$(tkey)")" "sender_unavailable"
"${PSQL[@]}" -q -c "UPDATE public.users SET status = 'active' WHERE id = '$USER';"
expect_value "an unverified email" \
  "$("${PSQL[@]}" -tA -c "BEGIN; CREATE OR REPLACE FUNCTION public.is_email_verified() RETURNS boolean LANGUAGE sql STABLE AS \$\$ SELECT false \$\$; $(as_jwt "$USER" '{}' "SELECT public.transfer_wallet_funds('$ORG2', 100000, NULL, '5937', '$(tkey)')->>'code';") ROLLBACK;" 2>"$ERR" | grep -x 'email_not_verified')" "email_not_verified"
expect_value "no PIN yet" "$(send "$X4" "$ORG2" 100000 1111 "$(tkey)")" "pin_not_set"
expect_value "nothing moved by any refusal" "$(bal "$ORG")/$(bal "$ORG2")/$(bal "$USER")/$(ledger_ok)" "9500000/500000/500000/0"

echo "== 6. PIN =="
expect_value "wrong PIN: refused, attempts left shown" "$(val "$(as "$USER" "SELECT public.transfer_wallet_funds('$ORG2', 100000, NULL, '0000', '$(tkey)')->>'attempts_left';")")" "4"
expect_value "...the attempt is counted and committed; nothing moved" "$(val "SELECT failed_attempts FROM public.withdrawal_pins WHERE user_id = '$USER';")/$(bal "$USER")" "1/500000"
for i in 1 2 3; do send "$USER" "$ORG2" 100000 0000 "$(tkey)" >/dev/null; done
expect_value "the 5th wrong PIN locks it" "$(send "$USER" "$ORG2" 100000 0000 "$(tkey)")" "pin_locked"
expect_value "while locked, the right PIN is refused too" "$(send "$USER" "$ORG2" 100000 5937 "$(tkey)")/$(bal "$USER")" "pin_locked/500000"
"${PSQL[@]}" -q -c "UPDATE public.withdrawal_pins SET locked_until = NULL, failed_attempts = 0, lockouts = 0, reset_at = now() WHERE user_id = '$USER';"
expect_value "within 24 hours of a PIN reset: paused" "$(send "$USER" "$ORG2" 100000 5937 "$(tkey)")" "pin_recently_reset"
"${PSQL[@]}" -q -c "UPDATE public.withdrawal_pins SET reset_at = now() - interval '25 hours' WHERE user_id = '$USER';"
expect_value "after the pause it works" "$(send "$USER" "$ORG2" 100000 5937 "$(tkey)")/$(bal "$USER")" "ok/400000"

echo "== 7. Daily limits =="
"${PSQL[@]}" -q -c "INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$ADMIN_B', 0) ON CONFLICT DO NOTHING;"
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits;"
expect_value "a N20,000 transfer" "$(send "$ORG" "$ORG2" 2000000 7391 "$(tkey)")" "ok"
deposit "$ORG" 80000000
expect_value "N200,000 + N200,000 ok; then N100,000 (N5,000 + N20,000 already sent: over N500,000 in 24h) refused" \
  "$(send "$ORG" "$ORG2" 20000000 7391 "$(tkey)")/$(send "$ORG" "$ORG2" 20000000 7391 "$(tkey)")/$(send "$ORG" "$ORG2" 10000000 7391 "$(tkey)")" "ok/ok/daily_amount_limit"
expect_value "today's usage is reported" "$(val "$(as "$ORG" "SELECT (public.get_my_wallet_transfer_status()->>'sent_today_kobo') || '/' || (public.get_my_wallet_transfer_status()->>'sent_today_count');")")" "42500000/4"
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits;"
for i in $(seq 1 16); do send "$ORG" "$ORG2" 10000 7391 "$(tkey)" >/dev/null; done
expect_value "the 21st transfer in 24 hours is refused" "$(send "$ORG" "$ORG2" 10000 7391 "$(tkey)")" "daily_count_limit"
expect_value "every wallet equals its ledger" "$(ledger_ok)" "0"

echo "== 8. Attempt rate limit =="
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits;"
for i in $(seq 1 30); do send "$X5" "$ORG2" 100000 1111 "$(tkey)" >/dev/null; done
expect_error "the 31st attempt in an hour is rate-limited" "rate_limited" "$(as "$X5" "SELECT public.transfer_wallet_funds('$ORG2', 100000, NULL, '1111', '$(tkey)');")"
for i in $(seq 1 60); do lookup "$X5" bola >/dev/null; done
expect_error "the 61st lookup in an hour is rate-limited" "rate_limited" "$(as "$X5" "SELECT public.find_wallet_transfer_recipient('bola');")"

echo "== 9. Concurrency =="
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits; UPDATE public.users SET created_at = now() - interval '2 days' WHERE id = '$NEWBIE';"
TOTAL1=$(total)   # NEWBIE holds N5,000
for k in c1 c2 c3 c4; do
  ( val "$(as_jwt "$NEWBIE" '{}' "SELECT COALESCE(CASE WHEN (r->>'ok')::boolean THEN 'ok' ELSE r->>'code' END, 'none') FROM (SELECT public.transfer_wallet_funds('$USER', 350000, NULL, '6152', 'concurrent-overspend-$k-000000') r) s;")" > "$TMP/c_$k" ) &
done; wait
expect_value "4 parallel transfers of 70% of the balance: exactly one succeeds" "$(cat "$TMP"/c_c* | sort | uniq -c | tr -s ' ' | sed 's/^ //' | tr '\n' ',')" "3 insufficient_funds,1 ok,"
expect_value "...the balance never went negative; money conserved" "$(bal "$NEWBIE")/$(total)" "150000/$TOTAL1"
for k in 1 2 3 4 5; do
  ( val "$(as_jwt "$NEWBIE" '{}' "SELECT CASE WHEN (r->>'ok')::boolean THEN 'ok' ELSE r->>'code' END FROM (SELECT public.transfer_wallet_funds('$ORG2', 10000, NULL, '6152', 'same-key-parallel-00000001') r) s;")" > "$TMP/s_$k" ) &
done; wait
expect_value "5 parallel retries with one key: one transfer, all told ok" \
  "$(val "SELECT count(*) FROM public.wallet_transfers WHERE idempotency_key = 'same-key-parallel-00000001';")/$(cat "$TMP"/s_* | sort -u | tr '\n' ',')/$(bal "$NEWBIE")" "1/ok,/140000"
# Opposite transfers at the same time: no deadlock, nothing lost.
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits;"
deposit "$USER" 2000000
TOTAL2=$(total)
for i in 1 2 3 4 5 6; do
  ( "${PSQL[@]}" -tA -c "$(as_jwt "$USER" '{}' "SELECT public.transfer_wallet_funds('$ORG2', 10000, NULL, '5937', 'opposite-a-$i-0000000000')->>'ok';")" >"$TMP/oa_$i" 2>&1 ) &
  ( "${PSQL[@]}" -tA -c "$(as_jwt "$ORG2" '{}' "SELECT public.transfer_wallet_funds('$USER', 10000, NULL, '4826', 'opposite-b-$i-0000000000')->>'ok';")" >"$TMP/ob_$i" 2>&1 ) &
done; wait
expect_value "12 opposite transfers in parallel: all complete, no deadlock" "$(cat "$TMP"/oa_* "$TMP"/ob_* | grep -c '^true$')/$(cat "$TMP"/oa_* "$TMP"/ob_* | grep -ci deadlock)" "12/0"
expect_value "money conserved; every wallet equals its ledger" "$(total)/$(ledger_ok)" "$TOTAL2/0"

echo "== 10. Received money is spendable at once; earnings untouched =="
"${PSQL[@]}" -q -c "DELETE FROM public.rate_limits;"
expect_value "earnings wallets were never touched by transfers" "$(val "SELECT md5(string_agg(organizer_id::text || balance_kobo || '/' || pending_kobo, ',' ORDER BY organizer_id)) FROM public.organizer_wallets;")" "$ORGW_BEFORE"
P1=$(val "$(as "$X5" "SELECT public.create_pending_purchase('$EV', 'Regular', '[{\"name\": \"A\"}]'::jsonb, NULL)->>'payment_ref';")")
COST=$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$P1';")
"${PSQL[@]}" -q -c "INSERT INTO public.withdrawal_pins (user_id, pin_hash) SELECT '$ORG2', pin_hash FROM public.withdrawal_pins WHERE user_id = '$ORG2' ON CONFLICT DO NOTHING;"
expect_value "Bola sends X5 exactly a ticket's price" "$(send "$ORG2" "$X5" "$COST" 4826 "$(tkey)")/$(bal "$X5")" "ok/$COST"
expect_value "X5 buys the ticket with it right away (existing wallet checkout)" "$(val "$(as "$X5" "SELECT public.confirm_ticket_payment_via_wallet('$P1');")")/$(bal "$X5")" "confirmed/0"
TID=$(val "SELECT id FROM public.tickets WHERE payment_ref = '$P1' LIMIT 1;")
expect_value "a refund returns it to X5's wallet (existing refund path)" "$(val "$(as "$ORG2" "SELECT public.refund_ticket('$TID', 'cancelled')->>'amount_kobo';")")/$(bal "$X5")" "$COST/$COST"
expect_value "every wallet equals its ledger (deposits, transfers, spends, refunds)" "$(ledger_ok)" "0"

echo "== 11. Records are immutable; account deletion keeps the other side =="
expect_error "a transfer cannot be changed" "audit trail" "UPDATE public.wallet_transfers SET amount_kobo = 1 WHERE reference = '$REF';"
expect_error "...or deleted" "audit trail" "DELETE FROM public.wallet_transfers WHERE reference = '$REF';"
"${PSQL[@]}" -q -c "INSERT INTO public.users (id, role, full_name, email, username) VALUES ('00000000-0000-0000-0000-000000000e99', 'user', 'Temp', 't@example.test', 'temp99'); UPDATE public.users SET created_at = now() - interval '2 days' WHERE id = '00000000-0000-0000-0000-000000000e99';" >/dev/null
expect_value "send to a soon-deleted account" "$(send "$ORG2" '00000000-0000-0000-0000-000000000e99' 10000 4826 "$(tkey)")" "ok"
TREF=$(val "SELECT reference FROM public.wallet_transfers WHERE original_recipient_id = '00000000-0000-0000-0000-000000000e99';")
"${PSQL[@]}" -q -c "UPDATE public.user_wallets SET balance_kobo = 0 WHERE user_id = '00000000-0000-0000-0000-000000000e99'; DELETE FROM public.withdrawal_pins WHERE user_id = '00000000-0000-0000-0000-000000000e99';" >/dev/null 2>&1
if "${PSQL[@]}" -q -c "DELETE FROM public.user_wallet_transactions WHERE user_id = '00000000-0000-0000-0000-000000000e99'; DELETE FROM public.user_wallets WHERE user_id = '00000000-0000-0000-0000-000000000e99'; DELETE FROM public.notifications WHERE user_id = '00000000-0000-0000-0000-000000000e99'; DELETE FROM public.users WHERE id = '00000000-0000-0000-0000-000000000e99';" >"$OUT" 2>"$ERR"; then
  expect_value "hard-deleting the recipient keeps the transfer (party set NULL, original kept)" \
    "$(val "SELECT (recipient_id IS NULL)::text || '/' || original_recipient_id::text || '/' || recipient_username FROM public.wallet_transfers WHERE reference = '$TREF';")" "true/00000000-0000-0000-0000-000000000e99/temp99"
  expect_value "...and the sender's receipt still works" "$(val "$(as "$ORG2" "SELECT public.get_my_wallet_transfer('$TREF')->'recipient'->>'username';")")" "temp99"
else fail "hard-delete of a transfer party"; cat "$ERR" >&2; fi

echo "== 12. Rollback with transfers =="
N_TR=$(val "SELECT count(*) FROM public.wallet_transfers;"); BALS=$(val "SELECT md5(string_agg(user_id::text || balance_kobo, ',' ORDER BY user_id)) FROM public.user_wallets;")
expect_ok "undo_0215 with transfers on record" "SET vents.rollback_confirm = 'undo-0215'; $(cat "$U15")"
expect_value "no transfer function remains" "$(val "SELECT count(*) FROM pg_proc WHERE proname IN ('transfer_wallet_funds', 'find_wallet_transfer_recipient', 'get_my_wallet_transfer_status');")" "0"
expect_value "records, ledger and balances kept; switch off" \
  "$(val "SELECT count(*) FROM public.wallet_transfers;")/$(val "SELECT md5(string_agg(user_id::text || balance_kobo, ',' ORDER BY user_id)) FROM public.user_wallets;")/$(val "SELECT public.wallet_transfers_disabled()::text;")/$(ledger_ok)" "$N_TR/$BALS/true/0"
expect_ok "0215 re-applies on top" "$(cat "$M15")"
expect_value "transfers stay off until the VENTS Admin turns them on again" "$(val "SELECT public.wallet_transfers_disabled()::text;")" "true"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL $PASSES WALLET TRANSFER (0215) CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1
fi
