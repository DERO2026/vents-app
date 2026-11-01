#!/usr/bin/env bash
# Real-execution verification of migration 0205 against the exact
# production payout incident (docs/production-readiness-batch-d.md §2a):
#
#   four ₦100 withdrawal requests were sent to Paystack LIVE and paid, then
#   marked 'cancelled' by a raw UPDATE ("platform launch sweep",
#   migrations/20260713100000_admin-stats-and-payout-cleanup.sql). No money
#   was returned and no ledger row was written.
#
# Steps:
#   1. builds 0201 + 0202 + live functions + 0203 (the window's end state);
#   2. reproduces the incident with the sweep's own SQL, verbatim;
#   3. shows that WITHOUT 0205 a replayed transfer.success charges the
#      organizer a second time (inside a rolled-back transaction);
#   4. applies 0205 and proves:
#      - replays of success / failure / reversal move no money;
#      - the books are flagged once;
#      - the sweep can no longer run;
#      - legitimate legacy cancels still settle;
#      - every 0203 payout path still works.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
SWEEP_SQL="$REPO_ROOT/migrations/20260713100000_admin-stats-and-payout-cleanup.sql"
DB_NAME="vents_local_pg_payout_incident"
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

TMP=$(mktemp -d); OUT="$TMP/out"; ERR="$TMP/err"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
expect_error() {
  if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an exception, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error)"; cat "$ERR" >&2; fi
}
wallet() { val "SELECT balance_kobo || '/' || pending_kobo || '/' || total_withdrawn_kobo FROM public.organizer_wallets WHERE organizer_id = '$1';"; }
ledger_rows() { val "SELECT count(*) FROM public.organizer_transactions WHERE withdrawal_request_id = '$1';"; }
recoveries() { val "SELECT count(*) FROM public.earnings_recoveries WHERE owner_id = '$1';"; }
request_admin() { val "$(as "$1" "SELECT public.request_admin_action('$2', 'withdrawal', '$3', 'test', '$4'::jsonb)->>'id';")"; }
approve() { as "$1" "SELECT public.approve_admin_action('$2');"; }
ref() { echo "payout_${1//-/}"; }
claim() { val "$(as "$ADMIN_A" "SELECT claimed::text FROM public.admin_claim_payout_for_processing('$1');")"; }
authorize() { "${PSQL[@]}" -q -c "$(approve "$ADMIN_B" "$(request_admin "$ADMIN_A" authorize_withdrawal "$1" "{\"request_id\":\"$1\",\"amount_kobo\":$2}")")" >/dev/null; }

# Production ids of the incident (organizer 91b0afb4, test account "testerboy").
ORG="91b0afb4-b5dc-4289-ae00-8e6e58c60f5f"
BANK="dd3f9bc4-da28-4f45-920d-b573c4efad56"
R1="3aa0f8ff-d652-48cb-a06f-82a99d434dbe"; C1="TRF_5x4kfsos12pysbiz"; F1="payout_3aa0f8ff-d652-48cb-a06f-82a99d434dbe_1783681361539"
R2="f9fda363-8e24-45af-8d2a-74dd7edb61aa"; C2="TRF_tg95h5eis3j3evvp"; F2="payout_f9fda363-8e24-45af-8d2a-74dd7edb61aa_1783681476919"
R3="6ad1272d-14b8-41d9-8267-7ce8c0b3b4e8"; C3="TRF_wzotcvdwiv7ola7t"; F3="payout_6ad1272d-14b8-41d9-8267-7ce8c0b3b4e8_1783681779407"
R4="56b084bb-21df-4f23-9c90-02a5087f9642"; C4="TRF_fdjyi7dct57sf5j4"; F4="payout_56b084bb-21df-4f23-9c90-02a5087f9642_1783683296950"
LIVE_PENDING="00000000-0000-0000-0000-0000000005a1"   # stands in for the ₦4,000 pending request 6348714b
ADMIN_A="00000000-0000-0000-0000-0000000005c1"
ADMIN_B="00000000-0000-0000-0000-0000000005c2"
ORG2="00000000-0000-0000-0000-0000000005a2"; BANK2="00000000-0000-0000-0000-0000000005d2"   # a genuine legacy cancel

