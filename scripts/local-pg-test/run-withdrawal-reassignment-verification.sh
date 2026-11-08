#!/usr/bin/env bash
# Verifies migration 0207 (audited two-admin withdrawal bank-account
# reassignment, Batch D D4a) on a LOCAL throwaway database, after
# 0201 -> 0202 -> 0203 -> 0205 -> 0206. Mirrors production's D4a state:
# pending requests on a DEACTIVATED account, an active verified account
# available. Proves: two distinct admins, neither the organizer; the new
# account must be the organizer's, active and verified; amount, reference,
# wallet and ledger untouched; stale requests refused; masked audit only;
# the 0202/0203/0205 safeguards still apply afterwards (two-admin
# authorization binds the NEW recipient, then the claim); destination
# changes impossible outside the executor; append-only; undo.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_withdrawal_reassign"
SOCKET_DIR="/var/run/postgresql"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
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
cleanup() { pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
val() { "${PSQL[@]}" -tA -c "$1" 2>/dev/null | tail -n1; }
run() { "${PSQL[@]}" -c "$1" 2>&1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', expected '$3')"; fi; }
expect_error() {
  local out; out=$(run "$3")
  if [[ "$out" == *"$2"* ]]; then pass "$1"; else fail "$1 (expected error containing '$2', got: $(echo "$out" | grep -E 'ERROR|^ ' | head -1))"; fi
}
expect_ok() { local out; out=$(run "$2"); if [[ "$out" != *ERROR* ]]; then pass "$1"; else fail "$1 ($(echo "$out" | grep ERROR | head -1))"; fi; }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
apply_file() { "${PSQL[@]}" -q -1 -c "${2:-SELECT 1;}" -f - <"$1" 2>&1 | grep -E 'ERROR' | head -1; }

ORG="00000000-0000-0000-0000-0000000007a1"        # organizer with the stuck requests
ORG_ADMIN="00000000-0000-0000-0000-0000000007a2"  # a super admin who is also an organizer
FOREIGN="00000000-0000-0000-0000-0000000007a3"    # another organizer
SUB="00000000-0000-0000-0000-0000000007b1"
SUB2="00000000-0000-0000-0000-0000000007b2"
SUPER="00000000-0000-0000-0000-0000000007c1"
OTHER="00000000-0000-0000-0000-0000000007d1"
OLD="00000000-0000-0000-0000-0000000007e1"        # deactivated (as in production)
NEWB="00000000-0000-0000-0000-0000000007e2"       # active, verified
NEW2="00000000-0000-0000-0000-0000000007e3"       # active, verified (second)
UNV="00000000-0000-0000-0000-0000000007e4"        # active, no Paystack recipient
INACT="00000000-0000-0000-0000-0000000007e5"      # inactive
FB="00000000-0000-0000-0000-0000000007e6"         # another organizer's account
OAB="00000000-0000-0000-0000-0000000007e7"        # the admin-organizer's own account
OAB2="00000000-0000-0000-0000-0000000007e8"
W="00000000-0000-0000-0000-00000007f0"
W1="${W}01"; W2="${W}02"; W3="${W}03"; WP="${W}04"; WREF="${W}05"; WOA="${W}06"; WN="${W}07"; W4="${W}08"; W5="${W}09"; W6="${W}10"

pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
for f in schema-representative-rewards.sql schema-live-payout-extras.sql schema-earnings-policies.sql live-money-functions.sql; do
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/$f" >/dev/null 2>&1
done
"${PSQL[@]}" -q -f - <"$REPO_ROOT/supabase/rollback/sources/complete_organizer_payout.prod-2026-10-30.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, username, email) VALUES
  ('$ORG', 'user', true, 'Organizer', 'org1', 'o@example.test'),
  ('$ORG_ADMIN', 'admin', true, 'Admin organizer', 'adminorg', 'ao@example.test'),
  ('$FOREIGN', 'user', true, 'Foreign', 'org2', 'f@example.test'),
  ('$SUB', 'sub-admin', false, 'Sub', 'sub1', 's1@example.test'),
  ('$SUB2', 'sub-admin', false, 'Sub2', 'sub2', 's2@example.test'),
  ('$SUPER', 'admin', false, 'Super', 'super1', 'su@example.test'),
  ('$OTHER', 'user', false, 'Other', 'other', 'x@example.test');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES
  ('$OLD',   '$ORG', 'Old Bank', '001', '1111111111', 'ORG OLD', 'RCP_old', false),
  ('$NEWB',  '$ORG', 'New Bank', '002', '2222222234', 'ORG NEW', 'RCP_new', true),
  ('$NEW2',  '$ORG', 'Second Bank', '003', '3333333345', 'ORG NEW2', 'RCP_new2', true),
  ('$UNV',   '$ORG', 'Unverified', '004', '4444444444', 'ORG UNV', NULL, true),
  ('$INACT', '$ORG', 'Inactive', '005', '5555555555', 'ORG IN', 'RCP_in', false),
  ('$FB',    '$FOREIGN', 'Foreign Bank', '006', '6666666666', 'FOREIGN', 'RCP_f', true),
  ('$OAB',   '$ORG_ADMIN', 'Admin Old', '007', '7777777777', 'AO', 'RCP_ao', false),
  ('$OAB2',  '$ORG_ADMIN', 'Admin New', '008', '8888888888', 'AO2', 'RCP_ao2', true);
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo) VALUES
  ('$ORG', 100000, 4410000, 4510000), ('$ORG_ADMIN', 0, 500000, 500000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES
  ('$ORG', 'credit', 4510000, 'sales'), ('$ORG_ADMIN', 'credit', 500000, 'sales');
INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, bank_name, bank_code, account_number, account_name, paystack_reference, transfer_code) VALUES
  ('$W1', '$ORG', 2000000, 'pending', '$OLD', 'Old Bank', '001', '1111111111', 'ORG OLD', NULL, NULL),
  ('$W2', '$ORG', 2000000, 'pending', '$OLD', 'Old Bank', '001', '1111111111', 'ORG OLD', NULL, NULL),
  ('$W3', '$ORG', 400000, 'pending', '$OLD', 'Old Bank', '001', '1111111111', 'ORG OLD', NULL, NULL),
  ('$W4', '$ORG', 10000, 'pending', '$OLD', 'Old Bank', '001', '1111111111', 'ORG OLD', NULL, NULL),
  ('$W5', '$ORG', 10000, 'pending', '$OLD', 'Old Bank', '001', '1111111111', 'ORG OLD', NULL, NULL),
  ('$WP', '$ORG', 10000, 'processing', '$OLD', 'Old Bank', '001', '1111111111', 'ORG OLD', 'payout_wp', NULL),
  ('$WREF', '$ORG', 10000, 'pending', '$OLD', 'Old Bank', '001', '1111111111', 'ORG OLD', 'payout_wref', NULL),
  ('$WOA', '$ORG_ADMIN', 500000, 'pending', '$OAB', 'Admin Old', '007', '7777777777', 'AO', NULL, NULL),
  ('$WN', '$ORG', 10000, 'rejected', '$OLD', 'Old Bank', '001', '1111111111', 'ORG OLD', NULL, NULL),
  ('$W6', '$ORG', 10000, 'pending', '$NEWB', 'New Bank', '002', '2222222234', 'ORG NEW', NULL, NULL);
UPDATE public.app_config SET disable_payouts = false;
SQL

echo "== Install =="
expect_value "0207 refuses before 0203/0205" "$(apply_file "$MIG/0207_withdrawal_bank_reassignment.sql" | grep -c '0207: apply')" "1"
expect_value "0201 applies" "$(apply_file "$MIG/0201_vents_earn_representative_rewards.sql")" ""
expect_value "0202 applies" "$(apply_file "$MIG/0202_payout_engine_safety.sql" "SET vents.migration_local_test = 'on';")" ""
expect_value "0203 applies" "$(apply_file "$MIG/0203_earnings_policies.sql")" ""
expect_value "0205 applies" "$(apply_file "$MIG/0205_payout_cancelled_transfer_safety.sql")" ""
expect_value "0206 applies" "$(apply_file "$MIG/0206_earnings_adjustment.sql")" ""
"${PSQL[@]}" -q -c "GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) TO authenticated;"
SNAP="SELECT (SELECT string_agg(id || ':' || status || ':' || amount_kobo || ':' || coalesce(bank_account_id::text,'-') || ':' || coalesce(account_number,'-') || ':' || coalesce(paystack_reference,'-'), ',' ORDER BY id) FROM public.organizer_withdrawal_requests) || '|' || (SELECT string_agg(organizer_id || ':' || balance_kobo || ':' || pending_kobo || ':' || total_withdrawn_kobo, ',' ORDER BY organizer_id) FROM public.organizer_wallets) || '|' || (SELECT count(*) FROM public.organizer_transactions);"
BEFORE=$(val "$SNAP")
expect_value "0207 applies" "$(apply_file "$MIG/0207_withdrawal_bank_reassignment.sql")" ""
expect_value "applying 0207 changed no withdrawal, wallet or ledger row" "$(val "$SNAP")" "$BEFORE"
expect_value "0207 is idempotent" "$(apply_file "$MIG/0207_withdrawal_bank_reassignment.sql")" ""
WIRED="SELECT (position('execute_withdrawal_bank_reassignment' IN pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure)) > 0)::text || '/' || (position('reassign_withdrawal_bank_account' IN pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure)) > 0)::text || '/' || (position('execute_withdrawal_authorization' IN pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure)) > 0)::text || '/' || (position('execute_earnings_adjustment' IN pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure)) > 0)::text;"
expect_value "wired into the maker-checker beside 0203's and 0206's actions" "$(val "$WIRED")" "true/true/true/true"

echo "== Undo before any reassignment =="
UNDO="$REPO_ROOT/supabase/rollback/undo_0207.sql"
expect_value "undo refuses without confirmation" "$(apply_file "$UNDO" | grep -c 'undo_0207 refused')" "1"
expect_value "undo applies with confirmation" "$(apply_file "$UNDO" "SET vents.rollback_confirm = 'undo-0207';")" ""
expect_value "...unwiring 0207 only (0203 and 0206 stay wired) and dropping its objects" \
  "$(val "$WIRED")/$(val "SELECT (to_regclass('public.withdrawal_bank_reassignments') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'organizer_withdrawal_destination_guard'))::text;")" "false/false/true/true/true"
