#!/usr/bin/env bash
# Real-execution verification of migration 0211 (withdrawal PIN and the
# two-admin withdrawal approval for admins and sub-admins):
#
#   PIN       create + confirm, weak/mismatch/format refusals, bcrypt hash bound
#             to the user, never readable by clients, wrong PIN counted and
#             committed, 30-minute lock after 5, reset required after 3 locks,
#             reset only with a password entered in the last 5 minutes (amr),
#             24-hour pause after a reset, the old entry point closed;
#   requests  minimum, insufficient balance, idempotent replay, duplicate
#             refusal, two concurrent requests -> one;
#   approvals first approval by an admin or sub-admin, one open first approval
#             per withdrawal, never the withdrawing user, the first approver
#             cannot give the second, two sub-admins cannot authorize alone,
#             bank change between approvals refused, forged approvals refused
#             by the 0205 guard, concurrent second approvals -> one, nothing
#             claimable for Paystack before both approvals, concurrent claims
#             -> one, rejection closes an open first approval and returns the
#             money, admins and sub-admins see the same authoritative state;
#   and the ledger reconciles, 0211 is idempotent, undo_0211 restores the
#   exact pre-0211 database and 0211 re-applies to the same state.
#
# Builds the 0201..0210 stack exactly as run-release-stack-verification.sh
# does. No network, no Paystack: Paystack outcomes are the RPC calls the
# webhook and API make.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files.
#
# Usage: scripts/local-pg-test/run-withdrawal-pin-approval-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_withdrawal_pin"
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
  ('$USER', 'user', false, 'Plain User', 'u@example.test', 'plain');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES
  ('$BANK', '$ORG', 'GTBank', '058', '0123456789', 'ADA ORGANIZER', 'RCP_ada', true),
  ('$BANK2', '$ORG2', 'Access', '044', '0987654321', 'BOLA ORGANIZER', 'RCP_bola', true),
  ('$BANK_OA', '$ORG_ADMIN', 'Zenith', '057', '0111111111', 'CHI', 'RCP_chi', true);
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo) VALUES
  ('$ORG', 10000000, 0, 10000000), ('$ORG2', 5000000, 0, 5000000), ('$ORG_ADMIN', 2000000, 0, 2000000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES
  ('$ORG', 'credit', 10000000, 'ticket sales'), ('$ORG2', 'credit', 5000000, 'ticket sales'),
  ('$ORG_ADMIN', 'credit', 2000000, 'ticket sales');
SQL

STATE_SQL="SELECT md5(string_agg(p.oid::regprocedure::text || ':' || p.prosrc || ':' || COALESCE(array_to_string(p.proacl, ','), ''), '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT md5(string_agg(conrelid::regclass::text || conname || pg_get_constraintdef(oid), '|' ORDER BY conrelid::regclass::text, conname)) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text NOT LIKE '%withdrawal_pin%') || '/' || (SELECT md5(string_agg(table_name || '.' || column_name || COALESCE(column_default, ''), '|' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema = 'public' AND table_name NOT LIKE 'withdrawal_pin%') || '/' || (SELECT md5(string_agg(tgrelid::regclass::text || tgname, '|' ORDER BY tgrelid::regclass::text, tgname)) FROM pg_trigger WHERE NOT tgisinternal) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
PRE_0211=$(val "$STATE_SQL")
GUARD_0205=$(val "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.organizer_withdrawal_requests_guard()'::regprocedure;")
EXEC_0203=$(val "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.execute_withdrawal_authorization(uuid)'::regprocedure;")
echo "info: 0205 guard md5 $GUARD_0205, 0203 executor md5 $EXEC_0203"

echo "== Before 0211: the defects it fixes =="
expect_ok "before: a client can call request_organizer_payout directly (no PIN, no minimum)" \
  "$(as "$ORG2" "SELECT public.request_organizer_payout(100, '$BANK2', 'pre-0211-tiny');")"
PRE_W=$(val "SELECT id FROM public.organizer_withdrawal_requests WHERE idempotency_key = 'pre-0211-tiny';")
PRE_AR=$(val "$(as "$SUB" "SELECT public.request_admin_action('authorize_withdrawal', 'withdrawal', '$PRE_W', 'pre', '{\"request_id\":\"$PRE_W\",\"amount_kobo\":100}'::jsonb)->>'id';")")
expect_error "before: a sub-admin's first approval can never be completed by a sub-admin" "Super Admin access required" \
  "$(as "$SUB2" "SELECT public.approve_admin_action('$PRE_AR');")"
expect_ok "before: a second, duplicate first approval for the same withdrawal is accepted" \
  "$(as "$ADMIN_A" "SELECT public.request_admin_action('authorize_withdrawal', 'withdrawal', '$PRE_W', 'pre', '{\"request_id\":\"$PRE_W\",\"amount_kobo\":100}'::jsonb);")"
expect_ok "before: a token issued seconds ago passes assert_recent_auth with no password at all" \
  "$(as_jwt "$ORG" "{\"iat\": $(now)}" "SELECT public.assert_recent_auth();")"
# Clear the pre-0211 demo state so 0211 starts from the production-like shape.
"${PSQL[@]}" -q -c "SET test.uid='$ADMIN_A'; SELECT public.admin_reject_organizer_payout('$PRE_W', 'demo');" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.admin_action_requests SET status = 'rejected' WHERE target_id = '$PRE_W' AND status = 'pending';"
PRE_0211=$(val "$STATE_SQL")
FN_LIST="SELECT p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || COALESCE(array_to_string(p.proacl, ','), '-') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1;"
"${PSQL[@]}" -tA -c "$FN_LIST" > "$TMP/fn_pre"

echo "== Applying 0211 =="
TMP_MIG="$TMP/0211.sql"
cp "$MIG/0211_withdrawal_pin_and_two_admin_approval.sql" "$TMP_MIG"
expect_ok "0211 applies on top of 0203..0210 (drift guard passes on the shipped 0203/0205 bodies)" "$(cat "$TMP_MIG")"
POST_0211=$(val "$STATE_SQL")
expect_ok "0211 is idempotent (second run)" "$(cat "$TMP_MIG")"
expect_value "a second run of 0211 changes nothing" "$(val "$STATE_SQL")" "$POST_0211"
GUARD_0211=$(val "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.organizer_withdrawal_requests_guard()'::regprocedure;")
EXEC_0211=$(val "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.execute_withdrawal_authorization(uuid)'::regprocedure;")
echo "info: 0211 guard md5 $GUARD_0211, 0211 executor md5 $EXEC_0211"
expect_error "drift guard: refuses when the guard differs from 0205 and from 0211" "differs from 0205" \
  "CREATE OR REPLACE FUNCTION public.organizer_withdrawal_requests_guard() RETURNS trigger LANGUAGE plpgsql AS \$x\$ BEGIN RETURN NEW; END \$x\$; $(cat "$TMP_MIG")"

echo "== 1. Withdrawal PIN =="
expect_value "a new user has no PIN" "$(val "$(as "$ORG" "SELECT (public.get_my_withdrawal_pin_status()->>'has_pin');")")" "false"
expect_value "withdrawing without a PIN is refused" "$(withdraw "$ORG" 500000 "$BANK" 1111 k0)" "pin_not_set"
expect_error "the old entry point is closed to clients" "permission denied for function request_organizer_payout" \
  "$(as "$ORG" "SELECT public.request_organizer_payout(500000, '$BANK', 'bypass');")"
expect_error "PIN must be 4 digits (3 digits)" "exactly 4 digits" "$(as "$ORG" "SELECT public.set_my_withdrawal_pin('739', '739');")"
expect_error "PIN must be 4 digits (letters)" "exactly 4 digits" "$(as "$ORG" "SELECT public.set_my_withdrawal_pin('73a1', '73a1');")"
expect_error "PIN must be confirmed (mismatch)" "do not match" "$(as "$ORG" "SELECT public.set_my_withdrawal_pin('7391', '7392');")"
for weak in 1111 1234 4321 1212 0000 6789; do
  expect_error "weak PIN $weak is refused" "too easy to guess" "$(as "$ORG" "SELECT public.set_my_withdrawal_pin('$weak', '$weak');")"
done
expect_value "PIN created after confirmation" "$(val "$(as "$ORG" "SELECT (public.set_my_withdrawal_pin('7391', '7391')->>'has_pin');")")" "true"
expect_error "a second create is refused (change needs the password)" "already have a withdrawal PIN" \
  "$(as "$ORG" "SELECT public.set_my_withdrawal_pin('5820', '5820');")"
expect_value "stored as a bcrypt hash, never the PIN" \
  "$(val "SELECT (pin_hash LIKE '\$2a\$10\$%' AND position('7391' IN pin_hash) = 0 AND length(pin_hash) = 60)::text FROM public.withdrawal_pins WHERE user_id = '$ORG';")" "true"
expect_error "clients cannot read the PIN table" "permission denied for table withdrawal_pins" \
  "$(as "$ORG" "SELECT pin_hash FROM public.withdrawal_pins;")"
expect_error "clients cannot call the internal PIN check" "permission denied for function withdrawal_pin_check" \
  "$(as "$ORG" "SELECT public.withdrawal_pin_check('$ORG', '7391');")"
expect_value "the status never contains the PIN or its hash" \
  "$(val "$(as "$ORG" "SELECT (position('7391' IN public.get_my_withdrawal_pin_status()::text) = 0 AND position('\$2a\$' IN public.get_my_withdrawal_pin_status()::text) = 0)::text;")")" "true"
expect_value "the hash is bound to its user (copied to another account, it never matches)" \
  "$(val "SELECT public.withdrawal_pin_matches('$ORG2', '7391', pin_hash)::text || '/' || public.withdrawal_pin_matches('$ORG', '7391', pin_hash)::text FROM public.withdrawal_pins WHERE user_id = '$ORG';")" "false/true"

echo "-- wrong PIN, lockout, reset required --"
expect_value "wrong PIN: refused with 4 attempts left" "$(val "$(as "$ORG" "SELECT public.request_withdrawal(500000, '$BANK', '0007', 'w1')->>'attempts_left';")")" "4"
expect_value "the failed attempt is committed (not rolled back)" "$(val "SELECT failed_attempts FROM public.withdrawal_pins WHERE user_id = '$ORG';")" "1"
expect_value "no withdrawal and no money moved on a wrong PIN" "$(val "SELECT count(*) FROM public.organizer_withdrawal_requests WHERE organizer_id = '$ORG';")/$(wallet "$ORG")" "0/10000000/0"
for i in 2 3 4; do withdraw "$ORG" 500000 "$BANK" 0007 "w$i" >/dev/null; done
expect_value "5th wrong PIN locks withdrawals for 30 minutes" "$(withdraw "$ORG" 500000 "$BANK" 0007 w5)" "pin_locked"
expect_value "while locked, even the correct PIN is refused" "$(withdraw "$ORG" 500000 "$BANK" 7391 w6)" "pin_locked"
expect_value "lock lasts 30 minutes" "$(val "SELECT (locked_until BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes')::text FROM public.withdrawal_pins WHERE user_id = '$ORG';")" "true"
expect_value "status shows the lock" "$(val "$(as "$ORG" "SELECT (public.get_my_withdrawal_pin_status()->>'locked');")")" "true"
"${PSQL[@]}" -q -c "UPDATE public.withdrawal_pins SET locked_until = now() - interval '1 second' WHERE user_id = '$ORG';"
for lock in 2 3; do
  for i in 1 2 3 4 5; do withdraw "$ORG" 500000 "$BANK" 0007 "l$lock$i" >/dev/null; done
  [ "$lock" = 2 ] && "${PSQL[@]}" -q -c "UPDATE public.withdrawal_pins SET locked_until = now() - interval '1 second' WHERE user_id = '$ORG';"
done
expect_value "the 3rd lock in a row requires a reset" "$(withdraw "$ORG" 500000 "$BANK" 7391 w7)" "pin_reset_required"
expect_value "status: must reset" "$(val "$(as "$ORG" "SELECT (public.get_my_withdrawal_pin_status()->>'must_reset');")")" "true"
expect_value "a 'Withdrawal PIN locked' notification was sent" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND title = 'Withdrawal PIN locked';")" "1"
expect_value "PIN events are audited (created, failed, locked, reset_required)" \
  "$(val "SELECT string_agg(DISTINCT event, ',' ORDER BY event) FROM public.withdrawal_pin_events WHERE user_id = '$ORG';")" "created,failed,locked,reset_required"

echo "-- reset needs the password entered in the last 5 minutes --"
expect_error "reset with no password confirmation is refused" "PASSWORD_CONFIRMATION_REQUIRED" \
  "$(as "$ORG" "SELECT public.reset_my_withdrawal_pin('5820', '5820');")"
expect_error "reset with a freshly refreshed token (new iat, old password) is refused" "PASSWORD_CONFIRMATION_REQUIRED" \
  "$(as_jwt "$ORG" "{\"iat\": $(now), \"amr\": [{\"method\": \"password\", \"timestamp\": $(( $(now) - 3600 ))}]}" "SELECT public.reset_my_withdrawal_pin('5820', '5820');")"
expect_error "reset after an OTP sign-in (no password) is refused" "PASSWORD_CONFIRMATION_REQUIRED" \
  "$(as_jwt "$ORG" "{\"iat\": $(now), \"amr\": [{\"method\": \"otp\", \"timestamp\": $(now)}]}" "SELECT public.reset_my_withdrawal_pin('5820', '5820');")"
expect_error "reset still validates the new PIN" "too easy to guess" \
  "$(as_jwt "$ORG" "{\"amr\": [{\"method\": \"password\", \"timestamp\": $(now)}]}" "SELECT public.reset_my_withdrawal_pin('2222', '2222');")"
expect_value "reset with the password just confirmed works and clears the lock" \
  "$(val "$(as_jwt "$ORG" "{\"amr\": [{\"method\": \"password\", \"timestamp\": $(now)}]}" "SELECT (public.reset_my_withdrawal_pin('5820', '5820')->>'locked');")")" "false"
expect_value "the old PIN no longer works" "$(withdraw "$ORG" 500000 "$BANK" 7391 w8)" "wrong_pin"
expect_value "after a reset, withdrawals pause for 24 hours" "$(withdraw "$ORG" 500000 "$BANK" 5820 w9)" "pin_recently_reset"
expect_value "the user was told the PIN changed" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND title = 'Withdrawal PIN changed';")" "1"
"${PSQL[@]}" -q -c "UPDATE public.withdrawal_pins SET reset_at = now() - interval '24 hours 1 minute' WHERE user_id = '$ORG';"

echo "-- bank account changes need the password too (assert_recent_auth) --"
expect_error "a freshly refreshed token no longer passes assert_recent_auth" "PASSWORD_CONFIRMATION_REQUIRED" \
  "$(as_jwt "$ORG" "{\"iat\": $(now)}" "SELECT public.assert_recent_auth();")"
expect_ok "a password entered seconds ago passes assert_recent_auth" \
  "$(as_jwt "$ORG" "{\"amr\": [{\"method\": \"password\", \"timestamp\": $(now)}]}" "SELECT public.assert_recent_auth();")"

echo "== 2. Withdrawal requests =="
expect_value "below the ₦100 minimum is refused" "$(withdraw "$ORG" 9999 "$BANK" 5820 m1)" "amount_too_small"
expect_error "more than the balance is refused" "Insufficient balance" \
  "$(as "$ORG" "SELECT public.request_withdrawal(99999999, '$BANK', '5820', 'm2');")"
expect_error "another user's bank account is refused" "Bank account not verified" \
  "$(as "$ORG" "SELECT public.request_withdrawal(500000, '$BANK2', '5820', 'm3');")"
W1=$(withdraw_id "$ORG" 3000000 "$BANK" 5820 key-w1)
expect_value "correct PIN: withdrawal created, ₦30,000 moved to pending" "$([ -n "$W1" ] && echo yes)/$(wallet "$ORG")" "yes/7000000/3000000"
expect_value "a retry with the same key returns the same request, no second debit" \
  "$(withdraw_id "$ORG" 3000000 "$BANK" 5820 key-w1)/$(wallet "$ORG")" "$W1/7000000/3000000"
expect_value "the identical request again (new key, moments later) is refused as a duplicate" "$(withdraw "$ORG" 3000000 "$BANK" 5820 key-w1b)" "duplicate_withdrawal"
expect_value "the user was told it waits for two admins" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND title = 'Withdrawal requested';")" "1"
expect_value "the user's history shows it waiting for its first approval, account masked" \
  "$(val "$(as "$ORG" "SELECT stage || '|' || account_number_masked FROM public.get_my_withdrawals() WHERE request_id = '$W1';")")" "pending_first_approval|****6789"
expect_value "users never see another user's withdrawals" "$(val "$(as "$ORG2" "SELECT count(*) FROM public.get_my_withdrawals() WHERE request_id = '$W1';")")" "0"

echo "-- two concurrent requests from one user (different keys, same amount) -> one --"
"${PSQL[@]}" -q -c "$(as "$ORG2" "SELECT public.set_my_withdrawal_pin('4826', '4826');")" >/dev/null
for k in c1 c2; do
  ( "${PSQL[@]}" -tA -c "$(as "$ORG2" "SELECT COALESCE(r->>'code', 'ok') FROM (SELECT public.request_withdrawal(1000000, '$BANK2', '4826', '$k') r) s;")" > "$TMP/conc_$k" 2>&1 ) &
done
wait
expect_value "exactly one concurrent request went through, the other was refused as a duplicate" \
  "$(cat "$TMP/conc_c1" "$TMP/conc_c2" | grep -E '^(ok|duplicate_withdrawal)$' | sort | tr '\n' ',')$(val "SELECT count(*) FROM public.organizer_withdrawal_requests WHERE organizer_id = '$ORG2' AND idempotency_key IN ('c1','c2');")/$(wallet "$ORG2")" \
  "duplicate_withdrawal,ok,1/4000000/1000000"
W2=$(val "SELECT id FROM public.organizer_withdrawal_requests WHERE organizer_id = '$ORG2' AND idempotency_key IN ('c1','c2');")

echo "== 3. Two-admin approval =="
expect_error "a non-admin cannot list withdrawals" "Admin access required" "$(as "$USER" "SELECT * FROM public.admin_list_withdrawals();")"
expect_error "a non-admin cannot give a first approval" "Admin access required" "$(first "$USER" "$W1" 3000000)"
expect_error "a non-admin cannot give a second approval" "Admin access required" "$(second "$ORG" "$W1")"
VIEW="SELECT md5(string_agg(request_id::text || stage || status || amount_kobo || COALESCE(first_approved_by::text, '-') || COALESCE(second_approved_by::text, '-'), '|' ORDER BY request_id)) FROM public.admin_list_withdrawals('all')"
expect_value "admins and sub-admins see the same authoritative list" "$(val "$(as "$SUB" "$VIEW")")" "$(val "$(as "$ADMIN_A" "$VIEW")")"
expect_value "stage: pending first approval (both views)" "$(stage_for "$SUB" "$W1")/$(stage_for "$ADMIN_B" "$W1")" "pending_first_approval/pending_first_approval"
expect_error "nothing can be claimed for Paystack before any approval" "needs a second admin" "$(as "$ADMIN_A" "SELECT * FROM public.admin_claim_payout_for_processing('$W1');")"
expect_error "a first approval for a different amount is refused" "does not match" "$(first "$SUB" "$W1" 100)"
expect_ok "a sub-admin gives the first approval" "$(first "$SUB" "$W1" 3000000)"
expect_value "stage: pending second approval, first approver recorded (both views)" \
  "$(stage_for "$SUB" "$W1")/$(stage_for "$ADMIN_A" "$W1")/$(val "$(as "$ADMIN_A" "SELECT first_approved_by_name || '/' || first_approved_by_tier FROM public.admin_list_withdrawals() WHERE request_id = '$W1';")")" \
  "pending_second_approval/pending_second_approval/Sub One/sub"
expect_value "the user sees it waiting for its second approval" "$(my_stage "$ORG" "$W1")" "pending_second_approval"
expect_value "the first approval recorded the bank recipient it reviewed" \
  "$(val "SELECT payload->>'recipient_code' FROM public.admin_action_requests WHERE target_id = '$W1' AND status = 'pending';")" "RCP_ada"
expect_error "a second first approval for the same withdrawal is refused" "already has a first approval" "$(first "$ADMIN_A" "$W1" 3000000)"
expect_error "...also through the raw request_admin_action" "already has a first approval" \
  "$(as "$ADMIN_B" "SELECT public.request_admin_action('authorize_withdrawal', 'withdrawal', '$W1', 'x', '{\"request_id\":\"$W1\",\"amount_kobo\":3000000}'::jsonb);")"
expect_error "the first approver cannot give the second approval" "You gave the first approval" "$(second "$SUB" "$W1")"
expect_error "two sub-admins cannot authorize a withdrawal alone" "two sub-admins cannot authorize" "$(second "$SUB2" "$W1")"
expect_value "the other sub-admin's dashboard says why, with no approve button" \
  "$(val "$(as "$SUB2" "SELECT can_second_approve::text || '|' || action_note FROM public.admin_list_withdrawals() WHERE request_id = '$W1';")")" \
  "false|The first approval came from a sub-admin, so the second must come from a full admin."
expect_value "a full admin's dashboard offers the second approval" \
  "$(val "$(as "$ADMIN_A" "SELECT can_second_approve::text || '|' || can_pay::text FROM public.admin_list_withdrawals() WHERE request_id = '$W1';")")" "true|false"
expect_error "still nothing claimable for Paystack after one approval" "needs a second admin" "$(as "$ADMIN_A" "SELECT * FROM public.admin_claim_payout_for_processing('$W1');")"
expect_error "a forged approval written straight into the table is refused (0205 guard)" "can only be recorded" \
  "UPDATE public.organizer_withdrawal_requests SET approved_by = '$ADMIN_B', approval_requested_by = '$SUB', approved_at = now(), approved_recipient_code = 'RCP_ada', approval_request_id = (SELECT id FROM public.admin_action_requests WHERE target_id = '$W1' AND status = 'pending') WHERE id = '$W1';"
expect_error "a raw UPDATE cannot jump to processing either" "needs two-admin authorization" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'processing' WHERE id = '$W1';"

echo "-- concurrent second approvals by two full admins -> one --"
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_A" "SELECT public.admin_approve_withdrawal('$W1')->>'stage'; SELECT pg_sleep(0.5);")" > "$TMP/sa_a" 2>&1 || echo ERR >> "$TMP/sa_a" ) &
( sleep 0.1; "${PSQL[@]}" -tA -c "$(as "$ADMIN_B" "SELECT public.admin_approve_withdrawal('$W1')->>'stage';")" > "$TMP/sa_b" 2>&1 || echo ERR >> "$TMP/sa_b" ) &
wait
expect_value "exactly one second approval succeeded; the other was refused" \
  "$(cat "$TMP/sa_a" "$TMP/sa_b" | grep -cE '^approved$')/$(cat "$TMP/sa_a" "$TMP/sa_b" | grep -c 'already has both approvals')" "1/1"
expect_value "stage: approved, both approvers recorded, the first-approval request closed as approved" \
  "$(stage_for "$SUB" "$W1")/$(val "SELECT (approval_requested_by = '$SUB' AND approved_by IN ('$ADMIN_A', '$ADMIN_B') AND approved_recipient_code = 'RCP_ada')::text FROM public.organizer_withdrawal_requests WHERE id = '$W1';")/$(val "SELECT status FROM public.admin_action_requests WHERE target_id = '$W1' AND action_type = 'authorize_withdrawal';")" \
  "approved/true/approved"
expect_value "the user was told it was approved" "$(my_stage "$ORG" "$W1")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND title = 'Withdrawal approved';")" "approved/1"
expect_error "a third approval is refused" "already has both approvals" "$(second "$SUB2" "$W1")"
expect_error "the approval can never be changed or cleared" "cannot be changed or cleared" \
  "UPDATE public.organizer_withdrawal_requests SET approved_by = NULL WHERE id = '$W1';"