echo "== Building throwaway database $DB_NAME (0201 + 0202 + live functions + 0203) =="
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
"${PSQL[@]}" -q -f "$MIG/0203_earnings_policies.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid), public.admin_mark_payout_processing(uuid,text,text),
  public.admin_release_payout_claim(uuid,text), public.admin_cancel_processing_payout(uuid,text) TO authenticated;
UPDATE public.app_config SET disable_payouts = false;
INSERT INTO public.users (id, role, is_organizer, full_name, email, username) VALUES
  ('$ORG', 'user', true, 'Tester', 't@example.test', 'testerboy'),
  ('$ORG2', 'user', true, 'Org Two', 'o2@example.test', 'orgtwo'),
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test', 'admina'),
  ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test', 'adminb');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES
  ('$BANK', '$ORG', 'Moniepoint MFB', '50515', '9162337459', 'TEST HOLDER', 'RCP_testerboy', true),
  ('$BANK2', '$ORG2', 'Bank', '000', '0000000002', 'ORG TWO', 'RCP_org2', true);
SQL

echo "== Reproducing the incident (2026-07-09 .. 2026-07-12) =="
# ₦10,000 of earnings; four ₦100 requests move ₦400 from balance to pending
# (the July request function), are sent to Paystack (legacy random references,
# real transfer codes) and stay 'processing' because no completion arrived.
"${PSQL[@]}" -q <<SQL
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo, total_withdrawn_kobo)
  VALUES ('$ORG', 1000000 - 40000 - 400000, 40000 + 400000, 1000000, 0);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG', 'credit', 1000000, 'ticket sales');
INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, paystack_reference, transfer_code, created_at) VALUES
  ('$R1', '$ORG', 10000, 'processing', '$BANK', '$F1', '$C1', '2026-07-09 08:31:16+00'),
  ('$R2', '$ORG', 10000, 'processing', '$BANK', '$F2', '$C2', '2026-07-09 09:29:09+00'),
  ('$R3', '$ORG', 10000, 'processing', '$BANK', '$F3', '$C3', '2026-07-09 12:26:20+00'),
  ('$R4', '$ORG', 10000, 'processing', '$BANK', '$F4', '$C4', '2026-07-10 11:33:35+00');
SQL
# The sweep's statement, verbatim from the repository file.
SWEEP=$(awk '/^UPDATE public.organizer_withdrawal_requests w/,/;$/' "$SWEEP_SQL")
[ -n "$SWEEP" ] || die "could not extract the sweep statement from $SWEEP_SQL"
expect_ok "before 0205, the July sweep's UPDATE runs on transfers Paystack paid" "$SWEEP"
# Production today: pending holds only the live requests (₦44,100 = the 4
# requested in September); the swept ₦400 left pending through an
# unrecorded step. One later request stands in for them.
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET pending_kobo = pending_kobo - 40000 WHERE organizer_id = '$ORG';
  INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, created_at)
    VALUES ('$LIVE_PENDING', '$ORG', 400000, 'pending', '$BANK', '2026-09-16 02:01:48+00');"
expect_value "incident state: 4 cancelled rows with transfer codes, none with a ledger row" \
  "$(val "SELECT count(*) FILTER (WHERE status = 'cancelled' AND transfer_code IS NOT NULL) || '/' || count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.organizer_transactions t WHERE t.withdrawal_request_id = r.id)) FROM public.organizer_withdrawal_requests r WHERE organizer_id = '$ORG';")" "4/0"
expect_value "incident state: available ₦5,600, pending ₦4,000 (only the live request), withdrawn ₦0" "$(wallet "$ORG")" "560000/400000/0"

echo "== Without 0205: what a replayed transfer.success would do =="
BEFORE=$(val "BEGIN; SELECT status FROM public.complete_organizer_payout('$C1'); ROLLBACK;")
NO_0205=$("${PSQL[@]}" -tA -c "BEGIN; SELECT status FROM public.complete_organizer_payout('$C1'); SELECT balance_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG'; ROLLBACK;" 2>/dev/null | grep -E '^[0-9a-z_]+$' | tr '\n' '/')
expect_value "DEFECT reproduced (0202 + 0203 alone): the paid ₦100 is taken from the balance again" "$NO_0205" "completed/550000/"

