#!/usr/bin/env bash
# Real-execution verification of migration 0203 (approved earnings policies):
#
#   rule 5  tickets: buyer pays face + 4%, organizer is settled face - 5%;
#           rows from before 0203 keep the legacy 5% buyer-fee arithmetic;
#   rule 2  organizer / provider earnings are held 7 days, then released
#           (idempotently, under concurrency);
#   rule 1  a refund the wallet cannot cover becomes a recorded receivable,
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
DB_NAME="vents_local_pg_earnings_policy"
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
mature() { "${PSQL[@]}" -q -c "UPDATE public.earnings_holds SET release_at = now() - interval '1 second' WHERE source_key = '$1';"; }
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
"${PSQL[@]}" -q -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.confirm_ticket_payment_via_wallet(text),
  public.refund_ticket(uuid,text), public.cancel_service_booking(uuid,text), public.get_event_analytics(uuid),
  public.admin_claim_payout_for_processing(uuid) TO authenticated;
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test'), ('$ORG_ADMIN', 'admin', true, 'Org Admin', 'oa@example.test'),
  ('$PROV', 'user', false, 'Provider', 'p@example.test'),
  ('$BUYER', 'user', false, 'Buyer', 'b@example.test'), ('$BUYER2', 'user', false, 'Buyer Two', 'b2@example.test'),
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test'), ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test'),
  ('$SUB', 'sub-admin', false, 'Sub', 's@example.test');
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EVENT', '$ORG', 'Concert', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$EVENT2', '$ORG_ADMIN', 'Admin gig', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 5000}]');
INSERT INTO public.promo_codes (code, discount_percentage) VALUES ('TEN', 10);
INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active) VALUES
  ('$BANK', '$ORG', 'Bank', '000', '0000000001', 'ORG', 'RCP_org', true),
  ('$BANK_OA', '$ORG_ADMIN', 'Bank', '000', '0000000002', 'ORG ADMIN', 'RCP_oa', true);
INSERT INTO public.service_providers (id, user_id) VALUES ('$SP_ID', '$PROV');
SQL

echo "== Before 0203: legacy rows (5% buyer fee, organizer gets face) =="
LEG_PAID=$(buy "$BUYER" "$EVENT" 1)
expect_value "legacy checkout charges face + 5% (₦10,000 -> ₦10,500)" "$(amount_of "$LEG_PAID")" "1050000"
expect_value "legacy sale confirmed" "$(confirm "$LEG_PAID" 1050000)" "confirmed"
expect_value "legacy sale credited the full face value, available at once" "$(val "SELECT balance_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG';")" "1000000"
LEG_OPEN=$(buy "$BUYER2" "$EVENT" 1)
"${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$LEG_OPEN');" >/dev/null   # tickets exist, unpaid, when 0203 lands

echo "== Applying 0203 =="
expect_ok "0203 applies on top of 0201, 0202 and the live functions" "$(cat "$MIG/0203_earnings_policies.sql")"
expect_ok "0203 is idempotent (second run is a no-op)" "$(cat "$MIG/0203_earnings_policies.sql")"
expect_value "every patched live function carries the 0203 marker" \
  "$(val "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%[0203]%';")" "14"
expect_value "no live ticket function still hard-codes the 1.05 multiplier" \
  "$(val "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%1.05%' AND proname <> 'ticket_fee_buyer_multiplier';")" "0"
expect_value "existing tickets and pending purchases are labelled legacy_5, amounts untouched" \
  "$(val "SELECT string_agg(DISTINCT fee_model, ',') || '/' || (SELECT string_agg(DISTINCT fee_model, ',') FROM public.pending_purchases) || '/' || (SELECT sum(amount_kobo) FROM public.pending_purchases) FROM public.tickets;")" \
  "legacy_5/legacy_5/2100000"
expect_value "the pre-0203 balance stays available (no retroactive hold)" "$(wallet "$ORG")" "1000000/0/0"
expect_value "starting point reconciles" "$(reconciled)" "0"

