#!/usr/bin/env bash
# Real-execution verification of migration 0203 (approved earnings policies):
#
#   rule 5  tickets: buyer pays face + 4%, organizer is settled face - 5%;
#           rows from before 0203 keep the legacy 5% buyer-fee arithmetic;
#   rule 2  ticket earnings become withdrawable exactly 48 hours after the
#           event ends, provider earnings 48 hours after the booking is
#           completed; pending refunds, deleted/hidden events, cancelled
#           bookings, admin holds and Paystack disputes block the release;
#           release is idempotent, concurrent-safe and timezone-safe;
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
E_R2="00000000-0000-0000-0000-0000000003e3"
E_PROMO="00000000-0000-0000-0000-0000000003e4"
E_W1="00000000-0000-0000-0000-0000000003e5"
E_S2="00000000-0000-0000-0000-0000000003e6"
E_B1="00000000-0000-0000-0000-0000000003e7"
E_B2="00000000-0000-0000-0000-0000000003e8"
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
"${PSQL[@]}" -q -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
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
R2=$(buy "$BUYER2" "$E_R2" 2)
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
expect_value "the hold waits for the event: with no end_date the end is event_date + 24h (event_effective_end_at), release 48h later" \
  "$(val "SELECT ((public.earnings_hold_state(id)->>'release_at')::timestamptz - (SELECT event_date FROM public.events WHERE id = '$E_R2') = interval '72 hours')::text FROM public.earnings_holds WHERE source_key = '$R2';")" "true"
expect_value "a legacy purchase confirmed after 0203 still charges 5%" "$(confirm "$LEG_OPEN" 1040000)" "amount_mismatch:1050000:1040000"
expect_value "and credits the full face (no commission on legacy), on hold" \
  "$(confirm "$LEG_OPEN" 1050000)/$(val "SELECT amount_kobo || '/' || (metadata->>'organizer_commission_kobo') || '/' || (metadata->>'fee_model') FROM public.organizer_transactions WHERE ticket_sale_id = '$(first_ticket "$LEG_OPEN")';")" \
  "confirmed/1000000/0/legacy_5"
PROMO=$(buy "$BUYER" "$E_PROMO" 1 "'ten'")
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
W1=$(buy "$BUYER" "$E_W1" 1)
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
expect_value "event analytics: organizer earned = gross - commission (₦20,000 gross, 2 x ₦500)" \
  "$(val "$(as "$ORG" "SELECT (public.get_event_analytics('$E_R2')->'overview'->>'organizerEarnedKobo') || '/' || (public.get_event_analytics('$E_R2')->'overview'->>'ventsCommissionKobo');")")" "1900000/100000"

echo "== Rule 2: release 48 hours after the event ends =="
expect_error "held earnings cannot be withdrawn" "Insufficient balance" \
  "$(as "$ORG" "SELECT public.request_organizer_payout(1, '$BANK', 'early');")"
expect_value "settling before the event has ended releases nothing" "$(settle "$ORG")/$(blockers "$R2")" '{"released_kobo": 0, "recovered_kobo": 0}/not_yet'
end_event "$E_R2" "47 hours 59 minutes"
expect_value "47h59m after the end: still held" "$(settle "$ORG")/$(blockers "$R2")" '{"released_kobo": 0, "recovered_kobo": 0}/not_yet'
end_event "$E_R2"
expect_value "a matured hold is released once" "$(settle "$ORG")/$(settle "$ORG")" \
  '{"released_kobo": 1900000, "recovered_kobo": 0}/{"released_kobo": 0, "recovered_kobo": 0}'
expect_value "released earnings are available" "$(wallet "$ORG")/$(hold_of "$R2")" "1900000/0/1950000/0/0/1900000"
end_event "$EVENT"
# Two concurrent settlements of the same wallet: the row lock serializes
# them and the second finds nothing to release.
( "${PSQL[@]}" -tA -c "BEGIN; SET LOCAL test.uid='$ORG'; SELECT public.settle_my_earnings(); SELECT pg_sleep(1); COMMIT;" >"$TMP/c1" 2>&1 & )
sleep 0.3
"${PSQL[@]}" -tA -c "SET test.uid='$ORG'; SELECT public.settle_my_earnings();" >"$TMP/c2" 2>&1; sleep 1
expect_value "concurrent settlements release a hold exactly once" \
  "$(grep -c '"released_kobo": 1000000' "$TMP/c1" "$TMP/c2" | awk -F: '{s+=$2} END {print s}')/$(wallet "$ORG")" "1/2900000/0/950000"
end_event "$E_PROMO"
expect_value "the cron release settles every matured wallet (server only)" \
  "$(val "SELECT public.release_matured_earnings()->>'released_kobo';")/$(wallet "$ORG")" "950000/3850000/0/0"