echo "== Applying 0205 =="
MD5_0203=$(val "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.complete_organizer_payout(text)'::regprocedure;")
echo "complete_organizer_payout after 0203: md5 $MD5_0203"
expect_value "0205's drift guard is pinned to 0203's body" "$(grep -c "$MD5_0203" "$MIG/0205_payout_cancelled_transfer_safety.sql")" "1"
expect_error "0205 refuses if complete_organizer_payout drifted from 0203" "differs from 0203" \
  "BEGIN; DO \$d\$ DECLARE v text := pg_get_functiondef('public.complete_organizer_payout(text)'::regprocedure); BEGIN EXECUTE replace(v, 'DECLARE', E'DECLARE\n  -- drift'); END \$d\$; $(cat "$MIG/0205_payout_cancelled_transfer_safety.sql") ROLLBACK;"
expect_ok "0205 applies" "$(cat "$MIG/0205_payout_cancelled_transfer_safety.sql")"
expect_ok "0205 is idempotent" "$(cat "$MIG/0205_payout_cancelled_transfer_safety.sql")"
expect_value "applying 0205 changed no money or request" \
  "$(wallet "$ORG")/$(val "SELECT string_agg(status, ',' ORDER BY created_at) FROM public.organizer_withdrawal_requests WHERE organizer_id = '$ORG';")" \
  "560000/400000/0/cancelled,cancelled,cancelled,cancelled,pending"

echo "== The incident after 0205: replays move no money =="
for key in "$C1" "$F2" "$R3" "$C4" "$C1"; do
  expect_value "transfer.success replay for $key -> needs_review, wallet unchanged" \
    "$(val "SELECT status FROM public.complete_organizer_payout('$key');")/$(wallet "$ORG")" "needs_review/560000/400000/0"
done
expect_value "no ledger row, no receivable, status still cancelled" \
  "$(ledger_rows "$R1")$(ledger_rows "$R2")$(ledger_rows "$R3")$(ledger_rows "$R4")/$(recoveries "$ORG")/$(val "SELECT count(*) FROM public.organizer_withdrawal_requests WHERE organizer_id = '$ORG' AND status = 'cancelled';")" \
  "0000/0/4"
expect_value "each affected request is flagged once (a replay does not log twice)" \
  "$(val "SELECT count(*) || '/' || count(DISTINCT details->>'request_id') FROM public.admin_logs WHERE action = 'payout_success_on_unrefunded_cancel';")" "4/4"
expect_value "transfer.failed for a swept request changes nothing" \
  "$(val "SELECT status FROM public.fail_organizer_payout('$C2', 'late failure');")/$(wallet "$ORG")" "already_finalized/560000/400000/0"
expect_value "transfer.reversed for a swept request changes nothing" \
  "$(val "SELECT status FROM public.reverse_organizer_payout('$C3', 'late reversal');")/$(wallet "$ORG")" "already_finalized/560000/400000/0"
expect_value "the live ₦4,000 request's pending money was never touched" \
  "$(val "SELECT pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")/$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '$LIVE_PENDING';")" "400000/pending"
expect_value "the integrity report lists the four swept requests" \
  "$(val "$(as "$ADMIN_A" "SELECT count(DISTINCT request_id) FROM public.admin_payout_integrity_report() WHERE issue = 'cancelled_with_transfer_funds_not_returned';")")" "4"
expect_value "the report also shows Paystack's late successes" \
  "$(val "$(as "$ADMIN_A" "SELECT count(*) FROM public.admin_payout_integrity_report() WHERE issue = 'paystack_success_received_after_cancel';")")" "4"
expect_value "the report is empty for a non-admin" \
  "$(val "$(as "$ORG" "SELECT count(*) FROM public.admin_payout_integrity_report();")")" "0"
expect_error "anon cannot run the report" "permission denied" "SET ROLE anon; SELECT * FROM public.admin_payout_integrity_report();"