expect_value "admins and sub-admins still see the same state" "$(val "$(as "$SUB2" "$VIEW")")" "$(val "$(as "$ADMIN_B" "$VIEW")")"

echo "-- payout: one claim, only after both approvals, paid only on Paystack success --"
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_A" "SELECT claimed::text FROM public.admin_claim_payout_for_processing('$W1'); SELECT pg_sleep(0.5);")" > "$TMP/cl_a" 2>&1 ) &
( sleep 0.1; "${PSQL[@]}" -tA -c "$(as "$SUB" "SELECT claimed::text FROM public.admin_claim_payout_for_processing('$W1');")" > "$TMP/cl_b" 2>&1 ) &
wait
expect_value "two concurrent pay clicks: exactly one claim (one Paystack transfer)" "$(cat "$TMP/cl_a" "$TMP/cl_b" | grep -cE '^true$')/$(cat "$TMP/cl_a" "$TMP/cl_b" | grep -cE '^false$')" "1/1"
expect_value "stage: processing (not paid) until Paystack confirms" "$(stage_for "$ADMIN_A" "$W1")/$(my_stage "$ORG" "$W1")" "processing/processing"
REF=$(val "SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$W1';")
"${PSQL[@]}" -q -c "SELECT * FROM public.complete_organizer_payout('$REF');" >/dev/null
expect_value "Paystack transfer.success -> paid; pending cleared; ledger reconciles" \
  "$(my_stage "$ORG" "$W1")/$(wallet "$ORG")/$(reconciled)" "paid/7000000/0/0"

