#!/usr/bin/env bash
# Verifies migration 0206 (audited two-admin earnings adjustments) on a LOCAL
# throwaway database, after 0201 -> 0202 -> 0203 -> 0205:
#   authorization (two distinct admins, neither the wallet owner, super-admin
#   approver), payload validation, the wallet snapshot (stale approvals
#   refused), each kind's exact effect on wallet + ledger + reconciliation,
#   late payout recording for the 2026-07 incident rows, idempotency,
#   append-only history, no negative balances, expiry, audit, and undo.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_earnings_adjustment"
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

ORG="00000000-0000-0000-0000-0000000006a1"        # organizer wallet being corrected
ORG_ADMIN="00000000-0000-0000-0000-0000000006a2"  # a super admin who also owns a wallet
SUB="00000000-0000-0000-0000-0000000006b1"        # sub-admin (requester)
SUB2="00000000-0000-0000-0000-0000000006b2"       # sub-admin (cannot approve)
SUPER="00000000-0000-0000-0000-0000000006c1"      # super admin (approver)
OTHER="00000000-0000-0000-0000-0000000006d1"      # plain user
BANK="00000000-0000-0000-0000-0000000006e1"
IDS=(3aa0f8ff-d652-48cb-a06f-82a99d434dbe f9fda363-8e24-45af-8d2a-74dd7edb61aa)
SWEEP=$(awk '/^UPDATE public.organizer_withdrawal_requests w/,/;$/' "$REPO_ROOT/migrations/20260713100000_admin-stats-and-payout-cleanup.sql")

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
  ('$ORG', 'user', true, 'Organizer', 'testerboy', 'o@example.test'),
  ('$ORG_ADMIN', 'admin', true, 'Admin organizer', 'adminorg', 'ao@example.test'),
  ('$SUB', 'sub-admin', false, 'Sub', 'sub1', 's1@example.test'),
  ('$SUB2', 'sub-admin', false, 'Sub2', 'sub2', 's2@example.test'),
  ('$SUPER', 'admin', false, 'Super', 'super1', 'su@example.test'),
  ('$OTHER', 'user', false, 'Other', 'other', 'x@example.test');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active)
VALUES ('$BANK', '$ORG', 'Test bank', '999992', '0000000000', 'TEST', 'RCP_t', true);
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo) VALUES
  ('$ORG', 100000, 20000, 140000), ('$ORG_ADMIN', 50000, 0, 50000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES
  ('$ORG', 'credit', 140000, 'sales'), ('$ORG_ADMIN', 'credit', 50000, 'sales');
SQL
for i in 0 1; do
  "${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, transfer_code, paystack_reference)
    VALUES ('${IDS[$i]}', '$ORG', 10000, 'processing', '$BANK', 'TRF_adj_$i', 'payout_${IDS[$i]}');"
done
"${PSQL[@]}" -q -c "$SWEEP"   # the 2026-07-12 incident, on production's code
# Production today: the swept requests' pending money is gone.
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET pending_kobo = 0 WHERE organizer_id = '$ORG';"

echo "== Install =="
expect_value "0206 refuses before 0203/0205" "$(apply_file "$MIG/0206_earnings_adjustment.sql" | grep -c '0206: apply')" "1"
for m in 0201_vents_earn_representative_rewards 0203_earnings_policies 0205_payout_cancelled_transfer_safety; do :; done
expect_value "0201 applies" "$(apply_file "$MIG/0201_vents_earn_representative_rewards.sql")" ""
expect_value "0202 applies" "$(apply_file "$MIG/0202_payout_engine_safety.sql" "SET vents.migration_local_test = 'on';")" ""
expect_value "0203 applies" "$(apply_file "$MIG/0203_earnings_policies.sql")" ""
expect_value "0205 applies" "$(apply_file "$MIG/0205_payout_cancelled_transfer_safety.sql")" ""
SNAP="SELECT (SELECT string_agg(organizer_id || ':' || balance_kobo || ':' || pending_kobo || ':' || on_hold_kobo || ':' || total_earned_kobo || ':' || total_withdrawn_kobo, ',' ORDER BY organizer_id) FROM public.organizer_wallets) || '|' || (SELECT count(*) FROM public.organizer_transactions) || '|' || (SELECT string_agg(status, ',' ORDER BY id) FROM public.organizer_withdrawal_requests);"
BEFORE=$(val "$SNAP")
expect_value "0206 applies" "$(apply_file "$MIG/0206_earnings_adjustment.sql")" ""
expect_value "applying 0206 changed no wallet, ledger row or request" "$(val "$SNAP")" "$BEFORE"
expect_value "0206 is idempotent" "$(apply_file "$MIG/0206_earnings_adjustment.sql")" ""
expect_value "wired into approve_admin_action, request_admin_action and the reconciliation" \
  "$(val "SELECT (position('execute_earnings_adjustment' IN pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure)) > 0)::text || '/' || (position('earnings_adjustment' IN pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure)) > 0)::text || '/' || (position('adjustment_debit' IN pg_get_functiondef('public.admin_earnings_reconciliation()'::regprocedure)) > 0)::text;")" \
  "true/true/true"