echo "== The sweep can no longer happen =="
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, paystack_reference, transfer_code) VALUES ('00000000-0000-0000-0000-0000000005b1', '$ORG', 10000, 'processing', '$BANK', 'payout_x', 'TRF_new');"
expect_error "the July sweep statement is refused for a request with a transfer" "payout_guard" "$SWEEP"
expect_error "processing + transfer -> rejected is refused" "payout_guard" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'rejected' WHERE transfer_code = 'TRF_new';"
expect_error "processing + transfer -> pending is refused" "payout_guard" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'pending' WHERE transfer_code = 'TRF_new';"
expect_error "a transfer code cannot be rewritten" "payout_guard" \
  "UPDATE public.organizer_withdrawal_requests SET transfer_code = NULL WHERE transfer_code = 'TRF_new';"
expect_error "a Paystack reference cannot be rewritten" "payout_guard" \
  "UPDATE public.organizer_withdrawal_requests SET paystack_reference = 'other' WHERE id = '$R1';"
expect_error "an amount cannot be rewritten" "payout_guard" \
  "UPDATE public.organizer_withdrawal_requests SET amount_kobo = 1 WHERE id = '$LIVE_PENDING';"
expect_error "a cancelled request cannot be reopened" "payout_guard" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'pending' WHERE id = '$R1';"
expect_error "a request with payout history cannot be deleted" "payout_guard" \
  "DELETE FROM public.organizer_withdrawal_requests WHERE id = '$R1';"
expect_value "the swept rows are still exactly as found" \
  "$(val "SELECT string_agg(status || ':' || transfer_code, ',' ORDER BY created_at) FROM public.organizer_withdrawal_requests WHERE id IN ('$R1','$R2','$R3','$R4');")" \
  "cancelled:$C1,cancelled:$C2,cancelled:$C3,cancelled:$C4"
"${PSQL[@]}" -q -c "SET session_replication_role = replica; DELETE FROM public.organizer_withdrawal_requests WHERE transfer_code = 'TRF_new';"

echo "== A genuine legacy cancel (money returned + refund ledger row) still settles =="
GL="00000000-0000-0000-0000-0000000005b2"
"${PSQL[@]}" -q <<SQL
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo) VALUES ('$ORG2', 100000, 0, 100000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG2', 'credit', 100000, 'sales');
INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, paystack_reference, transfer_code) VALUES
  ('$GL', '$ORG2', 50000, 'cancelled', '$BANK2', 'payout_legacy_gl', 'TRF_gl');
-- What pre-0202 admin_cancel_processing_payout wrote when it returned the money.
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id)
  VALUES ('$ORG2', 'cancelled_payout_refund', 50000, 'Payout request cancelled by admin, funds returned', '$GL');
SQL
expect_value "its success takes the returned money back once (0202 behaviour kept)" \
  "$(val "SELECT status FROM public.complete_organizer_payout('TRF_gl');")/$(val "SELECT status FROM public.complete_organizer_payout('TRF_gl');")/$(wallet "$ORG2")" \
  "completed/already_completed/50000/0/50000"

