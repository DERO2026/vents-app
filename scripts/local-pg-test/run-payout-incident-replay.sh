#!/usr/bin/env bash
# Replays the 2026-07 payout incident on a LOCAL throwaway database:
#   1. on production's current code (the live complete_organizer_payout,
#      captured read-only 2026-10-30), to prove the root cause: a transfer
#      that Paystack paid, whose request was then set to 'cancelled' by a
#      status-only UPDATE, is silently swallowed by a later success webhook;
#   2. on the same rows after 0201 -> 0202 -> 0203, to prove the fix.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
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
cleanup() { pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
val() { "${PSQL[@]}" -tA -c "$1" 2>/dev/null | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', expected '$3')"; fi; }

ORG="91b0afb4-b5dc-4289-ae00-8e6e58c60f5f"   # the production organizer (testerboy), for realism only
BANK="00000000-0000-0000-0000-00000000b0a1"
IDS=(3aa0f8ff-d652-48cb-a06f-82a99d434dbe f9fda363-8e24-45af-8d2a-74dd7edb61aa 6ad1272d-14b8-41d9-8267-7ce8c0b3b4e8 56b084bb-21df-4f23-9c90-02a5087f9642)
TS=(1783681361539 1783681476919 1783681779407 1783683296950)

pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
for f in schema-representative-rewards.sql schema-live-payout-extras.sql schema-earnings-policies.sql live-money-functions.sql; do
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/$f" >/dev/null 2>&1
done
# Production's own complete_organizer_payout (body md5 563304a9...).
"${PSQL[@]}" -q -f - <"$REPO_ROOT/supabase/rollback/sources/complete_organizer_payout.prod-2026-10-30.sql" >/dev/null
expect_value "the replay runs production's exact complete_organizer_payout" \
  "$(val "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.complete_organizer_payout(text)'::regprocedure;")" "563304a9394f6fb5148b2d458ce945f6"

# The four requests as the July 9 engine left them on 2026-07-10: NGN 100
# each moved from balance to pending, transfer initiated (code + reference
# payout_<id>_<ms>), status 'processing'.
"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES ('$ORG', 'user', true, 'testerboy', 't@example.test');
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active)
VALUES ('$BANK', '$ORG', 'OPay', '999992', '0000000000', 'TEST', 'RCP_t', true);
INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo) VALUES ('$ORG', 60000, 40000, 100000);
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG', 'credit', 100000, 'sales');
SQL
for i in 0 1 2 3; do
  "${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, transfer_code, paystack_reference, created_at)
    VALUES ('${IDS[$i]}', '$ORG', 10000, 'processing', '$BANK', 'TRF_incident_$i', 'payout_${IDS[$i]}_${TS[$i]}', '2026-07-10 11:00:00+00');"
done
# 2026-07-12 23:41: migration 20260713100000 -- status only.
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET status = 'cancelled', admin_note = 'Test payout request cleared during platform launch sweep', updated_at = now() WHERE organizer_id = '$ORG' AND status IN ('pending', 'processing');"

echo "== Root cause on production's current code =="
expect_value "a late transfer.success for a swept request is answered 'already_completed'" \
  "$(val "SELECT status FROM public.complete_organizer_payout('payout_${IDS[0]}_${TS[0]}');")" "already_completed"
expect_value "...and nothing changes: still cancelled, no ledger row, the money still counted as pending" \
  "$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '${IDS[0]}';")/$(val "SELECT count(*) FROM public.organizer_transactions WHERE withdrawal_request_id = '${IDS[0]}';")/$(val "SELECT pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")" \
  "cancelled/0/40000"

echo "== The same rows after 0201 -> 0202 -> 0203 =="
apply() { "${PSQL[@]}" -q -1 -c "SET vents.migration_local_test = 'on';" -f - <"$1" >/dev/null 2>&1 && echo ok || echo failed; }
expect_value "0201 applies" "$(apply "$MIG/0201_vents_earn_representative_rewards.sql")" "ok"
expect_value "0202 applies" "$(apply "$MIG/0202_payout_engine_safety.sql")" "ok"
expect_value "0203 applies" "$(apply "$MIG/0203_earnings_policies.sql")" "ok"
expect_value "admins now see all four as transfer codes on cancelled requests, without any webhook" \
  "$(val "SET test.uid='00000000-0000-0000-0000-00000000ad01'; SELECT 1;" >/dev/null; val "SELECT count(*) FROM public.organizer_withdrawal_requests r WHERE r.status = 'cancelled' AND r.transfer_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organizer_transactions t WHERE t.withdrawal_request_id = r.id AND t.type = 'payout');")" "4"