echo "-- admin first, sub-admin second; and the payout can fail --"
"${PSQL[@]}" -q -c "$(first "$ADMIN_B" "$W2" 1000000)" >/dev/null
expect_ok "a sub-admin can give the second approval after a full admin's first" "$(second "$SUB" "$W2")"
expect_value "...and it is approved" "$(stage_for "$SUB2" "$W2")" "approved"
expect_value "claimed" "$(claim "$SUB2" "$W2")" "true"
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET transfer_code = 'TRF_x' WHERE id = '$W2';"
REF2=$(val "SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = '$W2';")
"${PSQL[@]}" -q -c "SELECT * FROM public.fail_organizer_payout('$REF2', 'Paystack transfer.failed');" >/dev/null 2>"$ERR" || \
  "${PSQL[@]}" -q -c "SELECT public.fail_organizer_payout('$REF2', 'Paystack transfer.failed');" >/dev/null
expect_value "Paystack transfer.failed -> failed (never paid), money back in the balance" \
  "$(my_stage "$ORG2" "$W2")/$(wallet "$ORG2")/$(reconciled)" "failed/5000000/0/0"

echo "-- an admin's own withdrawal --"
"${PSQL[@]}" -q -c "$(as "$ORG_ADMIN" "SELECT public.set_my_withdrawal_pin('8053', '8053');")" >/dev/null
W3=$(withdraw_id "$ORG_ADMIN" 1500000 "$BANK_OA" 8053 oa-1)
expect_error "an admin cannot give the first approval to their own withdrawal" "cannot approve their own withdrawal" "$(first "$ORG_ADMIN" "$W3" 1500000)"
"${PSQL[@]}" -q -c "$(first "$SUB" "$W3" 1500000)" >/dev/null
expect_error "...nor the second" "cannot approve their own withdrawal" "$(second "$ORG_ADMIN" "$W3")"
expect_value "their dashboard says so and offers no action" \
  "$(val "$(as "$ORG_ADMIN" "SELECT (can_first_approve OR can_second_approve OR can_pay)::text || '|' || action_note FROM public.admin_list_withdrawals() WHERE request_id = '$W3';")")" \
  "false|This is your own withdrawal; two other admins must review it."