echo "== Every 0203 payout path still works with the guard =="
ORG3="00000000-0000-0000-0000-0000000005a3"; BANK3="00000000-0000-0000-0000-0000000005d3"
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email, username) VALUES ('$ORG3', 'user', true, 'Org Three', 'o3@example.test', 'orgthree');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active)
  VALUES ('$BANK3', '$ORG3', 'Bank', '000', '0000000003', 'ORG THREE', 'RCP_org3', true);
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo) VALUES ('$ORG3', 1000000, 1000000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG3', 'credit', 1000000, 'sales before 0203');
SQL
W1=$(val "$(as "$ORG3" "SELECT public.request_organizer_payout(300000, '$BANK3', 'w1');")")
expect_value "request moves money to pending" "$(wallet "$ORG3")" "700000/300000/0"
authorize "$W1" 300000
expect_value "two-admin authorize, claim once" "$(claim "$W1")/$(claim "$W1")" "true/false"
expect_ok "mark sent with the fixed reference and a transfer code" \
  "$(as "$ADMIN_A" "SELECT public.admin_mark_payout_processing('$W1', '$(ref "$W1")', 'TRF_w1');")"
expect_error "once sent, it cannot be cancelled" "A Paystack transfer may exist" \
  "$(as "$ADMIN_A" "SELECT * FROM public.admin_cancel_processing_payout('$W1', 'oops');")"
expect_value "success completes it once, with one ledger payout" \
  "$(val "SELECT status FROM public.complete_organizer_payout('TRF_w1');")/$(val "SELECT status FROM public.complete_organizer_payout('TRF_w1');")/$(wallet "$ORG3")/$(ledger_rows "$W1")" \
  "completed/already_completed/700000/0/300000/1"
expect_value "a reversal returns it once" \
  "$(val "SELECT status FROM public.reverse_organizer_payout('TRF_w1', 'bank reversed');")/$(val "SELECT status FROM public.reverse_organizer_payout('TRF_w1', 'again');")/$(wallet "$ORG3")" \
  "reversed/already_finalized/1000000/0/0"
expect_error "a reversed request is final" "payout_guard" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'completed' WHERE id = '$W1';"

W2=$(val "$(as "$ORG3" "SELECT public.request_organizer_payout(200000, '$BANK3', 'w2');")")
authorize "$W2" 200000
expect_value "a failed transfer returns the money once" \
  "$(claim "$W2")/$(val "SELECT status FROM public.fail_organizer_payout(public.payout_transfer_reference('$W2'), 'bank down');")/$(val "SELECT status FROM public.fail_organizer_payout(public.payout_transfer_reference('$W2'), 'bank down');")/$(wallet "$ORG3")" \
  "true/failed/already_finalized/1000000/0/0"

W3=$(val "$(as "$ORG3" "SELECT public.request_organizer_payout(100000, '$BANK3', 'w3');")")
authorize "$W3" 100000
expect_value "a claim Paystack never received can be released (no transfer code) and keeps its reference" \
  "$(claim "$W3")/$(val "$(as "$ADMIN_A" "SELECT public.admin_release_payout_claim('$W3', 'not found on Paystack')::text;")")/$(val "SELECT status || ':' || (paystack_reference = public.payout_transfer_reference(id))::text FROM public.organizer_withdrawal_requests WHERE id = '$W3';")" \
  "true//pending:true"
expect_value "a pending request (no transfer) can still be rejected and the money returns" \
  "$(val "$(as "$ADMIN_A" "SELECT public.admin_reject_organizer_payout('$W3', 'duplicate')::text;")")/$(wallet "$ORG3")" "rejected/1000000/0/0"
expect_error "a rejected request is final" "payout_guard" \
  "UPDATE public.organizer_withdrawal_requests SET status = 'pending' WHERE id = '$W3';"
expect_value "ledger, balance and pending agree for a wallet that used every 0203 path" \
  "$(val "$(as "$ADMIN_A" "SELECT count(*) FILTER (WHERE ledger_gap_kobo <> 0 OR pending_gap_kobo <> 0) FROM public.admin_earnings_reconciliation() WHERE organizer_id = '$ORG3';")")" "0"
# Known, pre-existing (audit P1-6): a pre-0202 cancel wrote a
# cancelled_payout_refund credit with no matching debit, so after the late
# success the ledger stays high by exactly that credit. Production has no
# such row (all 4 cancelled rows have no refund row).
expect_value "legacy cancel + late success leaves the ledger high by exactly the old refund credit (P1-6)" \
  "$(val "$(as "$ADMIN_A" "SELECT ledger_gap_kobo FROM public.admin_earnings_reconciliation() WHERE organizer_id = '$ORG2';")")" "50000"
expect_value "the incident wallet is still reported (its books need an owner decision)" \
  "$(val "$(as "$ADMIN_A" "SELECT (ledger_gap_kobo <> 0)::text FROM public.admin_earnings_reconciliation() WHERE organizer_id = '$ORG';")")" "true"

echo
if [ "$FAILS" -gt 0 ]; then echo "$FAILS of $((PASSES+FAILS)) CHECKS FAILED" >&2; exit 1; fi
echo "ALL $PASSES PAYOUT INCIDENT CHECKS PASSED"
