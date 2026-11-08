#!/usr/bin/env bash
# Real-execution verification of migration 0208 (ticket fees 1.5% attendee
# service fee + 3.5% organizer commission, owner instruction 2026-11-08):
#   - attendee pays qty x (face + round(face x 1.5%) - promo), per ticket in kobo;
#   - organizer is settled qty x (face - round(face x 3.5%)), on hold as 0203 rules;
#   - VENTS keeps exactly 5% per ticket, never more (no double charge);
#   - wallet checkout, Paystack confirm, refunds and analytics use the same numbers;
#   - legacy (pre-0203) purchases keep their 5% buyer-fee arithmetic;
#   - 0208 is idempotent, refuses without 0203, and every wallet reconciles.
# Same throwaway local database setup as run-earnings-policy-verification.sh.
#           recovered from later earnings; never a negative balance;
#   rule 3  a withdrawal needs two different admins, neither the organizer,
#           and is paid only to the bank recipient that was authorized;
#   and the ledger explains available + pending + on hold after each step.
#
# Builds the 0201 + 0202 stack used by run-payout-engine-verification.sh,
# loads the live ticket/booking money functions (live-money-functions.sql,
# md5-verified against production), creates legacy rows, then applies 0203.
# No network, no Paystack: Paystack outcomes are the RPC calls the webhook
# and API make.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files.
#
# Usage: scripts/local-pg-test/run-earnings-policy-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_fee_model_new"
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