echo "-- withdrawing a first approval; bank change between approvals --"
expect_error "another sub-admin cannot withdraw someone else's first approval" "Only the admin who gave the first approval" \
  "$(as "$SUB2" "SELECT public.admin_cancel_withdrawal_first_approval('$W3', 'x');")"
expect_ok "the first approver can withdraw it" "$(as "$SUB" "SELECT public.admin_cancel_withdrawal_first_approval('$W3', 'Wrong review');")"
expect_value "back to pending first approval" "$(stage_for "$ADMIN_A" "$W3")" "pending_first_approval"
"${PSQL[@]}" -q -c "$(first "$ADMIN_A" "$W3" 1500000)" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_chi_new' WHERE id = '$BANK_OA';"
expect_error "a bank recipient changed after the first approval refuses the second" "changed after the first approval" "$(second "$SUB" "$W3")"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_chi' WHERE id = '$BANK_OA';"

echo "-- Admin Actions (approve_admin_action) follows the same rule --"
AR=$(val "SELECT id FROM public.admin_action_requests WHERE target_id = '$W3' AND status = 'pending';")
expect_error "a sub-admin still cannot use Admin Actions to approve" "Super Admin access required" "$(as "$SUB2" "SELECT public.approve_admin_action('$AR');")"
expect_ok "a different full admin can approve there" "$(as "$ADMIN_B" "SELECT public.approve_admin_action('$AR');")"
expect_value "same outcome as the Payouts screen" "$(stage_for "$SUB" "$W3")" "approved"