expect_value "undo changed nothing" "$(val "$SNAP")" "$BEFORE"
expect_value "0207 re-applies after undo" "$(apply_file "$MIG/0207_withdrawal_bank_reassignment.sql")" ""

req() { printf "%s" "$(as "$1" "SELECT public.admin_request_withdrawal_bank_reassignment('$2', '$3', '$4')->>'id';")"; }
approve() { as "$1" "SELECT public.approve_admin_action('$2');"; }
REASON="Organizer deactivated the old account; moving to their verified active account (D4a)"

echo "== The destination can only change through the executor =="
expect_error "a raw UPDATE of bank_account_id is refused" "can only be changed by an approved reassign_withdrawal_bank_account" \
  "UPDATE public.organizer_withdrawal_requests SET bank_account_id = '$NEWB' WHERE id = '$W1';"
expect_error "a raw UPDATE of the bank snapshot columns is refused" "can only be changed by an approved reassign_withdrawal_bank_account" \
  "UPDATE public.organizer_withdrawal_requests SET account_number = '9999999999' WHERE id = '$W1';"
expect_ok "the foreign key's ON DELETE SET NULL path still works (bank_account_id -> NULL)" \
  "UPDATE public.organizer_withdrawal_requests SET bank_account_id = NULL WHERE id = '$WN';"