expect_error "a client cannot call the cron release" "permission denied" "$(as "$ORG" "SELECT public.release_matured_earnings();")"
expect_error "a client cannot settle someone else's wallet" "permission denied" "$(as "$BUYER" "SELECT public.settle_earnings('$ORG');")"
expect_error "a client cannot write holds" "permission denied" "$(as "$ORG" "UPDATE public.earnings_holds SET admin_hold_at = NULL;")"
expect_value "an organizer sees only their own holds" "$(val "$(as "$BUYER" "SELECT count(*) FROM public.earnings_holds;")")" "0"
expect_value "after release every wallet reconciles" "$(reconciled)" "0"
expect_value "each release records the rule and times it used" \
  "$(val "SELECT (release_basis->>'rule') || '/' || (release_basis->'blockers')::text || '/' || ((release_basis->>'release_at')::timestamptz <= released_at)::text FROM public.earnings_holds WHERE source_key = '$R2';")" \
  'event_end_plus_48h/[]/true'

echo "== Rule 2: what blocks a release =="
B1=$(buy "$BUYER" "$E_B1" 1); confirm "$B1" 1040000 >/dev/null
B1X=$(buy "$BUYER2" "$E_B1" 1); confirm "$B1X" 1040000 >/dev/null
B2=$(buy "$BUYER" "$E_B2" 1); confirm "$B2" 1040000 >/dev/null
end_event "$E_B1"
"${PSQL[@]}" -q -c "$(as "$ORG3" "SELECT public.refund_ticket('$(first_ticket "$B1X")', 'duplicate order');")" >/dev/null
expect_value "a pending refund on the event blocks the release of its other sales" "$(blockers "$B1")/$(settle "$ORG3")" \
  'refund_pending/{"released_kobo": 0, "recovered_kobo": 0}'
"${PSQL[@]}" -q -c "UPDATE public.tickets SET refund_id = 'RF_b1x' WHERE id = '$(first_ticket "$B1X")';"
"${PSQL[@]}" -q -c "SELECT public.finalize_ticket_refund('RF_b1x');" >/dev/null
expect_value "once the refund completes, the sale releases" "$(blockers "$B1")/$(settle "$ORG3")" \
  '/{"released_kobo": 950000, "recovered_kobo": 0}'
end_event "$E_B2"
expect_value "after its end + 48h, a sale has no blockers" "$(blockers "$B2")" ""
"${PSQL[@]}" -q -c "UPDATE public.events SET end_date = now() + interval '1 day' WHERE id = '$E_B2';"
expect_value "postponing the event delays the release" "$(blockers "$B2")" "not_yet"
"${PSQL[@]}" -q -c "UPDATE public.events SET event_date = now() - interval '10 days', end_date = now() - interval '9 days' WHERE id = '$E_B2';
  UPDATE public.earnings_holds SET event_end_at_sale = now() + interval '1 hour' WHERE source_key = '$B2';"
expect_value "moving the event earlier than the end recorded at the sale does not hasten it" "$(blockers "$B2")" "not_yet"
end_event "$E_B2"
"${PSQL[@]}" -q -c "UPDATE public.events SET hidden_by_admin = true WHERE id = '$E_B2';"
expect_value "an event hidden by an admin blocks the release" "$(blockers "$B2")" "event_hidden_by_admin"
"${PSQL[@]}" -q -c "UPDATE public.events SET hidden_by_admin = false, deleted_at = now() WHERE id = '$E_B2';"
expect_value "a deleted event blocks the release" "$(blockers "$B2")" "event_deleted"
"${PSQL[@]}" -q -c "UPDATE public.events SET deleted_at = NULL WHERE id = '$E_B2';"
HB2=$(val "SELECT id FROM public.earnings_holds WHERE source_key = '$B2';")
expect_value "a Paystack dispute freezes the sale's held earnings (idempotent)" \
  "$(val "SELECT public.place_payment_dispute_hold('$B2', 'DSP_1');")/$(val "SELECT public.place_payment_dispute_hold('$B2', 'DSP_1');")/$(blockers "$B2")" "held/already_held/payment_dispute"
expect_value "the cron does not release disputed earnings" "$(val "SELECT public.release_matured_earnings()->>'released_kobo';")/$(wallet "$ORG3")" "0/950000/0/950000"
expect_error "a sub-admin cannot lift a hold" "Super Admin access required" "$(as "$SUB" "SELECT public.admin_set_earnings_hold('$HB2', false, 'x');")"
expect_error "a hold cannot be lifted without a reason" "A reason is required" "$(as "$ADMIN_B" "SELECT public.admin_set_earnings_hold('$HB2', false, ' ');")"
expect_error "the organizer cannot lift a hold on their own earnings" "Super Admin access required" "$(as "$ORG3" "SELECT public.admin_set_earnings_hold('$HB2', false, 'mine');")"
expect_ok "a super admin lifts it after review" "$(as "$ADMIN_B" "SELECT public.admin_set_earnings_hold('$HB2', false, 'Dispute resolved in our favour');")"
expect_value "the lift is audited with the dispute it cleared" \
  "$(val "SELECT (details->>'dispute_reference') || '/' || (admin_id = '$ADMIN_B')::text FROM public.admin_logs WHERE action = 'earnings_hold_lifted' AND details->>'hold_id' = '$HB2';")" "DSP_1/true"