echo "-- rejection closes an open first approval and returns the money --"
"${PSQL[@]}" -q -c "UPDATE public.withdrawal_pins SET reset_at = NULL WHERE user_id = '$ORG';"
W4=$(withdraw_id "$ORG" 2000000 "$BANK" 5820 key-w4)
"${PSQL[@]}" -q -c "$(first "$SUB" "$W4" 2000000)" >/dev/null
expect_error "a sub-admin cannot reject (full admins only, unchanged)" "Super Admin access required" "$(as "$SUB2" "SELECT public.admin_reject_organizer_payout('$W4', 'x');")"
expect_value "so the sub-admin's dashboard offers no Reject button" "$(val "$(as "$SUB2" "SELECT can_reject::text FROM public.admin_list_withdrawals() WHERE request_id = '$W4';")")" "false"
expect_ok "a full admin can reject while it waits" "$(as "$ADMIN_B" "SELECT public.admin_reject_organizer_payout('$W4', 'Account under review');")"
expect_value "rejected; the open first approval closed; money back; user told with the reason" \
  "$(my_stage "$ORG" "$W4")/$(val "SELECT status FROM public.admin_action_requests WHERE target_id = '$W4';")/$(wallet "$ORG")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND title = 'Withdrawal not approved' AND body LIKE '%Account under review%';")" \
  "rejected/rejected/7000000/0/1"