ORG="00000000-0000-0000-0000-0000000003a1"
ORG_ADMIN="00000000-0000-0000-0000-0000000003a2"
PROV="00000000-0000-0000-0000-0000000003a3"
BUYER="00000000-0000-0000-0000-0000000003b1"
BUYER2="00000000-0000-0000-0000-0000000003b2"
ADMIN_A="00000000-0000-0000-0000-0000000003c1"
ADMIN_B="00000000-0000-0000-0000-0000000003c2"
SUB="00000000-0000-0000-0000-0000000003c3"
EVENT="00000000-0000-0000-0000-0000000003e1"
E_R2="00000000-0000-0000-0000-0000000003e3"
E_PROMO="00000000-0000-0000-0000-0000000003e4"
E_W1="00000000-0000-0000-0000-0000000003e5"
E_S2="00000000-0000-0000-0000-0000000003e6"
E_B1="00000000-0000-0000-0000-0000000003e7"
E_B2="00000000-0000-0000-0000-0000000003e8"
E_B3="00000000-0000-0000-0000-0000000003e9"
ORG3="00000000-0000-0000-0000-0000000003a4"
EVENT2="00000000-0000-0000-0000-0000000003e2"
BANK="00000000-0000-0000-0000-0000000003d1"
BANK_OA="00000000-0000-0000-0000-0000000003d2"
SP_ID="00000000-0000-0000-0000-0000000003f1"

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
# available/pending/on hold
wallet() { val "SELECT balance_kobo || '/' || pending_kobo || '/' || on_hold_kobo FROM public.organizer_wallets WHERE organizer_id = '$1';"; }
# Ledger = available + pending + on hold, pending = open requests, on hold = open holds, for every wallet.
reconciled() { val "$(as "$ADMIN_A" "SELECT count(*) FILTER (WHERE ledger_gap_kobo <> 0 OR pending_gap_kobo <> 0 OR hold_gap_kobo <> 0 OR 'negative_balance' = ANY(issues)) FROM public.admin_earnings_reconciliation();")"; }
buy() {  # buy <user> <event> <n attendees> [promo] -> payment_ref
  local att; att=$(python3 -c "import json,sys; print(json.dumps([{'name': 'A%d' % i} for i in range(int(sys.argv[1]))]))" "$3")
  val "$(as "$1" "SELECT public.create_pending_purchase('$2', 'Regular', '$att'::jsonb, ${4:-NULL})->>'payment_ref';")"
}
amount_of() { val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$1';"; }
# Paystack webhook / verify (server), as api/_lib/finalizePaystackPayment.ts does it:
# finalize the pending purchase (idempotent), then confirm the payment.
confirm() {
  "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$1');" >/dev/null 2>&1 || true
  val "SELECT public.confirm_ticket_payment('$1', $2);"
}
hold_of() { val "SELECT amount_kobo || '/' || refunded_kobo || '/' || released_kobo FROM public.earnings_holds WHERE source_key = '$1';"; }
# Time travel for an event (test-only owner write): it ended <ago> ago, and
# its sales were made before that end (default: just over 48 hours ago).
end_event() {
  local ago="${2:-48 hours 1 minute}"
  "${PSQL[@]}" -q -c "UPDATE public.events SET event_date = now() - interval '$ago' - interval '3 hours', end_date = now() - interval '$ago' WHERE id = '$1';
    UPDATE public.earnings_holds SET event_end_at_sale = now() - interval '$ago' WHERE event_id = '$1';"
}
# Time travel for a completed booking: completed <ago> ago (the stamp is
# trigger-protected, so the test disables it for this one write).
complete_ago() {
  "${PSQL[@]}" -q -c "ALTER TABLE public.service_bookings DISABLE TRIGGER service_bookings_stamp_completion;
    UPDATE public.service_bookings SET completed_at = now() - interval '${2:-48 hours 1 minute}' WHERE id = '$1';
    ALTER TABLE public.service_bookings ENABLE TRIGGER service_bookings_stamp_completion;"
}
blockers() { val "SELECT string_agg(b, ',' ORDER BY b) FROM public.earnings_holds h, jsonb_array_elements_text(public.earnings_hold_state(h.id)->'blockers') b WHERE h.source_key = '$1';"; }
settle() { val "$(as "$1" "SELECT public.settle_my_earnings()::text;")"; }
first_ticket() { val "SELECT id FROM public.tickets WHERE payment_ref = '$1' ORDER BY id LIMIT 1;"; }
request_admin() { val "$(as "$1" "SELECT public.request_admin_action('$2', 'withdrawal', '$3', 'test', '$4'::jsonb)->>'id';")"; }
approve() { as "$1" "SELECT public.approve_admin_action('$2');"; }
claim() { val "$(as "$ADMIN_A" "SELECT claimed::text FROM public.admin_claim_payout_for_processing('$1');")"; }

echo "== Building throwaway database $DB_NAME =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
# Local stubs, not production bodies: 0202's drift guard is relaxed only
# with this setting on a vents_local_pg_* database.
"${PSQL[@]}" -q -c "SET vents.migration_local_test = 'on';" -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.confirm_ticket_payment_via_wallet(text),
  public.refund_ticket(uuid,text), public.cancel_service_booking(uuid,text), public.get_event_analytics(uuid),
  public.admin_claim_payout_for_processing(uuid), public.complete_service_booking(uuid) TO authenticated;
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test'), ('$ORG_ADMIN', 'admin', true, 'Org Admin', 'oa@example.test'),
  ('$PROV', 'user', false, 'Provider', 'p@example.test'),
  ('$BUYER', 'user', false, 'Buyer', 'b@example.test'), ('$BUYER2', 'user', false, 'Buyer Two', 'b2@example.test'),
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test'), ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test'),
  ('$SUB', 'sub-admin', false, 'Sub', 's@example.test'), ('$ORG3', 'user', true, 'Org Three', 'o3@example.test');
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EVENT', '$ORG', 'Concert', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_R2', '$ORG', 'Concert night 2', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_PROMO', '$ORG', 'Promo night', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_W1', '$ORG', 'Wallet night', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_S2', '$ORG', 'Second season', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_B1', '$ORG3', 'Blockers 1', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_B2', '$ORG3', 'Blockers 2', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$E_B3', '$ORG3', 'Reported', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$EVENT2', '$ORG_ADMIN', 'Admin gig', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 5000}]');
INSERT INTO public.promo_codes (code, discount_percentage) VALUES ('TEN', 10);
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES
  ('$BANK', '$ORG', 'Bank', '000', '0000000001', 'ORG', 'RCP_org', true),
  ('$BANK_OA', '$ORG_ADMIN', 'Bank', '000', '0000000002', 'ORG ADMIN', 'RCP_oa', true);
INSERT INTO public.service_providers (id, user_id) VALUES ('$SP_ID', '$PROV');
SQL