echo "== Undo before any adjustment =="
UNDO="$REPO_ROOT/supabase/rollback/undo_0206.sql"
expect_value "undo refuses without confirmation" "$(apply_file "$UNDO" | grep -c 'undo_0206 refused')" "1"
expect_value "undo applies with confirmation while nothing has been executed" "$(apply_file "$UNDO" "SET vents.rollback_confirm = 'undo-0206';")" ""
expect_value "...unwiring everything and restoring the 0203 ledger types" \
  "$(val "SELECT (position('earnings_adjustment' IN pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure)) = 0)::text || '/' || (position('earnings_adjustment' IN pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure)) = 0)::text || '/' || (position('adjustment' IN pg_get_functiondef('public.admin_earnings_reconciliation()'::regprocedure)) = 0)::text || '/' || (to_regclass('public.earnings_adjustments') IS NULL)::text || '/' || (pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'organizer_transactions_type_check')) NOT LIKE '%adjustment%')::text;")" \
  "true/true/true/true/true"
expect_value "...and the authorize_withdrawal wiring from 0203 is intact" \
  "$(val "SELECT (position('execute_withdrawal_authorization' IN pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure)) > 0)::text;")" "true"
expect_value "undo moved no money" "$(val "$SNAP")" "$BEFORE"
expect_value "0206 re-applies after undo" "$(apply_file "$MIG/0206_earnings_adjustment.sql")" ""

req() {  # as-user, organizer, kind, direction, amount, reason, evidence [, request_id, paid_at]
  local extra=""
  if [ -n "${8:-}" ]; then extra=", '$8', '${9:-2026-07-10 11:05:00+00}'"; fi
  printf "%s" "$(as "$1" "SELECT public.admin_request_earnings_adjustment('$2', '$3', '$4', $5, '$6', '$7'$extra)->>'id';")"
}
approve() { as "$1" "SELECT public.approve_admin_action('$2');"; }
wallet() { val "SELECT balance_kobo || '/' || pending_kobo || '/' || total_earned_kobo || '/' || total_withdrawn_kobo FROM public.organizer_wallets WHERE organizer_id = '$1';"; }
gap() { val "$(as "$SUPER" "SELECT ledger_gap_kobo FROM public.admin_earnings_reconciliation() WHERE organizer_id = '$1';")"; }
REASON="Reverses a ledger credit with no source (Batch D 10.9)"

echo "== Authorization =="
expect_error "a plain user cannot request an adjustment" "Admin access required" "$(req "$OTHER" "$ORG" ledger_only debit 100000 "$REASON" "G1 row x")"
expect_error "anon cannot call the request helper" "permission denied" "SET ROLE anon; SELECT public.admin_request_earnings_adjustment('$ORG', 'ledger_only', 'debit', 100, '$REASON', 'x');"
expect_error "nobody can call the executor directly" "permission denied" "$(as "$SUPER" "SELECT public.execute_earnings_adjustment(gen_random_uuid());")"
expect_error "nobody can write the adjustment table directly" "permission denied" "$(as "$SUPER" "SELECT * FROM public.earnings_adjustments;")"
expect_error "an admin cannot request an adjustment to their own wallet" "own wallet" "$(req "$ORG_ADMIN" "$ORG_ADMIN" wallet_credit credit 100 "$REASON" "x")"
R_SELF=$(val "$(as "$ORG_ADMIN" "SELECT (public.request_admin_action('earnings_adjustment', 'user', '$ORG_ADMIN', 'self', jsonb_build_object('kind','wallet_credit','direction','credit','amount_kobo',100,'reason','$REASON','evidence_ref','x','expected_balance_kobo',50000,'expected_pending_kobo',0,'expected_on_hold_kobo',0,'expected_ledger_net_kobo',50000)))->>'id';")")
expect_error "...nor sneak one in through request_admin_action: the approval is refused" "own wallet" "$(approve "$SUPER" "$R_SELF")"
R_OWN=$(val "$(req "$SUB" "$ORG_ADMIN" wallet_credit credit 100 "$REASON" "x")")
expect_error "the approver cannot be the wallet owner" "own wallet" "$(approve "$ORG_ADMIN" "$R_OWN")"
R1=$(val "$(req "$SUB" "$ORG" ledger_only debit 100000 "$REASON" "G1 row 64e7e2e8")")
R_SA=$(val "$(req "$SUPER" "$ORG" ledger_only credit 100 "$REASON" "x")")
expect_error "the requester cannot approve their own request" "Cannot approve your own request" "$(approve "$SUPER" "$R_SA")"
expect_error "a sub-admin cannot approve" "Super Admin access required" "$(approve "$SUB2" "$R1")"

