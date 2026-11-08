#!/usr/bin/env bash
# Real-execution verification of migration 0209 (owner instruction 2026-11-08):
#   - each active VENTS Representative gets one server-generated organizer
#     referral code; suspended representatives and non-representatives get none;
#   - a user who registers through ?rep=CODE is attributed to that
#     representative once, through 0201's attribution (accepted partnership,
#     0% split, source referral_link), and the representative is notified;
#   - self-referral, a second or different referral, representative-to-
#     representative referral, an old account, invalid or suspended codes and
#     concurrent claims are all refused; clients cannot write codes,
#     partnerships or attributions;
#   - the dashboard history shows source, registration, verification and
#     reward status; free events never qualify for a reward;
#   - the Representative badge comes from the active status only.
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
DB_NAME="vents_local_pg_rep_referral"
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

REP="00000000-0000-0000-0000-0000000009a1"; REP_S="00000000-0000-0000-0000-0000000009a2"; REP_B="00000000-0000-0000-0000-0000000009a3"
NEWU="00000000-0000-0000-0000-0000000009b1"; NEWU2="00000000-0000-0000-0000-0000000009b2"; OLDU="00000000-0000-0000-0000-0000000009b3"
RACE="00000000-0000-0000-0000-0000000009b4"; FREE_EV="00000000-0000-0000-0000-0000000009e1"
"${PSQL[@]}" -q <<SQL
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
INSERT INTO public.users (id, role, is_organizer, full_name, email, created_at) VALUES
  ('$REP', 'user', false, 'Rep One', 'r1@example.test', now() - interval '90 days'),
  ('$REP_S', 'user', false, 'Rep Suspended', 'r2@example.test', now() - interval '90 days'),
  ('$REP_B', 'user', false, 'Rep Two', 'r3@example.test', now()),
  ('$NEWU', 'user', false, 'New Organizer', 'n1@example.test', now()),
  ('$NEWU2', 'user', false, 'Second New', 'n2@example.test', now()),
  ('$OLDU', 'user', true, 'Old Organizer', 'o1@example.test', now() - interval '4 days'),
  ('$RACE', 'user', false, 'Race User', 'rc@example.test', now());
INSERT INTO public.recruiters (id, display_name, status) VALUES ('$REP', 'Rep One', 'active'), ('$REP_S', 'Rep Suspended', 'active'), ('$REP_B', 'Rep Two', 'active');
SQL

echo "== Order =="
expect_error "0209 refuses before 0203" "0209 requires 0203" "$(cat "$MIG/0209_representative_referral_links.sql")"
for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment 0208_ticket_fee_1_5_3_5; do
  expect_ok "$m applies" "$(cat "$MIG/$m.sql")"
done
STATE_SQL="SELECT md5(string_agg(p.proname || ':' || p.prosrc, '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('organizer_referral_code','source') AND table_name IN ('recruiters','recruiter_partnerships')) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
PRE_0209=$(val "$STATE_SQL")
expect_ok "0209 applies on top of 0201-0208" "$(cat "$MIG/0209_representative_referral_links.sql")"
expect_ok "undo_0209 runs before any referral is made" "SET vents.rollback_confirm = 'undo-0209'; $(cat "$REPO_ROOT/supabase/rollback/undo_0209.sql")"
expect_value "undo_0209 restores every function and column exactly" "$(val "$STATE_SQL")" "$PRE_0209"
expect_ok "0209 re-applies after the undo" "$(cat "$MIG/0209_representative_referral_links.sql")"
expect_ok "0209 is idempotent (second run)" "$(cat "$MIG/0209_representative_referral_links.sql")"
expect_value "two functions carry the 0209 patch exactly once" \
  "$(val "SELECT count(*) || '/' || sum((length(prosrc) - length(replace(prosrc, '[0209]', ''))) / 6) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%[0209]%';")" "2/2"