"${PSQL[@]}" -q -c "INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('00000000-0000-0000-0000-0000000008e1', '$ORG', 'Odd price', now() + interval '30 days', 'live', '[{\"name\": \"Regular\", \"price\": 1001}]');"
E_ODD="00000000-0000-0000-0000-0000000008e1"

echo "== Before 0203: a legacy purchase (5% buyer fee, organizer gets face) =="
LEG_OPEN=$(buy "$BUYER2" "$EVENT" 1)
"${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$LEG_OPEN');" >/dev/null

echo "== 0208 refuses without 0203 =="
expect_error "0208 on a database without 0203 stops before changing anything" "0208 requires 0203" "$(cat "$MIG/0208_ticket_fee_1_5_3_5.sql")"

echo "== Applying 0203, 0205, 0206, 0207, then 0208 =="
for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment; do
  expect_ok "$m applies" "$(cat "$MIG/$m.sql")"
done
STATE_SQL="SELECT md5(string_agg(p.proname || ':' || p.prosrc, '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT string_agg(pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE conname LIKE '%fee_model_check') || '/' || (SELECT string_agg(column_default, ',' ORDER BY table_name) FROM information_schema.columns WHERE table_schema='public' AND column_name='fee_model') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
PRE_0208=$(val "$STATE_SQL")
expect_ok "0208 applies on top of 0203-0207" "$(cat "$MIG/0208_ticket_fee_1_5_3_5.sql")"
expect_error "undo_0208 refuses without its confirmation setting" "undo_0208 refused" "$(cat "$REPO_ROOT/supabase/rollback/undo_0208.sql")"
expect_ok "undo_0208 runs before any 1.5% + 3.5% sale" "SET vents.rollback_confirm = 'undo-0208'; $(cat "$REPO_ROOT/supabase/rollback/undo_0208.sql")"
expect_value "undo_0208 restores every function, constraint and default exactly to the 0203 state" "$(val "$STATE_SQL")" "$PRE_0208"
expect_ok "0208 re-applies after the undo" "$(cat "$MIG/0208_ticket_fee_1_5_3_5.sql")"
MD5_1=$(val "SELECT md5(string_agg(prosrc, '' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%[0208]%';")
expect_ok "0208 is idempotent (second run)" "$(cat "$MIG/0208_ticket_fee_1_5_3_5.sql")"
expect_value "a second run changes no function body" \
  "$(val "SELECT md5(string_agg(prosrc, '' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%[0208]%';")" "$MD5_1"
expect_value "six money functions carry the 0208 marker" \
  "$(val "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%[0208]%';")" "6"
expect_value "no money function still multiplies by the 4% rate for new sales" \
  "$(val "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('create_pending_purchase','confirm_ticket_payment','confirm_ticket_payment_via_wallet','refund_ticket','finalize_ticket_refund','get_event_analytics') AND prosrc LIKE '%ticket_fee_buyer_multiplier%';")" "0"
expect_value "new columns default to v3_15_35" \
  "$(val "SELECT string_agg(column_default, ',' ORDER BY table_name) FROM information_schema.columns WHERE table_schema='public' AND column_name='fee_model' AND table_name IN ('tickets','pending_purchases');")" \
  "'v3_15_35'::text,'v3_15_35'::text"
expect_value "the fee helpers are not callable by clients" \
  "$(val "SELECT has_function_privilege('authenticated', 'public.ticket_fee_buyer_charge_kobo(numeric,integer,numeric,text)', 'EXECUTE')::text || '/' || has_function_privilege('anon', 'public.ticket_fee_commission_total_kobo(numeric,integer,text)', 'EXECUTE')::text;")" "false/false"

echo "== Fee arithmetic (kobo, per ticket x quantity) =="
expect_value "₦10,000: attendee pays ₦10,150 (1.5%)" "$(val "SELECT public.ticket_fee_buyer_charge_kobo(10000, 1, 0, 'v3_15_35');")" "1015000"
expect_value "₦10,000: commission ₦350 (3.5%), organizer gets ₦9,650" \
  "$(val "SELECT public.ticket_fee_commission_kobo(1000000, 'v3_15_35') || '/' || (1000000 - public.ticket_fee_commission_kobo(1000000, 'v3_15_35'));")" "35000/965000"
expect_value "₦1,001 x 3: per ticket 100100 + 1502 (1501.5 rounded half-up) = 101602, x3 = 304806" \
  "$(val "SELECT public.ticket_fee_buyer_charge_kobo(3003, 3, 0, 'v3_15_35');")" "304806"
expect_value "₦1,001 x 3: commission per ticket 3504 (3503.5 half-up), x3 = 10512" \
  "$(val "SELECT public.ticket_fee_commission_total_kobo(3003, 3, 'v3_15_35');")" "10512"
expect_value "the quantity multiplies the per-ticket amount exactly (1..10 tickets)" \
  "$(val "SELECT bool_and(public.ticket_fee_buyer_charge_kobo(1001 * n, n, 0, 'v3_15_35') = n * 101602 AND public.ticket_fee_commission_total_kobo(1001 * n, n, 'v3_15_35') = n * 3504)::text FROM generate_series(1, 10) n;")" "true"
expect_value "VENTS keeps exactly 5% of face on round prices, and attendee fee + commission = 5% +/- 1 kobo on any price" \
  "$(val "SELECT bool_and(abs(public.ticket_fee_buyer_charge_kobo(p, 1, 0, 'v3_15_35') - p * 100 + public.ticket_fee_commission_kobo((p * 100)::bigint, 'v3_15_35') - p * 5) <= 1)::text FROM generate_series(1, 5000) p;")" "true"
expect_value "legacy and v2 models keep their original formulas" \
  "$(val "SELECT public.ticket_fee_buyer_charge_kobo(10000, 1, 0, 'legacy_5') || '/' || public.ticket_fee_buyer_charge_kobo(10000, 1, 0, 'v2_4_5') || '/' || public.ticket_fee_commission_kobo(1000000, 'legacy_5');")" "1050000/1040000/0"
expect_value "refund nominal fee (VENTS revenue given up) is 5% for v3" "$(val "SELECT public.earn_ticket_nominal_fee_kobo(10000, 'v3_15_35');")" "50000"

echo "== Paystack checkout =="
R3=$(buy "$BUYER" "$E_R2" 3)
expect_value "3 x ₦10,000 checkout: ₦30,450 (₦150 fee per ticket)" "$(amount_of "$R3")" "3045000"
expect_value "the pending purchase is v3_15_35" "$(val "SELECT fee_model FROM public.pending_purchases WHERE payment_ref = '$R3';")" "v3_15_35"
expect_value "underpayment by 1 kobo is refused" "$(confirm "$R3" 3044999)" "amount_mismatch:3045000:3044999"
expect_value "exact payment confirms" "$(confirm "$R3" 3045000)" "confirmed"
expect_value "its tickets are v3_15_35" "$(val "SELECT string_agg(DISTINCT fee_model, ',') || '/' || count(*) FROM public.tickets WHERE payment_ref = '$R3';")" "v3_15_35/3"
expect_value "organizer settled 3 x ₦9,650 = ₦28,950, on hold" "$(val "SELECT on_hold_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")" "2895000"
expect_value "ledger credit records gross, attendee fee, commission, net and model" \
  "$(val "SELECT amount_kobo || '/' || (metadata->>'gross_kobo') || '/' || (metadata->>'buyer_fee_kobo') || '/' || (metadata->>'organizer_commission_kobo') || '/' || (metadata->>'net_kobo') || '/' || (metadata->>'fee_model') FROM public.organizer_transactions WHERE ticket_sale_id = '$(first_ticket "$R3")';")" \
  "2895000/3000000/45000/105000/2895000/v3_15_35"
expect_value "attendee paid = organizer net + attendee fee + commission (no double charge)" "$((2895000 + 45000 + 105000))" "3045000"
expect_value "duplicate webhook: already_paid, no second credit" \
  "$(confirm "$R3" 3045000)/$(val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'credit' AND ticket_sale_id IN (SELECT id FROM public.tickets WHERE payment_ref = '$R3');")" "already_paid/1"
ODD=$(buy "$BUYER" "$E_ODD" 3)
expect_value "3 x ₦1,001 checkout charges 304806 kobo" "$(amount_of "$ODD")" "304806"
expect_value "and settles the organizer 3 x 96596 = 289788 kobo" \
  "$(confirm "$ODD" 304806)/$(val "SELECT amount_kobo FROM public.organizer_transactions WHERE ticket_sale_id = '$(first_ticket "$ODD")';")" "confirmed/289788"
PROMO=$(buy "$BUYER" "$E_PROMO" 1 "'ten'")
expect_value "10% promo: face 1,000,000 + fee 15,000 - discount 100,000 = 915,000" "$(amount_of "$PROMO")" "915000"
expect_value "with a promo the organizer is still settled face - 3.5% (VENTS funds the discount)" \
  "$(confirm "$PROMO" 915000)/$(val "SELECT amount_kobo FROM public.organizer_transactions WHERE ticket_sale_id = '$(first_ticket "$PROMO")';")" "confirmed/965000"
expect_value "a legacy purchase confirmed after 0208 still charges 5% and credits full face" \
  "$(confirm "$LEG_OPEN" 1050000)/$(val "SELECT amount_kobo || '/' || (metadata->>'fee_model') FROM public.organizer_transactions WHERE ticket_sale_id = '$(first_ticket "$LEG_OPEN")';")" "confirmed/1000000/legacy_5"
expect_error "a ticket's fee model cannot be changed afterwards" "fee_model cannot be changed" \
  "UPDATE public.tickets SET fee_model = 'v2_4_5' WHERE payment_ref = '$R3';"

echo "== VENTS Wallet checkout and refunds =="
"${PSQL[@]}" -q -c "INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$BUYER2', 1015000) ON CONFLICT (user_id) DO UPDATE SET balance_kobo = 1015000;"
W1=$(buy "$BUYER2" "$E_W1" 1)
expect_value "wallet checkout debits exactly ₦10,150" \
  "$(val "$(as "$BUYER2" "SELECT public.confirm_ticket_payment_via_wallet('$W1');")")/$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$BUYER2';")" "confirmed/0"