expect_ok "any admin can place a hold" "$(as "$SUB" "SELECT public.admin_set_earnings_hold('$HB2', true, 'Attendee complaint under review');")"
expect_value "an admin hold blocks the release" "$(blockers "$B2")/$(settle "$ORG3")" 'admin_hold/{"released_kobo": 0, "recovered_kobo": 0}'
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_set_earnings_hold('$HB2', false, 'Complaint closed');")" >/dev/null
expect_value "lifted, the cron releases it" "$(val "SELECT public.release_matured_earnings()->>'released_kobo';")/$(wallet "$ORG3")" "950000/1900000/0/0"
expect_value "a dispute after release is logged for admins, not silently ignored" \
  "$(val "SELECT public.place_payment_dispute_hold('$B2', 'DSP_2');")/$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'payment_dispute_after_release';")" "already_released/1"
expect_value "the client listing shows release times and blockers, own wallet only" \
  "$(val "$(as "$ORG" "SELECT count(*) FROM public.get_earnings_holds();")")" "0"
expect_error "an organizer cannot list someone else's holds" "Not authorized" "$(as "$ORG" "SELECT * FROM public.get_earnings_holds('$ORG3');")"

expect_value "representative rewards keep their separate 7-day hold (0201), untouched by 0203" \
  "$(val "SELECT settlement_hold_days FROM public.earn_settings;")/$(val "SELECT (prosrc LIKE '%settlement_hold_days%')::text FROM pg_proc WHERE proname = 'earn_event_eligibility';")" "7/true"
echo "== Rule 2: timezone and DST safety =="
# 2026-11-01 01:30 EDT is 25 hours before a fall-back; '2 days' would be 49h there.
TZ_SQL="SET TimeZone = 'America/New_York'; SELECT extract(epoch FROM ('2026-10-31 02:00-04'::timestamptz + public.earnings_release_delay()) - '2026-10-31 02:00-04'::timestamptz)::int || '/' || extract(epoch FROM ('2026-10-31 02:00-04'::timestamptz + interval '2 days') - '2026-10-31 02:00-04'::timestamptz)::int;"
expect_value "the delay is exactly 172800 s across a DST change ('2 days' would not be)" "$(val "$TZ_SQL")" "172800/176400"
TZ_A=$(val "SET TimeZone = 'Africa/Lagos'; SELECT extract(epoch FROM (public.earnings_hold_state(id)->>'release_at')::timestamptz) FROM public.earnings_holds WHERE source_key = '$W1';")
TZ_B=$(val "SET TimeZone = 'Pacific/Auckland'; SELECT extract(epoch FROM (public.earnings_hold_state(id)->>'release_at')::timestamptz) FROM public.earnings_holds WHERE source_key = '$W1';")
expect_value "the release instant is identical whatever the session timezone (Lagos vs Auckland)" "$([ -n "$TZ_A" ] && [ "$TZ_A" = "$TZ_B" ] && echo same)" "same"

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
S2=$(buy "$BUYER" "$E_S2" 1)
confirm "$S2" 1040000 >/dev/null
expect_value "new earnings are held; the debt is not taken from a hold early" "$(wallet "$ORG")" "0/3850000/950000"
end_event "$E_S2"
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
expect_value "a paid booking is held until it is completed, however long it waits" \
  "$(blockers "00000000-0000-0000-0000-0000000003f4")" "not_completed"
expect_error "a provider cannot write the booking (no client UPDATE grant, as in production)" "permission denied" \
  "$(as "$PROV" "UPDATE public.service_bookings SET completed_at = now() - interval '9 days' WHERE id = '00000000-0000-0000-0000-0000000003f4';")"
expect_value "marking it complete stamps the time and who confirmed it" \
  "$(val "$(as "$PROV" "SELECT public.complete_service_booking('00000000-0000-0000-0000-0000000003f4')->>'status';")")/$(val "SELECT (completed_at > now() - interval '1 minute')::text || '/' || (completed_by = '$PROV')::text FROM public.service_bookings WHERE id = '00000000-0000-0000-0000-0000000003f4';")" "completed/true/true"
expect_value "the stamp cannot be moved by a later update (even by the owner of the table)" \
  "$(val "WITH u AS (UPDATE public.service_bookings SET completed_at = now() - interval '9 days', updated_at = now() WHERE id = '00000000-0000-0000-0000-0000000003f4' RETURNING (completed_at > now() - interval '1 minute')::text AS ok) SELECT ok FROM u;")" "true"
expect_value "release at exactly completion + 48 hours" \
  "$(val "SELECT ((public.earnings_hold_state(h.id)->>'release_at')::timestamptz - b.completed_at = interval '48 hours')::text || '/' || (public.earnings_hold_state(h.id)->>'rule') FROM public.earnings_holds h JOIN public.service_bookings b ON b.id = h.booking_id WHERE h.source_key = '00000000-0000-0000-0000-0000000003f4';")" "true/booking_completed_plus_48h"
complete_ago "00000000-0000-0000-0000-0000000003f4" "47 hours 59 minutes"
expect_value "47h59m after completion: still held" "$(blockers "00000000-0000-0000-0000-0000000003f4")" "not_yet"
complete_ago "00000000-0000-0000-0000-0000000003f4"
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