echo "== Referral codes =="
CODE=$(val "$(as "$REP" "SELECT public.get_my_representative_referral()->>'code';")")
expect_value "an active representative gets an 8-character code" "$(echo "$CODE" | grep -cE '^[A-HJ-NP-Z2-9]{8}$')" "1"
expect_value "the code is stable" "$(val "$(as "$REP" "SELECT public.get_my_representative_referral()->>'code';")")" "$CODE"
expect_value "and comes with its link path" "$(val "$(as "$REP" "SELECT public.get_my_representative_referral()->>'path';")")" "/?rep=$CODE"
CODE_B=$(val "$(as "$REP_B" "SELECT public.get_my_representative_referral()->>'code';")")
CODE_S=$(val "$(as "$REP_S" "SELECT public.get_my_representative_referral()->>'code';")")
expect_value "codes are unique per representative" "$( [ "$CODE" != "$CODE_B" ] && echo unique )" "unique"
"${PSQL[@]}" -q -c "UPDATE public.recruiters SET status = 'suspended' WHERE id = '$REP_S';"
expect_error "a suspended representative gets no link" "Only an active VENTS Representative" "$(as "$REP_S" "SELECT public.get_my_representative_referral();")"
expect_error "a non-representative gets no link" "Only an active VENTS Representative" "$(as "$NEWU" "SELECT public.get_my_representative_referral();")"
expect_error "a client cannot set or change a code" "permission denied" "$(as "$REP" "UPDATE public.recruiters SET organizer_referral_code = 'AAAAAAAA' WHERE id = '$REP';")"

echo "== Claiming at registration =="
claim_ref() { val "$(as "$1" "SELECT public.claim_representative_referral('$2')->>'status';")"; }
expect_value "a user registering through the link is attributed" "$(claim_ref "$NEWU" "$CODE")" "attributed"
expect_value "to that representative, through an accepted 0% referral-link partnership" \
  "$(val "SELECT a.representative_id || '/' || p.status || '/' || p.commission_split_bps || '/' || p.source FROM public.representative_attributions a JOIN public.recruiter_partnerships p ON p.id = a.partnership_id WHERE a.organizer_id = '$NEWU';")" \
  "$REP/accepted/0/referral_link"
expect_value "the representative is notified" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$REP' AND title = 'New organizer referred';")" "1"
expect_value "lower-case and padded codes work (links get retyped)" "$(claim_ref "$NEWU2" " $(echo "$CODE" | tr 'A-Z' 'a-z') ")" "attributed"
expect_value "the same link again changes nothing" "$(claim_ref "$NEWU" "$CODE")" "already_attributed"
expect_value "a different representative's link cannot take the organizer" "$(claim_ref "$NEWU" "$CODE_B")" "already_attributed"
expect_value "the attribution still belongs to the first representative" \
  "$(val "SELECT representative_id FROM public.representative_attributions WHERE organizer_id = '$NEWU';")" "$REP"
expect_value "the takeover attempt is audited" \
  "$(val "SELECT count(*) FROM public.earn_audit_log WHERE action = 'duplicate_attribution_blocked' AND subject_user_id = '$NEWU';")" "1"
expect_value "self-referral is refused" "$(claim_ref "$REP" "$CODE")" "self_referral"
expect_value "a representative cannot be referred by another (no recruiter-to-recruiter)" "$(claim_ref "$REP_B" "$CODE")" "representative_cannot_be_referred"
expect_value "an account older than 72 hours cannot be handed to a representative" "$(claim_ref "$OLDU" "$CODE")" "not_a_new_account"
expect_value "an unknown code is refused" "$(claim_ref "$RACE" "ZZZZZZZZ")" "invalid_code"
expect_value "a malformed code is refused" "$(claim_ref "$RACE" "ABCD-123")" "invalid_code"
expect_value "a suspended representative's code is refused" "$(claim_ref "$RACE" "$CODE_S")" "invalid_code"
expect_error "anonymous callers cannot claim" "permission denied" "SET ROLE anon; SELECT public.claim_representative_referral('$CODE');"
expect_error "clients cannot write attributions directly" "permission denied" \
  "$(as "$RACE" "INSERT INTO public.representative_attributions (representative_id, organizer_id, partnership_id) SELECT '$REP_B', '$RACE', id FROM public.recruiter_partnerships LIMIT 1;")"