echo "== Validation =="
expect_error "a reason under 20 characters is refused" "at least 20 characters" "$(req "$SUB" "$ORG" ledger_only debit 100 "too short" "x")"
expect_error "an evidence reference is required" "evidence reference" "$(req "$SUB" "$ORG" ledger_only debit 100 "$REASON" " ")"
expect_error "a zero amount is refused" "must be positive" "$(req "$SUB" "$ORG" ledger_only debit 0 "$REASON" "x")"
expect_error "an amount above the NGN 50,000 cap is refused" "per-adjustment cap" "$(req "$SUB" "$ORG" wallet_credit credit 5000001 "$REASON" "x")"
expect_error "an unknown kind is refused" "payload.kind must be" "$(req "$SUB" "$ORG" bonus credit 100 "$REASON" "x")"
expect_error "a direction that contradicts the kind is refused" "does not match kind" "$(req "$SUB" "$ORG" wallet_debit credit 100 "$REASON" "x")"
R_RAW=$(val "$(as "$SUB" "SELECT (public.request_admin_action('earnings_adjustment', 'user', '$ORG', 'raw', jsonb_build_object('kind','wallet_credit','direction','credit','amount_kobo',100.5,'reason','$REASON','evidence_ref','x')))->>'id';")")
expect_error "a raw request with a fractional amount is refused at execution" "whole number of kobo" "$(approve "$SUPER" "$R_RAW")"
R_RAW2=$(val "$(as "$SUB" "SELECT (public.request_admin_action('earnings_adjustment', 'user', '$ORG', 'raw', jsonb_build_object('kind','wallet_credit','direction','credit','amount_kobo',100,'reason','$REASON','evidence_ref','x')))->>'id';")")
expect_error "a raw request without the wallet snapshot is refused at execution" "wallet snapshot" "$(approve "$SUPER" "$R_RAW2")"

echo "== ledger_only (the dfca505f case: reverse a spurious ledger credit) =="
W0=$(wallet "$ORG"); G0=$(gap "$ORG")
expect_ok "a super admin approves it" "$(approve "$SUPER" "$R1")"
expect_value "the wallet is unchanged" "$(wallet "$ORG")" "$W0"
expect_value "exactly one adjustment_debit ledger row, linked to the request, created now" \
  "$(val "SELECT count(*) || '/' || bool_and(metadata->>'admin_request_id' = '$R1') || '/' || bool_and(created_at > now() - interval '1 minute') FROM public.organizer_transactions WHERE type = 'adjustment_debit' AND organizer_id = '$ORG';")" "1/true/true"
expect_value "the reconciliation gap moves by exactly the amount" "$(( G0 - $(gap "$ORG") ))" "100000"
expect_value "the adjustment record carries both admins and the before/after snapshot" \
  "$(val "SELECT kind || '/' || (requested_by = '$SUB')::text || '/' || (approved_by = '$SUPER')::text || '/' || balance_before_kobo || '/' || balance_after_kobo || '/' || (ledger_net_before_kobo - ledger_net_after_kobo) FROM public.earnings_adjustments WHERE admin_request_id = '$R1';")" \
  "ledger_only/true/true/100000/100000/100000"
expect_value "it is audited" "$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'earnings_adjustment_applied' AND details->>'admin_request_id' = '$R1';")" "1"
expect_error "approving again is refused (idempotent)" "Request already approved" "$(approve "$SUPER" "$R1")"
expect_value "...and nothing more was written" "$(val "SELECT count(*) FROM public.earnings_adjustments WHERE admin_request_id = '$R1';")" "1"