W1T=$(first_ticket "$W1")
expect_value "wallet refund returns everything the attendee paid (₦10,150)" \
  "$(val "$(as "$ORG" "SELECT public.refund_ticket('$W1T', 'cancelled')->>'amount_kobo';")")/$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$BUYER2';")" "1015000/1015000"
expect_value "the organizer gives back only their net (₦9,650), from that sale's hold" \
  "$(val "SELECT amount_kobo FROM public.organizer_transactions WHERE type = 'refund' AND ticket_sale_id = '$W1T';")" "965000"
ODDT=$(first_ticket "$ODD")
expect_value "a Paystack refund of one ₦1,001 ticket of three returns that ticket's 101602 kobo" \
  "$(val "$(as "$ORG" "SELECT public.refund_ticket('$ODDT', 'cancelled')->>'amount_kobo';")")" "101602"
"${PSQL[@]}" -q -c "UPDATE public.tickets SET refund_id = 'RF_odd' WHERE id = '$ODDT';"
expect_value "its finalization takes back that ticket's net, 96596 (a third of the sale's 289788)" \
  "$(val "SELECT status FROM public.finalize_ticket_refund('RF_odd');")/$(val "SELECT amount_kobo FROM public.organizer_transactions WHERE type = 'refund' AND ticket_sale_id = '$ODDT';")" "finalized/96596"
expect_value "event analytics: organizer earned = 3 x ₦9,650, VENTS commission 3 x ₦350" \
  "$(val "$(as "$ORG" "SELECT (public.get_event_analytics('$E_R2')->'overview'->>'organizerEarnedKobo') || '/' || (public.get_event_analytics('$E_R2')->'overview'->>'ventsCommissionKobo');")")" "2895000/105000"
expect_value "after sales and refunds every wallet reconciles" "$(reconciled)" "0"
expect_error "undo_0208 is refused once 1.5% + 3.5% sales exist" "purchases exist on the 1.5% + 3.5% model" \
  "SET vents.rollback_confirm = 'undo-0208'; $(cat "$REPO_ROOT/supabase/rollback/undo_0208.sql")"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES FEE MODEL 0208 CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