echo "== Concurrent claims =="
( "${PSQL[@]}" -tA -c "$(as "$RACE" "SELECT public.claim_representative_referral('$CODE')->>'status';")" >"$TMP/c1" 2>&1 & )
( "${PSQL[@]}" -tA -c "$(as "$RACE" "SELECT public.claim_representative_referral('$CODE_B')->>'status';")" >"$TMP/c2" 2>&1 & )
sleep 2
expect_value "two simultaneous claims through different links: exactly one attribution" \
  "$(cat "$TMP/c1" "$TMP/c2" | grep -c '^attributed$')/$(cat "$TMP/c1" "$TMP/c2" | grep -c '^already_attributed$')/$(val "SELECT count(*) FROM public.representative_attributions WHERE organizer_id = '$RACE';")" "1/1/1"

echo "== Representative dashboard =="
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_verification_requests (user_id, status) VALUES ('$NEWU', 'pending');"
expect_value "referred organizers are listed with source, registration, verification and reward status" \
  "$(val "$(as "$REP" "SELECT string_agg((i->>'organizer_id') || ':' || (i->>'source') || ':' || (i->>'is_organizer') || ':' || COALESCE(i->>'verification_status', '-') || ':' || (i->>'organizer_verified') || ':' || COALESCE(i->>'reward_status', '-'), ',' ORDER BY i->>'organizer_name') FROM jsonb_array_elements(public.get_my_representative_history('attributions')->'items') i WHERE i->>'organizer_id' IN ('$NEWU', '$NEWU2');")")" \
  "$NEWU:referral_link:false:pending:false:-,$NEWU2:referral_link:false:-:false:-"
expect_value "each representative sees only their own referrals (the raced user appears exactly once)" \
  "$(val "$(as "$REP_B" "SELECT count(*) FILTER (WHERE i->>'organizer_id' IN ('$NEWU', '$NEWU2')) FROM jsonb_array_elements(public.get_my_representative_history('attributions')->'items') i;")")/$(( $(val "$(as "$REP" "SELECT count(*) FROM jsonb_array_elements(public.get_my_representative_history('attributions')->'items') i WHERE i->>'organizer_id' = '$RACE';")") + $(val "$(as "$REP_B" "SELECT count(*) FROM jsonb_array_elements(public.get_my_representative_history('attributions')->'items') i WHERE i->>'organizer_id' = '$RACE';")") ))" "0/1"

echo "== Free events never qualify =="
"${PSQL[@]}" -q <<SQL
UPDATE public.users SET is_organizer = true, is_verified = true WHERE id = '$NEWU';
UPDATE public.organizer_verification_requests SET status = 'approved' WHERE user_id = '$NEWU';
INSERT INTO public.events (id, organizer_id, title, event_date, end_date, status, ticket_types, created_at)
  VALUES ('$FREE_EV', '$NEWU', 'Free meetup', now() - interval '6 days', now() - interval '5 days', 'live', '[{"name": "Free", "price": 0}]', now());
SQL
expect_value "a free event is not eligible, with reason free_event" \
  "$(val "SELECT (public.earn_event_eligibility('$FREE_EV')->>'eligible') || '/' || (public.earn_event_eligibility('$FREE_EV')->'reasons' ? 'free_event')::text;")" "false/true"
expect_error "and a reward cannot be claimed for it (refused with reason free_event)" "free_event" "$(as "$REP" "SELECT public.submit_representative_reward_claim('$NEWU', '$FREE_EV');")"

expect_error "undo_0209 is refused once a referral was made" "attributed through referral links" \
  "SET vents.rollback_confirm = 'undo-0209'; $(cat "$REPO_ROOT/supabase/rollback/undo_0209.sql")"

echo "== Representative badge =="
badges() { val "$1 SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.get_representative_badges(ARRAY['$REP', '$REP_S', '$REP_B', '$NEWU']::uuid[]);"; }
expect_value "only active representatives get the badge (suspended and non-representatives do not)" "$(badges "")" "$REP,$REP_B"
expect_value "the badge is visible to signed-out visitors too" "$(badges "SET ROLE anon;")" "$REP,$REP_B"
"${PSQL[@]}" -q -c "UPDATE public.users SET deleted_at = now() WHERE id = '$REP_B';"
expect_value "a deleted account loses the badge" "$(badges "")" "$REP"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES REPRESENTATIVE REFERRAL 0209 CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