echo "== Stale approvals =="
R_STALE=$(val "$(req "$SUB" "$ORG" wallet_credit credit 500 "Owed credit confirmed by the organizer record" "ticket ref Z")")
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET balance_kobo = balance_kobo + 700 WHERE organizer_id = '$ORG'; INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG', 'credit', 700, 'a new sale after the request');"
W1=$(wallet "$ORG")
expect_error "a wallet that changed after the request cannot be adjusted" "wallet changed since" "$(approve "$SUPER" "$R_STALE")"
expect_value "...the request stays pending and nothing moved" "$(val "SELECT status FROM public.admin_action_requests WHERE id = '$R_STALE';")/$(wallet "$ORG")" "pending/$W1"

echo "== wallet_credit / wallet_debit =="
R2=$(val "$(req "$SUB" "$ORG" wallet_credit credit 500 "Owed credit confirmed by the organizer record" "ticket ref Z")")
expect_ok "a fresh credit request is approved" "$(approve "$SUPER" "$R2")"
expect_value "balance and earned rise by the amount; pending and withdrawn unchanged" "$(wallet "$ORG")" "101200/0/140500/0"
expect_error "a debit above the available balance is refused (no negative balance; pending is never debited)" "available balance" \
  "$(approve "$SUPER" "$(val "$(req "$SUB" "$ORG" wallet_debit debit 5000000 "Unsourced balance removed per owner decision" "D2")")")"
R3=$(val "$(req "$SUB" "$ORG" wallet_debit debit 300 "Unsourced balance removed per owner decision" "D2")")
expect_ok "a debit within the available balance is approved" "$(approve "$SUPER" "$R3")"
expect_value "balance and earned fall by the amount" "$(wallet "$ORG")" "100900/0/140200/0"
expect_value "the ledger and the wallet moved together (gap unchanged by wallet kinds)" "$(gap "$ORG")" "$(( G0 - 100000 ))"

echo "== late_recorded_payout (the 2026-07 incident rows) =="
expect_value "a late success for a swept request is still needs_review, with an exception" \
  "$(val "SELECT status FROM public.complete_organizer_payout('TRF_adj_0');")/$(val "SELECT count(*) FROM public.payout_exceptions WHERE request_id = '${IDS[0]}' AND resolved_at IS NULL;")" "needs_review/1"
SNAPJ=$(val "SELECT jsonb_build_object('expected_balance_kobo', w.balance_kobo, 'expected_pending_kobo', w.pending_kobo, 'expected_on_hold_kobo', w.on_hold_kobo, 'expected_ledger_net_kobo', public.earnings_ledger_net_kobo(w.organizer_id))::text FROM public.organizer_wallets w WHERE w.organizer_id = '$ORG';")
R_TC=$(val "$(as "$SUB" "SELECT (public.request_admin_action('earnings_adjustment', 'user', '$ORG', 'raw', jsonb_build_object('kind','late_recorded_payout','direction','debit','amount_kobo',10000,'reason','$REASON','evidence_ref','x','withdrawal_request_id','${IDS[0]}','transfer_code','TRF_wrong','paid_at','2026-07-10') || '$SNAPJ'::jsonb))->>'id';")")
expect_error "the transfer code must match the request (a raw request is re-validated at execution)" "transfer code must match" "$(approve "$SUPER" "$R_TC")"
expect_error "the amount must equal the request" "must equal the request" "$(req "$SUB" "$ORG" late_recorded_payout debit 9999 "$REASON" "Paystack export" "${IDS[0]}")"
expect_error "paid_at from the Paystack record is required" "paid_at" \
  "$(as "$SUB" "SELECT public.admin_request_earnings_adjustment('$ORG', 'late_recorded_payout', 'debit', 10000, '$REASON', 'Paystack export', '${IDS[0]}', NULL);")"
R4=$(val "$(req "$SUB" "$ORG" late_recorded_payout debit 10000 "Paystack LIVE shows this transfer paid on 2026-07-10" "Paystack export TRF_adj_0" "${IDS[0]}")")
W2=$(wallet "$ORG")
expect_ok "it is approved" "$(approve "$SUPER" "$R4")"
expect_value "one payout row linked to the request, marked recorded_late with paid_at" \
  "$(val "SELECT count(*) || '/' || bool_and((metadata->>'recorded_late')::boolean) || '/' || bool_and(metadata->>'paid_at' LIKE '2026-07-10%') FROM public.organizer_transactions WHERE withdrawal_request_id = '${IDS[0]}' AND type = 'payout';")" "1/true/true"