echo "== Before reassignment: the D4a deadlock =="
AR0=$(val "$(as "$SUB" "SELECT public.request_admin_action('authorize_withdrawal', 'withdrawal', '$W1', 'w1', jsonb_build_object('request_id', '$W1', 'amount_kobo', 2000000))->>'id';")")
expect_error "a withdrawal on a deactivated account cannot be authorized (0203)" "inactive" "$(approve "$SUPER" "$AR0")"

echo "== Authorization =="
expect_error "a plain user cannot request a reassignment" "Admin access required" "$(req "$OTHER" "$W1" "$NEWB" "$REASON")"
expect_error "anon cannot call the request helper" "permission denied" "SET ROLE anon; SELECT public.admin_request_withdrawal_bank_reassignment('$W1', '$NEWB', '$REASON');"
expect_error "nobody can call the executor directly" "permission denied" "$(as "$SUPER" "SELECT public.execute_withdrawal_bank_reassignment(gen_random_uuid());")"
expect_error "nobody can read or write the reassignment table directly" "permission denied" "$(as "$SUPER" "SELECT * FROM public.withdrawal_bank_reassignments;")"
expect_error "an admin cannot request a change to their own withdrawal" "own withdrawal" "$(req "$ORG_ADMIN" "$WOA" "$OAB2" "$REASON")"
R_OWN=$(val "$(req "$SUB" "$WOA" "$OAB2" "$REASON")")
expect_error "the approver cannot be the withdrawal's organizer" "own withdrawal" "$(approve "$ORG_ADMIN" "$R_OWN")"
R_SA=$(val "$(req "$SUPER" "$W5" "$NEWB" "$REASON")")
expect_error "the requester cannot approve their own request" "Cannot approve your own request" "$(approve "$SUPER" "$R_SA")"
R1=$(val "$(req "$SUB" "$W1" "$NEWB" "$REASON")")
expect_error "a sub-admin cannot approve" "Super Admin access required" "$(approve "$SUB2" "$R1")"