echo "== Drift guard =="
DRIFT_SQL=$(python3 - "$MIG/0203_earnings_policies.sql" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.index('CREATE OR REPLACE FUNCTION pg_temp.vents_0203_patch')
j = s.index('$f$;', i) + 4
print(s[i:j])
print("SELECT pg_temp.vents_0203_patch('public.refund_ticket(uuid,text)', 'ffffffffffffffffffffffffffffffff', ARRAY['x','y']);")
PY
)
"${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.drift_probe() RETURNS int LANGUAGE sql AS \$\$ SELECT 1 \$\$;" >/dev/null
expect_error "a drifted live function is refused, not patched" "differs from the definition" \
  "$(printf '%s\n' "$DRIFT_SQL" | sed "s/public.refund_ticket(uuid,text)/public.drift_probe()/")"

echo "== Rule 5: 4% attendee fee + 5% organizer commission =="
R2=$(buy "$BUYER2" "$EVENT" 2)
expect_value "checkout charges face + 4% (2 x ₦10,000 -> ₦20,800)" "$(amount_of "$R2")" "2080000"
expect_value "the new pending purchase is v2_4_5" "$(val "SELECT fee_model FROM public.pending_purchases WHERE payment_ref = '$R2';")" "v2_4_5"
expect_value "underpayment by 1 kobo is refused" "$(confirm "$R2" 2079999)" "amount_mismatch:2080000:2079999"
expect_value "exact payment confirms" "$(confirm "$R2" 2080000)" "confirmed"
expect_value "tickets bought through it are v2_4_5 (from the purchase, not the caller)" \
  "$(val "SELECT string_agg(DISTINCT fee_model, ',') || '/' || count(*) FROM public.tickets WHERE payment_ref = '$R2';")" "v2_4_5/2"
expect_value "organizer settled face - 5% = ₦19,000, on hold" "$(wallet "$ORG")" "1000000/0/1900000"
expect_value "ledger credit records gross, buyer fee, commission, net and model" \
  "$(val "SELECT amount_kobo || '/' || (metadata->>'gross_kobo') || '/' || (metadata->>'buyer_fee_kobo') || '/' || (metadata->>'organizer_commission_kobo') || '/' || (metadata->>'net_kobo') || '/' || (metadata->>'fee_model') FROM public.organizer_transactions WHERE ticket_sale_id = '$(first_ticket "$R2")';")" \
  "1900000/2000000/80000/100000/1900000/v2_4_5"
expect_value "buyer paid = organizer net + VENTS fee + VENTS commission (no double charge)" "$((1900000 + 80000 + 100000))" "2080000"
expect_value "duplicate webhook: already_paid, no second credit, no second hold" \
  "$(confirm "$R2" 2080000)/$(val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'credit' AND organizer_id = '$ORG';")/$(val "SELECT count(*) FROM public.earnings_holds WHERE source_key = '$R2';")" "already_paid/2/1"
expect_value "the hold releases 7 days after confirmation" \
  "$(val "SELECT (release_at - created_at = interval '7 days')::text FROM public.earnings_holds WHERE source_key = '$R2';")" "true"
expect_value "a legacy purchase confirmed after 0203 still charges 5%" "$(confirm "$LEG_OPEN" 1040000)" "amount_mismatch:1050000:1040000"
expect_value "and credits the full face (no commission on legacy), on hold" \
  "$(confirm "$LEG_OPEN" 1050000)/$(val "SELECT amount_kobo || '/' || (metadata->>'organizer_commission_kobo') || '/' || (metadata->>'fee_model') FROM public.organizer_transactions WHERE ticket_sale_id = '$(first_ticket "$LEG_OPEN")';")" \
  "confirmed/1000000/0/legacy_5"