expect_value "with their money still in pending, a late success completes each one from pending, once" \
  "$(for i in 0 1; do val "SELECT status FROM public.complete_organizer_payout('payout_${IDS[$i]}_${TS[$i]}');"; done | tr '\n' ',')$(val "SELECT balance_kobo || '/' || pending_kobo || '/' || total_withdrawn_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")" \
  "completed,completed,60000/20000/20000"
expect_value "each completed one has exactly one linked payout ledger row" \
  "$(val "SELECT count(*) FROM public.organizer_transactions WHERE withdrawal_request_id IN ('${IDS[0]}', '${IDS[1]}') AND type = 'payout';")" "2"
expect_value "a duplicate webhook changes nothing" \
  "$(val "SELECT status FROM public.complete_organizer_payout('TRF_incident_0');")/$(val "SELECT count(*) FROM public.organizer_transactions WHERE withdrawal_request_id = '${IDS[0]}';")" "already_completed/1"
# Production today: the remaining money was removed from pending by a write
# the records do not show.
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET pending_kobo = 0 WHERE organizer_id = '$ORG';"
expect_value "when pending no longer holds it, a late success moves no money and records an exception" \
  "$(val "SELECT status FROM public.complete_organizer_payout('payout_${IDS[2]}_${TS[2]}');")/$(val "SELECT balance_kobo || '/' || pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")/$(val "SELECT kind FROM public.payout_exceptions WHERE request_id = '${IDS[2]}';")" \
  "needs_review/60000/0/paid_after_cancel_unresolved"
expect_value "...and the request is not silently rewritten" "$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '${IDS[2]}';")" "cancelled"
# A fresh in-flight request (processing, transfer initiated) -- the state the
# four were in when the 2026-07-12 sweep ran.
SWEEP_ID="00000000-0000-0000-0000-0000000005e5"
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_withdrawal_requests (id, organizer_id, amount_kobo, status, bank_account_id, transfer_code, paystack_reference)
  VALUES ('$SWEEP_ID', '$ORG', 10000, 'processing', '$BANK', 'TRF_incident_sweep', 'payout_${SWEEP_ID}_1');"
R=$("${PSQL[@]}" -c "UPDATE public.organizer_withdrawal_requests SET status = 'cancelled', admin_note = 'sweep' WHERE organizer_id = '$ORG' AND status IN ('pending', 'processing');" 2>&1)
expect_value "a status-only sweep can no longer be repeated on a request with a transfer code" \
  "$(echo "$R" | grep -c 'a Paystack transfer exists')/$(val "SELECT status FROM public.organizer_withdrawal_requests WHERE id = '$SWEEP_ID';")" "1/processing"
R=$("${PSQL[@]}" -c "UPDATE public.organizer_withdrawal_requests SET transfer_code = NULL WHERE id = '${IDS[3]}';" 2>&1)
expect_value "nor can a transfer code be cleared to hide it" "$(echo "$R" | grep -c 'cannot be changed or cleared')" "1"
# Production's real state for 91b0afb4: pending holds exactly what its OTHER
# open requests are owed. A late success for one of the four must not take
# that money (it belongs to the open request).
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET pending_kobo = 10000 WHERE organizer_id = '$ORG';"
expect_value "when pending only covers other open requests, a late success still moves nothing (needs_review)" \
  "$(val "SELECT status FROM public.complete_organizer_payout('payout_${IDS[3]}_${TS[3]}');")/$(val "SELECT balance_kobo || '/' || pending_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")/$(val "SELECT count(*) FROM public.payout_exceptions;")" \
  "needs_review/60000/10000/2"
expect_value "a repeated late success for the same request records no second exception" \
  "$(val "SELECT status FROM public.complete_organizer_payout('TRF_incident_3');")/$(val "SELECT count(*) FROM public.payout_exceptions;")" "needs_review/2"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES PAYOUT INCIDENT REPLAY CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