echo "== Validation =="
expect_error "a reason under 20 characters is refused" "at least 20 characters" "$(req "$SUB" "$W2" "$NEWB" "short")"
expect_error "another organizer's account is refused" "belongs to someone else" "$(req "$SUB" "$W2" "$FB" "$REASON")"
expect_error "an inactive account is refused" "not active" "$(req "$SUB" "$W2" "$INACT" "$REASON")"
expect_error "an account without a verified Paystack recipient is refused" "no verified Paystack recipient" "$(req "$SUB" "$W2" "$UNV" "$REASON")"
expect_error "the same account is refused" "already uses this bank account" "$(req "$SUB" "$W6" "$NEWB" "$REASON")"
expect_error "a missing account is refused" "does not exist" "$(req "$SUB" "$W2" "$OTHER" "$REASON")"
expect_error "a processing withdrawal cannot be moved" "Only a pending withdrawal" "$(req "$SUB" "$WP" "$NEWB" "$REASON")"
expect_error "a withdrawal with a Paystack reference cannot be moved" "transfer was attempted" "$(req "$SUB" "$WREF" "$NEWB" "$REASON")"

echo "== Reassignment =="
W_BEFORE=$(val "SELECT amount_kobo || '/' || status || '/' || coalesce(paystack_reference,'-') || '/' || coalesce(transfer_code,'-') FROM public.organizer_withdrawal_requests WHERE id = '$W1';")
WALLET_BEFORE=$(val "SELECT balance_kobo || '/' || pending_kobo || '/' || total_withdrawn_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")
LEDGER_BEFORE=$(val "SELECT count(*) || '/' || sum(amount_kobo) FROM public.organizer_transactions;")
expect_ok "a super admin approves the reassignment" "$(approve "$SUPER" "$R1")"
expect_value "the withdrawal now points at the new account, with its bank snapshot" \
  "$(val "SELECT bank_account_id || '/' || bank_name || '/' || account_number FROM public.organizer_withdrawal_requests WHERE id = '$W1';")" "$NEWB/New Bank/2222222234"
expect_value "amount, status, reference and transfer code are unchanged" \
  "$(val "SELECT amount_kobo || '/' || status || '/' || coalesce(paystack_reference,'-') || '/' || coalesce(transfer_code,'-') FROM public.organizer_withdrawal_requests WHERE id = '$W1';")" "$W_BEFORE"
expect_value "the wallet is unchanged" "$(val "SELECT balance_kobo || '/' || pending_kobo || '/' || total_withdrawn_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")" "$WALLET_BEFORE"
expect_value "the ledger is unchanged" "$(val "SELECT count(*) || '/' || sum(amount_kobo) FROM public.organizer_transactions;")" "$LEDGER_BEFORE"
expect_value "the record holds both admins, both account ids and MASKED numbers" \
  "$(val "SELECT (requested_by = '$SUB')::text || '/' || (approved_by = '$SUPER')::text || '/' || (old_bank_account_id = '$OLD')::text || '/' || (new_bank_account_id = '$NEWB')::text || '/' || old_account_masked || '/' || new_account_masked FROM public.withdrawal_bank_reassignments WHERE admin_request_id = '$R1';")" \
  "true/true/true/true/Old Bank ****1111/New Bank ****2234"
expect_value "no full account number or recipient code appears in the request, the record or the audit log" \
  "$(val "SELECT count(*) FROM (SELECT payload::text AS t FROM public.admin_action_requests WHERE id = '$R1' UNION ALL SELECT to_jsonb(x)::text FROM public.withdrawal_bank_reassignments x UNION ALL SELECT details::text FROM public.admin_logs WHERE action = 'withdrawal_bank_reassigned') s WHERE t LIKE '%2222222234%' OR t LIKE '%1111111111%' OR t LIKE '%RCP_new%' OR t LIKE '%RCP_old%';")" "0"
expect_value "it is audited once" "$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'withdrawal_bank_reassigned' AND details->>'admin_request_id' = '$R1';")" "1"
expect_error "approving again is refused (idempotent)" "Request already approved" "$(approve "$SUPER" "$R1")"