PROMO=$(buy "$BUYER" "$EVENT" 1 "'ten'")
expect_value "a 10% promo discounts the face value, fee rate unchanged (₦10,000 x (1.04 - 0.10))" "$(amount_of "$PROMO")" "940000"
expect_value "with a promo the organizer is still settled face - 5% (VENTS funds the discount)" \
  "$(confirm "$PROMO" 940000)/$(val "SELECT amount_kobo FROM public.organizer_transactions WHERE ticket_sale_id = '$(first_ticket "$PROMO")';")" "confirmed/950000"
expect_error "a ticket's fee model cannot be changed afterwards" "fee_model cannot be changed" \
  "UPDATE public.tickets SET fee_model = 'legacy_5' WHERE payment_ref = '$R2';"
expect_value "a ticket inserted with a chosen fee model is forced to the purchase's model" \
  "$(val "WITH i AS (INSERT INTO public.tickets (event_id, amount, payment_status, fee_model, payment_ref) VALUES ('$EVENT', 1, 'pending', 'legacy_5', '$R2') RETURNING fee_model) SELECT fee_model FROM i;")" "v2_4_5"
"${PSQL[@]}" -q -c "DELETE FROM public.tickets WHERE amount = 1 AND payment_ref = '$R2';"
expect_value "a 30-minute-old legacy pending purchase is not reused for a new v2 checkout" \
  "$( [ "$(buy "$BUYER2" "$EVENT" 1)" != "$LEG_OPEN" ] && echo new )" "new"

echo "== Rule 5: VENTS Wallet checkout and refunds =="
"${PSQL[@]}" -q -c "INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$BUYER', 1040000);"
W1=$(buy "$BUYER" "$EVENT" 1)
expect_value "wallet checkout debits face + 4% exactly" \
  "$(val "$(as "$BUYER" "SELECT public.confirm_ticket_payment_via_wallet('$W1');")")/$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$BUYER';")" "confirmed/0"
W1T=$(first_ticket "$W1")
expect_value "wallet refund returns everything the buyer paid (face + 4%)" \
  "$(val "$(as "$ORG" "SELECT public.refund_ticket('$W1T', 'cancelled')->>'amount_kobo';")")/$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$BUYER';")" "1040000/1040000"
expect_value "the organizer gives back only their net (face - 5%), from that sale's hold" \
  "$(hold_of "$W1")/$(val "SELECT amount_kobo || '/' || (metadata->>'from_hold_kobo') FROM public.organizer_transactions WHERE type = 'refund' AND ticket_sale_id = '$W1T';")" "0/950000/0/950000/950000"
expect_value "after sales and a refund every wallet reconciles" "$(reconciled)" "0"
LEG_T=$(first_ticket "$LEG_PAID")
expect_value "a legacy Paystack refund still returns face + 5%" \
  "$(val "$(as "$ORG" "SELECT public.refund_ticket('$LEG_T', 'cancelled')->>'amount_kobo';")")" "1050000"
"${PSQL[@]}" -q -c "UPDATE public.tickets SET refund_id = 'RF_leg' WHERE id = '$LEG_T';"
expect_value "its finalization debits the legacy owed amount (full face) from the available balance" \
  "$(val "SELECT status FROM public.finalize_ticket_refund('RF_leg');")/$(wallet "$ORG")" "finalized/0/0/3850000"
expect_value "duplicate refund webhook does nothing" "$(val "SELECT status FROM public.finalize_ticket_refund('RF_leg');")/$(wallet "$ORG")" "already_refunded/0/0/3850000"
expect_value "event analytics: organizer earned = gross - commission (₦40,000 gross; 3 v2 tickets x ₦500)" \
  "$(val "$(as "$ORG" "SELECT (public.get_event_analytics('$EVENT')->'overview'->>'organizerEarnedKobo') || '/' || (public.get_event_analytics('$EVENT')->'overview'->>'ventsCommissionKobo');")")" "3850000/150000"

echo "== Rule 2: 7-day settlement hold =="
expect_error "held earnings cannot be withdrawn" "Insufficient balance" \
  "$(as "$ORG" "SELECT public.request_organizer_payout(1, '$BANK', 'early');")"