expect_value "the user's history shows the reason" "$(val "$(as "$ORG" "SELECT note FROM public.get_my_withdrawals() WHERE request_id = '$W4';")")" "Account under review"
expect_error "a rejected withdrawal cannot be approved" "not pending" "$(first "$ADMIN_A" "$W4" 2000000)"

echo "-- kill switch --"
"${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = true;" 2>/dev/null || true
if [ "$(val "SELECT public.payouts_disabled()::text;")" = "true" ]; then
  W5=$(val "SELECT id FROM public.organizer_withdrawal_requests WHERE id = '$W3';")
  expect_value "payouts paused: no pay button anywhere" "$(val "$(as "$ADMIN_A" "SELECT can_pay::text FROM public.admin_list_withdrawals() WHERE request_id = '$W5';")")" "false"
  expect_error "payouts paused: the claim is refused" "payouts_disabled" "$(as "$ADMIN_A" "SELECT * FROM public.admin_claim_payout_for_processing('$W5');")"
  "${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = false;"
else
  echo "info: this stack has no app_config kill switch row; skipped"
fi

expect_value "ledger = available + pending for every wallet after all of the above" "$(reconciled)" "0"

echo "== Rollback and re-apply =="
APPROVALS_BEFORE_UNDO=$(val "SELECT count(*) FILTER (WHERE approved_by IS NOT NULL) || '/' || (SELECT count(*) FROM public.admin_action_requests WHERE action_type = 'authorize_withdrawal') FROM public.organizer_withdrawal_requests;")
PINS_BEFORE_UNDO=$(val "SELECT (SELECT count(*) FROM public.withdrawal_pins) || '/' || (SELECT count(*) FROM public.withdrawal_pin_events);")
expect_ok "undo_0211 runs" "SET vents.rollback_confirm = 'undo-0211'; $(cat "$REPO_ROOT/supabase/rollback/undo_0211.sql")"
expect_value "after undo_0211 the database is exactly the pre-0211 state (functions, grants, constraints, columns, triggers)" "$(val "$STATE_SQL")" "$PRE_0211"
"${PSQL[@]}" -tA -c "$FN_LIST" > "$TMP/fn_post"
diff "$TMP/fn_pre" "$TMP/fn_post" >&2 || true
expect_value "withdrawal history and money are untouched by the rollback" "$(val "SELECT count(*) FROM public.organizer_withdrawal_requests;")/$(reconciled)" "5/0"
expect_value "approval history is untouched by the rollback" \
  "$(val "SELECT count(*) FILTER (WHERE approved_by IS NOT NULL) || '/' || (SELECT count(*) FROM public.admin_action_requests WHERE action_type = 'authorize_withdrawal') FROM public.organizer_withdrawal_requests;")" "$APPROVALS_BEFORE_UNDO"