expect_value "total_withdrawn rises; balance and pending unchanged; the request stays cancelled" \
  "$(wallet "$ORG")/$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '${IDS[0]}';")" "100900/0/140200/10000/cancelled"
expect_value "its payout exception is resolved, and the integrity report no longer lists it" \
  "$(val "SELECT count(*) FROM public.payout_exceptions WHERE request_id = '${IDS[0]}' AND resolved_at IS NULL;")/$(val "$(as "$SUPER" "SELECT count(*) FROM public.admin_payout_integrity_report() WHERE request_id = '${IDS[0]}';")")" "0/0"
expect_error "the same payout cannot be recorded twice" "already recorded" "$(req "$SUB" "$ORG" late_recorded_payout debit 10000 "$REASON" "x" "${IDS[0]}")"
XR="00000000-0000-0000-0000-0000000006f1"; XP="00000000-0000-0000-0000-0000000006f2"
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, transfer_code) VALUES
    ('$XR', '$ORG', 10000, 'cancelled', '$BANK', 'TRF_returned'), ('$XP', '$ORG', 10000, 'processing', '$BANK', 'TRF_inflight');
  INSERT INTO public.admin_logs (admin_id, action, details) VALUES ('$SUPER', 'cancel_processing_payout', jsonb_build_object('request_id', '$XR'));"
expect_error "a request whose money was returned cannot be recorded as a late payout" "was returned to the balance" \
  "$(as "$SUB" "SELECT public.admin_request_earnings_adjustment('$ORG', 'late_recorded_payout', 'debit', 10000, '$REASON', 'x', '$XR', now());")"
expect_error "an in-flight request cannot be recorded as a late payout" "only a cancelled, failed or rejected" \
  "$(as "$SUB" "SELECT public.admin_request_earnings_adjustment('$ORG', 'late_recorded_payout', 'debit', 10000, '$REASON', 'x', '$XP', now());")"

echo "== Append-only =="
expect_error "an adjustment record cannot be updated" "append-only" "UPDATE public.earnings_adjustments SET amount_kobo = 1;"
expect_error "an adjustment record cannot be deleted" "append-only" "DELETE FROM public.earnings_adjustments;"
expect_error "an adjustment ledger row cannot be edited" "append-only" "UPDATE public.organizer_transactions SET amount_kobo = 1 WHERE type = 'adjustment_debit';"
expect_error "an adjustment ledger row cannot be deleted" "append-only" "DELETE FROM public.organizer_transactions WHERE type = 'adjustment_credit';"
expect_error "a late-recorded payout row cannot be back-dated or edited" "append-only" \
  "UPDATE public.organizer_transactions SET created_at = '2026-07-10' WHERE withdrawal_request_id = '${IDS[0]}' AND type = 'payout';"
expect_error "an adjustment ledger row cannot be inserted outside an approved adjustment" "only be written by an approved earnings_adjustment" \
  "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG', 'adjustment_credit', 1, 'forged');"
expect_ok "ordinary ledger writes still work" "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG_ADMIN', 'credit', 1, 'sale'); UPDATE public.organizer_wallets SET balance_kobo = balance_kobo + 1 WHERE organizer_id = '$ORG_ADMIN';"
expect_value "the wallet table CHECK still forbids a negative balance" "$(run "UPDATE public.organizer_wallets SET balance_kobo = -1 WHERE organizer_id = '$ORG';" | grep -c 'balance_kobo_check')" "1"

echo "== Expiry and demoted requesters =="
R5=$(val "$(req "$SUB" "$ORG" ledger_only credit 100 "$REASON" "x")")
"${PSQL[@]}" -q -c "UPDATE public.admin_action_requests SET requested_at = now() - interval '8 days' WHERE id = '$R5';"
expect_error "a request older than 7 days cannot be approved" "older than 7 days" "$(approve "$SUPER" "$R5")"
R6=$(val "$(req "$SUB2" "$ORG" ledger_only credit 100 "$REASON" "x")")
"${PSQL[@]}" -q -c "UPDATE public.users SET role = 'user' WHERE id = '$SUB2';"
expect_error "a request from an admin who has since been demoted cannot be approved" "no longer an admin" "$(approve "$SUPER" "$R6")"

echo "== Undo after execution =="
expect_value "undo is refused once adjustments have been executed" \
  "$(apply_file "$UNDO" "SET vents.rollback_confirm = 'undo-0206';" | grep -c 'financial history')" "1"
expect_value "...and changed nothing" "$(val "SELECT count(*) FROM public.earnings_adjustments;")" "4"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES EARNINGS ADJUSTMENT CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