expect_value "settling before maturity releases nothing" "$(settle "$ORG")" '{"released_kobo": 0, "recovered_kobo": 0}'
mature "$R2"
expect_value "a matured hold is released once" "$(settle "$ORG")/$(settle "$ORG")" \
  '{"released_kobo": 1900000, "recovered_kobo": 0}/{"released_kobo": 0, "recovered_kobo": 0}'
expect_value "released earnings are available" "$(wallet "$ORG")/$(hold_of "$R2")" "1900000/0/1950000/0/0/1900000"
mature "$LEG_OPEN"
# Two concurrent settlements of the same wallet: the row lock serializes
# them and the second finds nothing to release.
( "${PSQL[@]}" -tA -c "BEGIN; SET LOCAL test.uid='$ORG'; SELECT public.settle_my_earnings(); SELECT pg_sleep(1); COMMIT;" >"$TMP/c1" 2>&1 & )
sleep 0.3
"${PSQL[@]}" -tA -c "SET test.uid='$ORG'; SELECT public.settle_my_earnings();" >"$TMP/c2" 2>&1; sleep 1
expect_value "concurrent settlements release a hold exactly once" \
  "$(grep -c '"released_kobo": 1000000' "$TMP/c1" "$TMP/c2" | awk -F: '{s+=$2} END {print s}')/$(wallet "$ORG")" "1/2900000/0/950000"
mature "$PROMO"
expect_value "the cron release settles every matured wallet (server only)" \
  "$(val "SELECT public.release_matured_earnings()->>'released_kobo';")/$(wallet "$ORG")" "950000/3850000/0/0"
expect_error "a client cannot call the cron release" "permission denied" "$(as "$ORG" "SELECT public.release_matured_earnings();")"
expect_error "a client cannot settle someone else's wallet" "permission denied" "$(as "$BUYER" "SELECT public.settle_earnings('$ORG');")"
expect_error "a client cannot write holds" "permission denied" "$(as "$ORG" "UPDATE public.earnings_holds SET release_at = now();")"
expect_value "an organizer sees only their own holds" "$(val "$(as "$BUYER" "SELECT count(*) FROM public.earnings_holds;")")" "0"
expect_value "after release every wallet reconciles" "$(reconciled)" "0"

echo "== Rule 1: refund shortfall recovered from future earnings =="
WD=$(val "$(as "$ORG" "SELECT public.request_organizer_payout(3850000, '$BANK', 'all');")")
expect_value "the organizer withdraws everything" "$(wallet "$ORG")" "0/3850000/0"
R2T=$(first_ticket "$R2")
"${PSQL[@]}" -q -c "$(as "$ORG" "SELECT public.refund_ticket('$R2T', 'event changed');")" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.tickets SET refund_id = 'RF_short' WHERE id = '$R2T';"
expect_value "the refund still finalizes (the buyer is refunded in full by Paystack)" "$(val "SELECT status FROM public.finalize_ticket_refund('RF_short');")" "finalized"
expect_value "nothing was debited; the wallet is not negative" "$(wallet "$ORG")" "0/3850000/0"
expect_value "the shortfall is a recorded receivable for the organizer's net (₦9,500)" \
  "$(val "SELECT source_kind || '/' || amount_kobo || '/' || recovered_kobo || '/' || (settled_at IS NULL)::text FROM public.earnings_recoveries WHERE source_key = '$R2T';")" "ticket_refund/950000/0/true"
expect_value "the admin log links the shortfall to its recovery" \
  "$(val "SELECT (details->>'shortfall_kobo') || '/' || (details->>'recovery_id' = (SELECT id::text FROM public.earnings_recoveries WHERE source_key = '$R2T'))::text FROM public.admin_logs WHERE action = 'refund_wallet_shortfall' AND details->>'ticket_id' = '$R2T';")" "950000/true"