expect_value "PIN data is kept by the rollback (hashes and audit trail)" \
  "$(val "SELECT (SELECT count(*) FROM public.withdrawal_pins) || '/' || (SELECT count(*) FROM public.withdrawal_pin_events);")" "$PINS_BEFORE_UNDO"
expect_value "...and stays closed to clients while rolled back" \
  "$(val "SELECT has_table_privilege('authenticated', 'public.withdrawal_pins', 'SELECT')::text || '/' || has_table_privilege('anon', 'public.withdrawal_pin_events', 'SELECT')::text;")" "false/false"
expect_value "after the rollback the previous (no-PIN) entry point works again for clients" \
  "$(val "SELECT has_function_privilege('authenticated', 'public.request_organizer_payout(bigint,uuid,text)', 'EXECUTE')::text;")" "true"
expect_ok "0211 re-applies after the rollback" "$(cat "$TMP_MIG")"
expect_value "after re-applying, users keep their PIN (the old PIN is accepted, no new one needed)" \
  "$(withdraw "$ORG" 100 "$BANK" 5820 after-reapply)" "amount_too_small"
expect_value "re-applied state equals the first apply" "$(val "$STATE_SQL")" "$POST_0211"

echo
echo "md5 for the 0211 drift guard: guard 0205=$GUARD_0205 0211=$GUARD_0211; executor 0203=$EXEC_0203 0211=$EXEC_0211"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL $PASSES WITHDRAWAL PIN / TWO-ADMIN APPROVAL CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1
fi