echo "== The 0202/0203/0205 safeguards still apply afterwards =="
expect_error "the reassigned withdrawal still cannot be claimed without two-admin authorization" "needs a second admin" \
  "$(as "$SUB" "SELECT * FROM public.admin_claim_payout_for_processing('$W1');")"
AR1=$(val "$(as "$SUB" "SELECT public.request_admin_action('authorize_withdrawal', 'withdrawal', '$W1', 'w1', jsonb_build_object('request_id', '$W1', 'amount_kobo', 2000000))->>'id';")")
expect_ok "it can now be authorized by two admins" "$(approve "$SUPER" "$AR1")"
expect_value "the authorization binds the NEW recipient" "$(val "SELECT approved_recipient_code FROM public.organizer_withdrawal_requests WHERE id = '$W1';")" "RCP_new"
expect_error "once authorized, it cannot be moved again (re-authorization would be bypassed)" "already authorized" "$(req "$SUB" "$W1" "$NEW2" "$REASON")"
expect_value "the claim pays the new recipient, once, under the fixed reference" \
  "$(val "$(as "$SUB" "SELECT claimed::text || '/' || recipient_code FROM public.admin_claim_payout_for_processing('$W1');")")/$(val "SELECT (paystack_reference = public.payout_transfer_reference('$W1'))::text FROM public.organizer_withdrawal_requests WHERE id = '$W1';")" "true/RCP_new/true"
expect_error "a processing withdrawal can no longer be moved" "Only a pending withdrawal" "$(req "$SUB" "$W1" "$NEW2" "$REASON")"

echo "== Stale requests =="
R2=$(val "$(req "$SUB" "$W2" "$NEWB" "$REASON")")
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET admin_note = 'organizer called', updated_at = now() WHERE id = '$W2';"
expect_error "a withdrawal that changed after the request cannot be moved" "withdrawal changed since" "$(approve "$SUPER" "$R2")"
expect_value "...the request stays pending and the withdrawal keeps its account" \
  "$(val "SELECT status FROM public.admin_action_requests WHERE id = '$R2';")/$(val "SELECT bank_account_id FROM public.organizer_withdrawal_requests WHERE id = '$W2';")" "pending/$OLD"
R3=$(val "$(req "$SUB" "$W2" "$NEW2" "$REASON")")
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_swapped', updated_at = now() WHERE id = '$NEW2';"
expect_error "a new account whose recipient changed after the request is refused" "new bank account changed since" "$(approve "$SUPER" "$R3")"
R4=$(val "$(req "$SUB" "$W3" "$NEWB" "$REASON")")
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET is_active = false WHERE id = '$NEWB';"
expect_error "a new account deactivated after the request is refused" "not active" "$(approve "$SUPER" "$R4")"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET is_active = true WHERE id = '$NEWB';"
R5=$(val "$(req "$SUB" "$W3" "$NEWB" "$REASON")")
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET status = 'rejected' WHERE id = '$W3';"
expect_error "a withdrawal no longer pending when approved is refused" "Only a pending withdrawal" "$(approve "$SUPER" "$R5")"

echo "== Expiry and demoted requesters =="
R6=$(val "$(req "$SUB" "$W4" "$NEWB" "$REASON")")
"${PSQL[@]}" -q -c "UPDATE public.admin_action_requests SET requested_at = now() - interval '8 days' WHERE id = '$R6';"
expect_error "a request older than 7 days cannot be approved" "older than 7 days" "$(approve "$SUPER" "$R6")"
R7=$(val "$(req "$SUB2" "$W4" "$NEWB" "$REASON")")
"${PSQL[@]}" -q -c "UPDATE public.users SET role = 'user' WHERE id = '$SUB2';"
expect_error "a request from an admin since demoted cannot be approved" "no longer an admin" "$(approve "$SUPER" "$R7")"

echo "== Append-only and undo after execution =="
expect_error "a reassignment record cannot be updated" "append-only" "UPDATE public.withdrawal_bank_reassignments SET reason = 'x';"
expect_error "a reassignment record cannot be deleted" "append-only" "DELETE FROM public.withdrawal_bank_reassignments;"
expect_value "undo is refused once a withdrawal has been reassigned" \
  "$(apply_file "$UNDO" "SET vents.rollback_confirm = 'undo-0207';" | grep -c 'have been reassigned')" "1"
expect_value "...and changed nothing" "$(val "SELECT count(*) FROM public.withdrawal_bank_reassignments;")" "1"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES WITHDRAWAL REASSIGNMENT CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