expect_value "the receivable is reported (not a ledger gap)" \
  "$(reconciled)/$(val "$(as "$ADMIN_A" "SELECT outstanding_recovery_kobo FROM public.admin_earnings_reconciliation() WHERE organizer_id = '$ORG';")")" "0/950000"
S2=$(buy "$BUYER" "$EVENT" 1)
confirm "$S2" 1040000 >/dev/null
expect_value "new earnings are held; the debt is not taken from a hold early" "$(wallet "$ORG")" "0/3850000/950000"
mature "$S2"
expect_value "on release the receivable is deducted first, in full" \
  "$(settle "$ORG")/$(wallet "$ORG")/$(val "SELECT recovered_kobo || '/' || (settled_at IS NOT NULL)::text FROM public.earnings_recoveries WHERE source_key = '$R2T';")" \
  '{"released_kobo": 950000, "recovered_kobo": 950000}/0/3850000/0/950000/true'
expect_value "each deduction is a 'recovery_deduction' ledger row" \
  "$(val "SELECT count(*) || '/' || sum(amount_kobo) FROM public.organizer_transactions WHERE type = 'recovery_deduction' AND organizer_id = '$ORG';")" "1/950000"
expect_value "after recovery every wallet reconciles" "$(reconciled)" "0"

echo "== Rule 1: service bookings =="
"${PSQL[@]}" -q -c "INSERT INTO public.service_bookings (id, customer_id, provider_id, payment_status, payment_method, payment_ref, subtotal_kobo, fee_kobo, total_kobo) VALUES
  ('00000000-0000-0000-0000-0000000003f2', '$BUYER', '$SP_ID', 'paid', 'wallet', 'BK1', 500000, 25000, 525000);"
"${PSQL[@]}" -q -o /dev/null -c "SELECT public.credit_provider_wallet_for_booking('$PROV', 500000, '00000000-0000-0000-0000-0000000003f2', 'Service booking payment');"
expect_value "a booking credit is held too" "$(wallet "$PROV")" "0/0/500000"
expect_value "provider cancels: the customer gets the total back, the provider's hold covers the subtotal" \
  "$(val "$(as "$PROV" "SELECT public.cancel_service_booking('00000000-0000-0000-0000-0000000003f2', 'sick')->>'status';")")/$(wallet "$PROV")/$(val "SELECT count(*) FROM public.earnings_recoveries WHERE owner_id = '$PROV';")" "refunded/0/0/0/0"
"${PSQL[@]}" -q -c "INSERT INTO public.service_bookings (id, customer_id, provider_id, payment_status, payment_method, payment_ref, subtotal_kobo, fee_kobo, total_kobo, refund_id) VALUES
  ('00000000-0000-0000-0000-0000000003f3', '$BUYER', '$SP_ID', 'refund_pending', 'paystack', 'BK2', 300000, 15000, 315000, 'RF_bk2');"
expect_value "a booking refund with nothing to debit becomes a receivable" \
  "$(val "SELECT status FROM public.finalize_service_booking_refund('RF_bk2');")/$(val "SELECT source_kind || '/' || amount_kobo FROM public.earnings_recoveries WHERE owner_id = '$PROV';")" "finalized/service_booking_refund/300000"
"${PSQL[@]}" -q -c "INSERT INTO public.service_bookings (id, customer_id, provider_id, payment_status, payment_method, payment_ref, subtotal_kobo, fee_kobo, total_kobo) VALUES
  ('00000000-0000-0000-0000-0000000003f4', '$BUYER', '$SP_ID', 'paid', 'paystack', 'BK3', 200000, 10000, 210000);"
"${PSQL[@]}" -q -o /dev/null -c "SELECT public.credit_provider_wallet_for_booking('$PROV', 200000, '00000000-0000-0000-0000-0000000003f4', 'Service booking payment');"
mature "00000000-0000-0000-0000-0000000003f4"
expect_value "a smaller release recovers part of the receivable; the rest stays outstanding" \
  "$(settle "$PROV")/$(wallet "$PROV")/$(val "SELECT recovered_kobo || '/' || (settled_at IS NULL)::text FROM public.earnings_recoveries WHERE owner_id = '$PROV';")" \
  '{"released_kobo": 200000, "recovered_kobo": 200000}/0/0/0/200000/true'
expect_value "bookings reconcile" "$(reconciled)" "0"

echo "== Rule 3: two-admin withdrawal authorization =="
expect_error "an unauthorized withdrawal cannot be claimed for Paystack" "needs a second admin" \
  "$(as "$ADMIN_A" "SELECT * FROM public.admin_claim_payout_for_processing('$WD');")"
AR=$(request_admin "$ADMIN_A" authorize_withdrawal "$WD" "{\"request_id\":\"$WD\",\"amount_kobo\":3850000}")
expect_error "the requesting admin cannot approve it" "Cannot approve your own request" "$(approve "$ADMIN_A" "$AR")"
expect_error "a sub-admin cannot approve it" "Super Admin access required" "$(approve "$SUB" "$AR")"
BAD=$(request_admin "$ADMIN_A" authorize_withdrawal "$WD" "{\"request_id\":\"$WD\",\"amount_kobo\":100}")
expect_error "an approval for a different amount than requested is refused" "does not match the request" "$(approve "$ADMIN_B" "$BAD")"
BAD=$(request_admin "$ADMIN_A" authorize_withdrawal "$WD" "{\"request_id\":\"$WD\"}")
expect_error "an approval without the reviewed amount is refused" "amount_kobo" "$(approve "$ADMIN_B" "$BAD")"
expect_error "nobody can write the authorization columns directly" "permission denied" \
  "$(as "$ADMIN_B" "UPDATE public.organizer_withdrawal_requests SET approved_by = '$ADMIN_B' WHERE id = '$WD';")"
expect_error "the executor is not callable directly" "permission denied" \
  "$(as "$ADMIN_B" "SELECT public.execute_withdrawal_authorization('$AR');")"
expect_ok "a second, different admin approves it" "$(approve "$ADMIN_B" "$AR")"
expect_value "the request records both admins and the authorized recipient" \
  "$(val "SELECT (approval_requested_by = '$ADMIN_A')::text || '/' || (approved_by = '$ADMIN_B')::text || '/' || approved_recipient_code FROM public.organizer_withdrawal_requests WHERE id = '$WD';")" "true/true/RCP_org"
AR2=$(request_admin "$ADMIN_B" authorize_withdrawal "$WD" "{\"request_id\":\"$WD\",\"amount_kobo\":3850000}")
expect_error "it cannot be authorized twice" "already authorized" "$(approve "$ADMIN_A" "$AR2")"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_attacker' WHERE id = '$BANK';"
expect_error "a bank recipient changed after authorization blocks the payout" "bank account changed" \
  "$(as "$ADMIN_A" "SELECT * FROM public.admin_claim_payout_for_processing('$WD');")"
"${PSQL[@]}" -q -c "UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_org' WHERE id = '$BANK';"
expect_value "the authorized request is claimed exactly once" "$(claim "$WD")/$(claim "$WD")" "true/false"
expect_value "Paystack success completes it" "$(val "SELECT status FROM public.complete_organizer_payout('$WD');")/$(wallet "$ORG")" "completed/0/0/0"
expect_value "duplicate success webhook does nothing" "$(val "SELECT status FROM public.complete_organizer_payout('$WD');")" "already_completed"
expect_value "a reversal returns it to the available balance" "$(val "SELECT status FROM public.reverse_organizer_payout('$WD', 'bank reversed');")/$(wallet "$ORG")" "reversed/3850000/0/0"

# An admin who is also an organizer.
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_wallets (organizer_id, balance_kobo) VALUES ('$ORG_ADMIN', 400000); INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG_ADMIN', 'credit', 400000, 'old sales');"
WOA=$(val "$(as "$ORG_ADMIN" "SELECT public.request_organizer_payout(400000, '$BANK_OA', 'oa');")")
expect_error "an admin cannot approve their own withdrawal" "own withdrawal" \
  "$(approve "$ORG_ADMIN" "$(request_admin "$ADMIN_A" authorize_withdrawal "$WOA" "{\"request_id\":\"$WOA\",\"amount_kobo\":400000}")")"
expect_error "an admin cannot request authorization of their own withdrawal" "own withdrawal" \
  "$(approve "$ADMIN_A" "$(request_admin "$ORG_ADMIN" authorize_withdrawal "$WOA" "{\"request_id\":\"$WOA\",\"amount_kobo\":400000}")")"
"${PSQL[@]}" -q -c "$(approve "$ADMIN_B" "$(request_admin "$ADMIN_A" authorize_withdrawal "$WOA" "{\"request_id\":\"$WOA\",\"amount_kobo\":400000}")")" >/dev/null
expect_error "and cannot claim it for Paystack themselves" "cannot pay out their own" \
  "$(as "$ORG_ADMIN" "SELECT * FROM public.admin_claim_payout_for_processing('$WOA');")"
expect_value "a failed transfer returns the money once" \
  "$(claim "$WOA")/$(val "SELECT status FROM public.fail_organizer_payout('$WOA', 'bank down');")/$(val "SELECT status FROM public.fail_organizer_payout('$WOA', 'bank down');")/$(wallet "$ORG_ADMIN")" "true/failed/already_finalized/400000/0/0"

echo "== Rule 1: a payout paid after a legacy cancel =="
WL=$(val "$(as "$ORG_ADMIN" "SELECT public.request_organizer_payout(400000, '$BANK_OA', 'legacy');")")
"${PSQL[@]}" -q -c "UPDATE public.organizer_withdrawal_requests SET status = 'cancelled' WHERE id = '$WL'; UPDATE public.organizer_wallets SET balance_kobo = balance_kobo + 400000, pending_kobo = pending_kobo - 400000 WHERE organizer_id = '$ORG_ADMIN';"
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET balance_kobo = 100000 WHERE organizer_id = '$ORG_ADMIN'; INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description) VALUES ('$ORG_ADMIN', 'debit', 300000, 'spent elsewhere (test)');"
expect_value "the transfer that went out anyway takes what is there and records the rest as a receivable" \
  "$(val "SELECT status FROM public.complete_organizer_payout('$WL');")/$(wallet "$ORG_ADMIN")/$(val "SELECT source_kind || '/' || amount_kobo FROM public.earnings_recoveries WHERE source_key = '$WL';")" \
  "completed/0/0/0/payout_after_cancel/300000"

echo "== Concurrency: two withdrawals for the same money =="
"${PSQL[@]}" -q -c "UPDATE public.app_config SET disable_payouts = false;"
( "${PSQL[@]}" -tA -c "BEGIN; SET LOCAL test.uid='$ORG'; SET LOCAL ROLE authenticated; SELECT public.request_organizer_payout(3850000, '$BANK', 'race1'); SELECT pg_sleep(1); COMMIT;" >"$TMP/w1" 2>&1 & )
sleep 0.3
"${PSQL[@]}" -tA -c "SET test.uid='$ORG'; SET ROLE authenticated; SELECT public.request_organizer_payout(3850000, '$BANK', 'race2');" >"$TMP/w2" 2>&1 || true; sleep 1
expect_value "only one of two concurrent withdrawals of the full balance succeeds" \
  "$(grep -c 'Insufficient balance' "$TMP/w1" "$TMP/w2" | awk -F: '{s+=$2} END {print s}')/$(wallet "$ORG")" "1/0/3850000/0"
expect_value "final state: every wallet reconciles" "$(reconciled)" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES EARNINGS POLICY CHECKS PASSED"; else echo "$FAILS FAILED, $PASSES passed"; exit 1; fi
