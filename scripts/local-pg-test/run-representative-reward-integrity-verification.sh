#!/usr/bin/env bash
# Real-execution verification of migrations 0216 and 0217 (Batch 1:
# representative reward integrity; the reward is FIXED at N50,000, no monthly
# uplift) on top of the full 0201 -> 0210 stack.
#
# Approved rule: a fixed N50,000 per qualifying organizer, correctly
# attributed through the referral system; the organizer and the event
# verified and approved by two distinct admins; the event not cancelled;
# FREE EVENTS NEVER QUALIFY; no duplicate reward; credited once to the
# withdrawable earnings wallet (organizer_wallets), never the spend-only
# VENTS Wallet (user_wallets).
#
# Covers, end to end through the real functions:
#   referral attribution -> paid event -> claim -> organizer confirmation ->
#   two-admin approval -> realized-profit funding -> earnings credit, and the
#   refusals: free events (at submit, at approval even with the old
#   free_event_verified flag, and at credit for a pre-0216 approval), events
#   taken off live / deleted / hidden (at submit and after approval),
#   duplicate claims, self-approval, double approval, unauthorized approvers,
#   retries and concurrent claims.
#
# Same throwaway local database setup as run-representative-referral-
# verification.sh. SAFETY: local PostgreSQL over its Unix socket only, in a
# database this script creates and always drops. Refuses to start if the
# environment points at any hosted database. Never reads .env files.
#
# Usage: scripts/local-pg-test/run-representative-reward-integrity-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_rep_integrity"
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

# Fixed people. Representatives and admins are old accounts; referred
# organizers register now (a referral must be used at registration).
REP="00000000-0000-0000-0000-00000000a001"; REP2="00000000-0000-0000-0000-00000000a002"
ADMIN_A="00000000-0000-0000-0000-00000000a011"; ADMIN_B="00000000-0000-0000-0000-00000000a012"
ADMIN_C="00000000-0000-0000-0000-00000000a013"; SUB="00000000-0000-0000-0000-00000000a014"
OTHER="00000000-0000-0000-0000-00000000a021"; BUYER="00000000-0000-0000-0000-00000000a022"
ORG_PAID="00000000-0000-0000-0000-00000000b001"; ORG_FREE="00000000-0000-0000-0000-00000000b002"
ORG_DRAFT="00000000-0000-0000-0000-00000000b003"; ORG_DEL="00000000-0000-0000-0000-00000000b004"
ORG_LEGACY="00000000-0000-0000-0000-00000000b005"; ORG_AFTER="00000000-0000-0000-0000-00000000b006"
ORG_RACE="00000000-0000-0000-0000-00000000b007"
# Every organizer the harness refers, in order.
ORG_PROMO="00000000-0000-0000-0000-00000000b008"; ORG_REFUND="00000000-0000-0000-0000-00000000b009"
ORG_RATE="00000000-0000-0000-0000-00000000b00a"; ORG_FIX="00000000-0000-0000-0000-00000000b00b"
ORGS=("$ORG_PAID" "$ORG_FREE" "$ORG_DRAFT" "$ORG_DEL" "$ORG_LEGACY" "$ORG_AFTER" "$ORG_RACE" "$ORG_PROMO" "$ORG_REFUND" "$ORG_RATE" "$ORG_FIX")
EV_PAID="00000000-0000-0000-0000-00000000e001"; EV_PAID_2="00000000-0000-0000-0000-00000000e002"
EV_FREE="00000000-0000-0000-0000-00000000e003"; EV_DRAFT="00000000-0000-0000-0000-00000000e004"
EV_DEL="00000000-0000-0000-0000-00000000e005"; EV_LEGACY="00000000-0000-0000-0000-00000000e006"
EV_AFTER="00000000-0000-0000-0000-00000000e007"; EV_RACE="00000000-0000-0000-0000-00000000e008"
EV_PROMO="00000000-0000-0000-0000-00000000e009"; EV_REFUND="00000000-0000-0000-0000-00000000e00a"
EV_RATE="00000000-0000-0000-0000-00000000e00b"; EV_FIX="00000000-0000-0000-0000-00000000e00c"
LEGACY_CLAIM="00000000-0000-0000-0000-00000000c001"
ORG_LIST="$(printf "'%s'," "${ORGS[@]}" | sed 's/,$//')"   # SQL list of every referred organizer

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
request() { val "$(as "$1" "SELECT public.request_admin_action('$2', 'vents_earn', NULL, 'test', '$3'::jsonb)->>'id';")"; }
approve() { as "$1" "SELECT public.approve_admin_action('$2');"; }
claim_of() { val "SELECT id FROM public.representative_reward_claims WHERE organizer_id = '$1' ORDER BY created_at DESC LIMIT 1;"; }
status_of() { val "SELECT status FROM public.representative_reward_claims WHERE id = '$1';"; }
submit() { as "$1" "SELECT public.submit_representative_reward_claim('$2', '$3');"; }
confirm_claim() { "${PSQL[@]}" -q -c "$(as "$1" "SELECT public.respond_to_representative_reward_claim('$2', true);")" >/dev/null; }
fund() { val "$(as "$1" "SELECT public.claim_representative_reward('$2', '$3')->>'status';")"; }
# available / lifetime earned, in the withdrawable earnings wallet
earnings() { val "SELECT COALESCE((SELECT balance_kobo || '/' || total_earned_kobo FROM public.organizer_wallets WHERE organizer_id = '$1'), 'none');"; }
reward_rows() { val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'representative_reward' AND organizer_id = '$1';"; }
pool() { val "SELECT available_kobo || '/' || reserved_kobo || '/' || credited_kobo FROM public.earn_profit_pool;"; }
# A real purchase through the production money functions (as the webhook
# finalizes it), then the event ends 30 days ago (past the 7-day hold).
buy_one() {
  local ref; ref=$(val "$(as "$BUYER" "SELECT public.create_pending_purchase('$1', 'Regular', '[{\"name\": \"A\"}]'::jsonb)->>'payment_ref';")")
  local amount; amount=$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$ref';")
  "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$ref');" >/dev/null 2>&1 || true
  "${PSQL[@]}" -q -c "SELECT public.confirm_ticket_payment('$ref', $amount);" >/dev/null
}
end_event() { "${PSQL[@]}" -q -c "UPDATE public.events SET event_date = now() - interval '31 days', end_date = now() - interval '30 days' WHERE id = '$1';"; }
recognize() {  # recognize <event>: all of the event's VENTS fee becomes realized profit
  expect_ok "$2" "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_recognize_event_profit "{\"event_id\":\"$1\",\"cost_deductions_kobo\":0,\"note\":\"test\"}")")"
}

echo "== Building throwaway database $DB_NAME (0201 -> 0210) =="
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
"${PSQL[@]}" -q -c "GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text) TO authenticated;"
for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment 0208_ticket_fee_1_5_3_5; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done

echo "== Order =="
expect_error "0216 refuses before 0209 (it relies on 0209's free_event eligibility reason)" "0216 requires 0209" \
  "$(cat "$MIG/0216_representative_rewards_free_events_never_qualify.sql")"
"${PSQL[@]}" -q -f "$MIG/0209_representative_referral_links.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0210_referral_connections.sql" >/dev/null

"${PSQL[@]}" -q <<SQL
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url text;
INSERT INTO public.users (id, role, is_organizer, full_name, email, created_at) VALUES
  ('$REP', 'user', false, 'Rep One', 'r1@example.test', now() - interval '90 days'),
  ('$REP2', 'user', false, 'Rep Two', 'r2@example.test', now() - interval '90 days'),
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test', now() - interval '90 days'),
  ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test', now() - interval '90 days'),
  ('$ADMIN_C', 'admin', false, 'Admin C', 'ac@example.test', now() - interval '90 days'),
  ('$SUB', 'sub-admin', false, 'Sub', 's@example.test', now() - interval '90 days'),
  ('$OTHER', 'user', false, 'Other', 'o@example.test', now() - interval '90 days'),
  ('$BUYER', 'user', false, 'Buyer', 'b@example.test', now() - interval '90 days');
INSERT INTO public.users (id, role, is_organizer, full_name, email, created_at)
  SELECT u, 'user', false, 'Organizer ' || right(u::text, 2), right(u::text, 4) || '@example.test', now()
    FROM unnest(ARRAY[$ORG_LIST]::uuid[]) u;
INSERT INTO public.recruiters (id, display_name, status) VALUES ('$REP', 'Rep One', 'active'), ('$REP2', 'Rep Two', 'active');
-- The representative already holds spend-only VENTS Wallet money; it must never move.
INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$REP', 10000);
SQL

echo "== Referral attribution =="
CODE=$(val "$(as "$REP" "SELECT public.get_my_representative_referral()->>'code';")")
CODE2=$(val "$(as "$REP2" "SELECT public.get_my_representative_referral()->>'code';")")
for o in "${ORGS[@]}"; do
  expect_value "organizer ${o: -2} registers through Rep One's link and is attributed" \
    "$(val "$(as "$o" "SELECT public.claim_representative_referral('$CODE')->>'status';")")" "attributed"
done
expect_value "a second representative's link cannot take an attributed organizer" \
  "$(val "$(as "$ORG_PAID" "SELECT public.claim_representative_referral('$CODE2')->>'status';")")" "already_attributed"
expect_value "the attribution still belongs to the first representative (one row)" \
  "$(val "SELECT count(*) || '/' || max(representative_id::text) FROM public.representative_attributions WHERE organizer_id = '$ORG_PAID';")" "1/$REP"
expect_error "a client cannot reassign an attribution directly" "permission denied" \
  "$(as "$REP2" "UPDATE public.representative_attributions SET representative_id = '$REP2' WHERE organizer_id = '$ORG_PAID';")"

# The organizers become verified organizers, then create events after the referral.
"${PSQL[@]}" -q <<SQL
UPDATE public.users SET is_organizer = true, is_verified = true WHERE id IN ($ORG_LIST);
INSERT INTO public.organizer_verification_requests (user_id, status)
  SELECT u, 'approved' FROM unnest(ARRAY[$ORG_LIST]::uuid[]) u;
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EV_PAID',   '$ORG_PAID',   'Paid concert',   now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_PAID_2', '$ORG_PAID',   'Second concert', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_FREE',   '$ORG_FREE',   'Free meetup',    now() + interval '30 days', 'live', '[{"name": "Free", "price": 0}]'),
  ('$EV_DRAFT',  '$ORG_DRAFT',  'Taken down',     now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_DEL',    '$ORG_DEL',    'Deleted',        now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_LEGACY', '$ORG_LEGACY', 'Old free night', now() + interval '30 days', 'live', '[{"name": "Free", "price": 0}]'),
  ('$EV_AFTER',  '$ORG_AFTER',  'Later cancelled', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_RACE',   '$ORG_RACE',   'Race night',     now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_PROMO',  '$ORG_PROMO',  'All on promo',   now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_REFUND', '$ORG_REFUND', 'All refunded',   now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_RATE',   '$ORG_RATE',   'Rate night',     now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_FIX',    '$ORG_FIX',    'Fixed night',    now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]');
SQL
for e in "$EV_PAID" "$EV_PAID_2" "$EV_PAID_2" "$EV_DRAFT" "$EV_DEL" "$EV_AFTER" "$EV_RACE" "$EV_REFUND" "$EV_RATE" "$EV_RATE" "$EV_FIX"; do buy_one "$e"; done
for e in "$EV_PAID" "$EV_PAID_2" "$EV_FREE" "$EV_DRAFT" "$EV_DEL" "$EV_LEGACY" "$EV_AFTER" "$EV_RACE" "$EV_PROMO" "$EV_REFUND" "$EV_RATE" "$EV_FIX"; do end_event "$e"; done
# EV_RATE ends 8 days ago (past the 7-day hold) so its reward month differs from the 30-day-old events' only by date, never by rule.
"${PSQL[@]}" -q -c "UPDATE public.events SET event_date = now() - interval '9 days', end_date = now() - interval '8 days' WHERE id IN ('$EV_RATE', '$EV_FIX');"
# Tickets exactly as production writes them (purchase_ticket, 0124): a N0 RSVP
# and a 100%-promo ticket are stored as payment_status 'paid'. A failed
# purchase leaves a 'failed' ticket. Refunds flip one ticket row each.
"${PSQL[@]}" -q <<SQL
INSERT INTO public.tickets (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status, holder_name, discount_percentage) VALUES
  ('$EV_FREE',  '$BUYER', 1, 'Free',    0,       'VNT-FREE-T1',  'paid',   'active', 'RSVP', 0),
  ('$EV_FREE',  '$BUYER', 1, 'Free',    0,       'VNT-FREE-T2',  'failed', 'active', 'RSVP', 0),
  ('$EV_PROMO', '$BUYER', 1, 'Regular', 1000000, 'VNT-PROMO-T1', 'paid',   'active', 'Promo', 100);
UPDATE public.tickets SET payment_status = 'refunded' WHERE event_id = '$EV_REFUND';
UPDATE public.tickets SET payment_status = 'refunded' WHERE id = (SELECT id FROM public.tickets WHERE event_id = '$EV_PAID_2' ORDER BY id LIMIT 1);
SQL
echo "== The bug 0216 fixes, reproduced before it is applied =="
expect_value "before 0216: a free event with an RSVP counts as paid and eligible" "$(val "SELECT public.earn_event_eligibility('$EV_FREE')->>'eligible';")" "true"
expect_value "before 0216: an event whose only ticket was 100% promo counts as paid and eligible" "$(val "SELECT public.earn_event_eligibility('$EV_PROMO')->>'eligible';")" "true"
expect_value "before 0216: an event whose every ticket was refunded counts as paid and eligible" "$(val "SELECT public.earn_event_eligibility('$EV_REFUND')->>'eligible';")" "true"
"${PSQL[@]}" -q -c "UPDATE public.events SET status = 'draft' WHERE id = '$EV_DRAFT'; UPDATE public.events SET deleted_at = now() WHERE id = '$EV_DEL';"

# A free-event reward approved under 0201's old override, before 0209/0216
# existed (written directly, as production could hold one).
"${PSQL[@]}" -q <<SQL
INSERT INTO public.representative_reward_claims
  (id, attribution_id, representative_id, organizer_id, event_id, reward_month, amount_kobo, status,
   is_free_event, free_event_verified, event_verified, organizer_verified, organizer_confirmed_at,
   approved_at, approved_by, approval_requested_by)
SELECT '$LEGACY_CLAIM', a.id, '$REP', '$ORG_LEGACY', '$EV_LEGACY', date_trunc('month', now())::date, 5000000, 'approved',
       true, true, true, true, now(), now(), '$ADMIN_B', '$ADMIN_A'
  FROM public.representative_attributions a WHERE a.organizer_id = '$ORG_LEGACY';
SQL

echo "== Applying 0216 =="
# Every function body, plus each reward-claim constraint's name, definition and VALIDATED state.
STATE_SQL="SELECT md5(string_agg(p.proname || ':' || p.prosrc, '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT string_agg(conname || ':' || convalidated || ':' || md5(pg_get_constraintdef(oid)), ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.representative_reward_claims'::regclass) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
PRE_0216=$(val "$STATE_SQL")
PRE_ROWS_0216=$(val "SELECT md5(COALESCE((SELECT string_agg(c::text, '|' ORDER BY c.id) FROM public.representative_reward_claims c), '')) || '/' || md5(COALESCE((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM public.organizer_transactions t), '')) || '/' || md5(COALESCE((SELECT string_agg(w::text, '|' ORDER BY w.organizer_id) FROM public.organizer_wallets w), ''));")
if "${PSQL[@]}" -f "$MIG/0216_representative_rewards_free_events_never_qualify.sql" >"$OUT" 2>"$ERR"; then pass "0216 applies on top of 0201-0210"; else fail "0216 applies"; cat "$ERR" >&2; fi
expect_value "0216 reports the pre-existing free-event approval for admin follow-up (and changes no row)" \
  "$(grep -c "1 free-event reward claim(s) are approved" "$ERR")/$(status_of "$LEGACY_CLAIM")" "1/approved"
ROWS_SQL="SELECT md5(COALESCE((SELECT string_agg(c::text, '|' ORDER BY c.id) FROM public.representative_reward_claims c), '')) || '/' || md5(COALESCE((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM public.organizer_transactions t), '')) || '/' || md5(COALESCE((SELECT string_agg(w::text, '|' ORDER BY w.organizer_id) FROM public.organizer_wallets w), ''));"
PRE_ROWS=$(val "$ROWS_SQL")
expect_value "applying 0216 changed no claim, ledger or wallet row" "$(val "$ROWS_SQL")" "$PRE_ROWS_0216"
expect_ok "undo_0216 runs" "SET vents.rollback_confirm = 'undo-0216'; $(cat "$REPO_ROOT/supabase/rollback/undo_0216.sql")"
expect_value "undo_0216 restores every function and every claim constraint exactly, including its validated state" "$(val "$STATE_SQL")" "$PRE_0216"
expect_value "... the restored CHECK is validated, as 0201 created it" \
  "$(val "SELECT convalidated FROM pg_constraint WHERE conname = 'representative_reward_claims_free_needs_verification';")" "t"
expect_value "... and the undo changed no claim, ledger or wallet row" "$(val "$ROWS_SQL")" "$PRE_ROWS"
expect_error "undo_0216 refuses without the confirmation" "undo-0216" "$(cat "$REPO_ROOT/supabase/rollback/undo_0216.sql")"
expect_ok "0216 re-applies after the undo" "$(cat "$MIG/0216_representative_rewards_free_events_never_qualify.sql")"
expect_ok "0216 is idempotent (second run)" "$(cat "$MIG/0216_representative_rewards_free_events_never_qualify.sql")"
expect_value "four functions carry the 0216 patch; the old free-event override text is gone" \
  "$(val "SELECT string_agg(proname, ',' ORDER BY proname) FILTER (WHERE prosrc LIKE '%[0216]%') || '/' || count(*) FILTER (WHERE prosrc LIKE '%must be explicitly verified as genuine%') FROM pg_proc WHERE pronamespace = 'public'::regnamespace;")" \
  "claim_representative_reward,earn_event_eligibility,earn_execute_admin_action,representative_qualifying_count/0"
expect_value "the table CHECK now forbids an approved/funded/credited free-event claim" \
  "$(val "SELECT string_agg(conname, ',') FROM pg_constraint WHERE conname LIKE 'representative_reward_claims_free%';")" "representative_reward_claims_free_never_qualifies"

echo "== Programme open (dual control), payouts still off =="
expect_ok "legacy reconciliation recorded by two admins" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_update_settings '{"legacy_commission_reconciled": true, "note": "test"}')")"
expect_value "the base reward is exactly N50,000 and cannot be changed" \
  "$(val "SELECT base_reward_kobo FROM public.earn_settings;")" "5000000"
expect_error "the base reward CHECK refuses any other amount" "check constraint" "UPDATE public.earn_settings SET base_reward_kobo = 6000000;"

echo "== Event eligibility =="
elig() { val "SELECT (public.earn_event_eligibility('$1')->>'eligible') || '/' || (public.earn_event_eligibility('$1')->>'reasons');"; }
expect_value "a paid, ended, settled event qualifies" "$(elig "$EV_PAID")" "true/[]"
expect_value "a free event never qualifies (reason free_event)" "$(elig "$EV_FREE")" 'false/["free_event"]'
expect_value "an event taken off live does not qualify" "$(elig "$EV_DRAFT")" 'false/["event_not_live"]'
expect_value "a deleted event does not qualify" "$(val "SELECT public.earn_event_eligibility('$EV_DEL')->'reasons' ? 'event_deleted';")" "t"

echo "== Genuinely paid tickets (0216) =="
expect_value "a free event with an RSVP (stored as paid at N0) and a failed ticket is free" "$(elig "$EV_FREE")" 'false/["free_event"]'
expect_value "an event whose only ticket used a 100% promo is free" "$(elig "$EV_PROMO")" 'false/["free_event"]'
expect_value "an event whose every ticket was refunded is free" "$(elig "$EV_REFUND")" 'false/["free_event"]'
expect_value "a partially refunded event still qualifies (one paid ticket remains)" \
  "$(val "SELECT (public.earn_event_eligibility('$EV_PAID_2')->>'eligible') || '/' || (public.earn_event_eligibility('$EV_PAID_2')->>'valid_paid_tickets') || '/' || (public.earn_event_eligibility('$EV_PAID_2')->>'paid_tickets');")" "true/1/1"
expect_value "a normal paid event reports its genuinely paid tickets" "$(val "SELECT public.earn_event_eligibility('$EV_PAID')->>'valid_paid_tickets';")" "1"
expect_error "a 100%-promo event cannot be submitted" "free_event" "$(submit "$REP" "$ORG_PROMO" "$EV_PROMO")"
expect_error "a fully refunded event cannot be submitted" "free_event" "$(submit "$REP" "$ORG_REFUND" "$EV_REFUND")"

echo "== Submission =="
expect_error "a free event cannot be submitted" "free_event" "$(submit "$REP" "$ORG_FREE" "$EV_FREE")"
expect_error "an event taken off live cannot be submitted" "event_not_live" "$(submit "$REP" "$ORG_DRAFT" "$EV_DRAFT")"
expect_error "a deleted event cannot be submitted" "event_deleted" "$(submit "$REP" "$ORG_DEL" "$EV_DEL")"
expect_error "another representative cannot claim an organizer attributed to someone else" "not attributed to you" "$(submit "$REP2" "$ORG_PAID" "$EV_PAID")"
expect_error "a user who is not a representative cannot claim" "active representative" "$(submit "$OTHER" "$ORG_PAID" "$EV_PAID")"
expect_ok "the paid event is submitted" "$(submit "$REP" "$ORG_PAID" "$EV_PAID")"
C_PAID=$(claim_of "$ORG_PAID")
expect_value "... status pending_organizer, base amount N50,000, not a free event" \
  "$(val "SELECT status || '/' || amount_kobo || '/' || is_free_event FROM public.representative_reward_claims WHERE id = '$C_PAID';")" "pending_organizer/5000000/false"
expect_value "resubmitting the same claim returns it (duplicate), no second row" \
  "$(val "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG_PAID', '$EV_PAID')->>'duplicate';")")/$(val "SELECT count(*) FROM public.representative_reward_claims WHERE organizer_id = '$ORG_PAID';")" "true/1"
expect_error "one reward per organizer: a second paid event cannot be claimed" "already exists" "$(submit "$REP" "$ORG_PAID" "$EV_PAID_2")"
expect_error "clients cannot write claims directly" "permission denied" \
  "$(as "$REP" "UPDATE public.representative_reward_claims SET status = 'approved' WHERE id = '$C_PAID';")"
confirm_claim "$ORG_PAID" "$C_PAID"
expect_value "the organizer confirms the referral" "$(status_of "$C_PAID")" "pending_review"

echo "== The old free-event override is refused =="
# A free-event claim waiting for review (written directly, as one made before
# 0209 could be): no request can approve it, with or without the old flag.
"${PSQL[@]}" -q <<SQL
UPDATE public.representative_reward_claims SET status = 'rejected', rejected_at = now(), decision_reason = 'test reset' WHERE id = '$LEGACY_CLAIM';
INSERT INTO public.representative_reward_claims
  (attribution_id, representative_id, organizer_id, event_id, reward_month, amount_kobo, status, is_free_event, organizer_confirmed_at)
SELECT a.id, '$REP', '$ORG_FREE', '$EV_FREE', date_trunc('month', now())::date, 5000000, 'pending_review', true, now()
  FROM public.representative_attributions a WHERE a.organizer_id = '$ORG_FREE';
SQL
C_FREE=$(claim_of "$ORG_FREE")
R=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_FREE\",\"event_verified\":true,\"free_event_verified\":true}")
expect_error "a free event cannot be approved with the old free_event_verified = true" "free_event_verified is no longer accepted" "$(approve "$ADMIN_B" "$R")"
for b in '"true"' '"t"' '1' 'null' '[true]'; do
  R=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_FREE\",\"event_verified\":true,\"free_event_verified\":$b}")
  expect_error "... nor with free_event_verified = $b" "free_event_verified is no longer accepted" "$(approve "$ADMIN_B" "$R")"
done
R=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_FREE\",\"event_verified\":true}")
expect_error "a free event cannot be approved without the flag either" "free_event" "$(approve "$ADMIN_B" "$R")"
R=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_FREE\",\"event_verified\":true,\"free_event_verified\":false}")
expect_error "... nor with free_event_verified = false" "free_event" "$(approve "$ADMIN_B" "$R")"
expect_value "the free-event claim was never approved" "$(status_of "$C_FREE")" "pending_review"
# Defence in depth: even if eligibility stopped flagging free events, the approval branch refuses one.
"${PSQL[@]}" -q -c "ALTER FUNCTION public.earn_event_eligibility(uuid) RENAME TO earn_event_eligibility_real;
  CREATE FUNCTION public.earn_event_eligibility(p uuid) RETURNS jsonb LANGUAGE sql SET search_path TO '' AS \$f\$
    SELECT public.earn_event_eligibility_real(p) || jsonb_build_object('eligible', true, 'reasons', '[]'::jsonb) \$f\$;"
R=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_FREE\",\"event_verified\":true}")
expect_error "the approval branch refuses a free event even if eligibility reported it eligible" "Free events never qualify" "$(approve "$ADMIN_B" "$R")"
"${PSQL[@]}" -q -c "DROP FUNCTION public.earn_event_eligibility(uuid); ALTER FUNCTION public.earn_event_eligibility_real(uuid) RENAME TO earn_event_eligibility;"
expect_error "the table itself refuses an approved free-event claim" "representative_reward_claims_free_never_qualifies" \
  "UPDATE public.representative_reward_claims SET status = 'approved', free_event_verified = true WHERE id = '$C_FREE';"

echo "== Dual-admin approval of the paid event =="
R=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_PAID\",\"event_verified\":true}")
expect_error "the requesting admin cannot approve their own request" "Cannot approve your own request" "$(approve "$ADMIN_A" "$R")"
expect_error "a sub-admin cannot approve" "Super Admin access required" "$(approve "$SUB" "$R")"
expect_error "an ordinary user cannot approve" "Super Admin access required" "$(approve "$OTHER" "$R")"
expect_error "the representative cannot approve" "Super Admin access required" "$(approve "$REP" "$R")"
expect_error "an ordinary user cannot even request an approval" "Admin access required" \
  "$(as "$OTHER" "SELECT public.request_admin_action('earn_approve_reward', 'vents_earn', NULL, 'x', '{\"claim_id\":\"$C_PAID\",\"event_verified\":true}'::jsonb);")"
expect_error "clients cannot call the executor directly" "permission denied" "$(as "$ADMIN_B" "SELECT public.earn_execute_admin_action('$R');")"
expect_value "still under review after every refused attempt" "$(status_of "$C_PAID")" "pending_review"
RW=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_PAID\",\"event_verified\":true,\"free_event_verified\":true}")
expect_error "a paid-event request that still carries free_event_verified = true is refused" "no longer accepted" "$(approve "$ADMIN_B" "$RW")"
expect_ok "a distinct second admin approves (the request the current app sends: free_event_verified false is tolerated)" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_PAID\",\"event_verified\":true,\"free_event_verified\":false}")")"
expect_value "approved at exactly N50,000, recorded as a paid event with verified event and organizer" \
  "$(val "SELECT status || '/' || amount_kobo || '/' || is_free_event || '/' || free_event_verified || '/' || event_verified || '/' || organizer_verified || '/' || (approved_by = '$ADMIN_B') || '/' || (approval_requested_by = '$ADMIN_A') FROM public.representative_reward_claims WHERE id = '$C_PAID';")" \
  "approved/5000000/false/false/true/true/true/true"
expect_error "the same admin approving the same request again is refused" "Request already approved" "$(approve "$ADMIN_B" "$(val "SELECT id FROM public.admin_action_requests WHERE status = 'approved' AND payload->>'claim_id' = '$C_PAID';")")"
expect_error "a second approval request for an approved claim cannot approve it again" "Only a claim the organizer confirmed" "$(approve "$ADMIN_C" "$R")"
expect_value "the approval is in the append-only audit trail exactly once" \
  "$(val "SELECT count(*) FROM public.earn_audit_log WHERE entity_id = '$C_PAID' AND action = 'admin_approved';")" "1"

echo "== Funding and credit to the withdrawable earnings wallet =="
expect_value "no realized profit yet: the reward waits, nothing reserved" "$(fund "$REP" "$C_PAID" 11111111-1111-1111-1111-111111111111)/$(pool)" "awaiting_profit/0/0/0"
recognize "$EV_PAID" "the paid event's VENTS fees are recognized as realized profit (two admins)"
expect_value "1.5% + 3.5% of a N1,000,000 ticket = exactly one N50,000 reward in the pool" "$(pool)" "5000000/0/0"
expect_value "funded (payouts still off: nothing credited)" "$(fund "$REP" "$C_PAID" 22222222-2222-2222-2222-222222222222)/$(earnings "$REP")" "funded/none"
expect_value "retrying the funding does not reserve twice" \
  "$(fund "$REP" "$C_PAID" 22222222-2222-2222-2222-222222222222)/$(val "SELECT count(*) FROM public.earn_profit_ledger WHERE claim_id = '$C_PAID' AND entry_type = 'reservation';")/$(pool)" "funded/1/0/5000000/0"
expect_ok "reward payouts switched on by two admins" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_update_settings '{"payouts_enabled": true, "note": "test"}')")"
expect_error "only the representative can claim their reward" "Not authorized" "$(as "$ORG_PAID" "SELECT public.claim_representative_reward('$C_PAID', gen_random_uuid());")"
expect_value "credited" "$(fund "$REP" "$C_PAID" 22222222-2222-2222-2222-222222222222)" "credited"
expect_value "earnings wallet: exactly N50,000 available and earned" "$(earnings "$REP")" "5000000/5000000"
expect_value "the spend-only VENTS Wallet is untouched" "$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$REP';")" "10000"
expect_value "exactly one representative_reward ledger row, linked from the claim" \
  "$(reward_rows "$REP")/$(val "SELECT (earnings_transaction_id = (SELECT id FROM public.organizer_transactions WHERE type = 'representative_reward' AND metadata->>'representative_reward_claim_id' = '$C_PAID'))::text FROM public.representative_reward_claims WHERE id = '$C_PAID';")" "1/true"
expect_value "retrying with the same key changes nothing" "$(val "$(as "$REP" "SELECT public.claim_representative_reward('$C_PAID', '22222222-2222-2222-2222-222222222222')->>'duplicate';")")/$(earnings "$REP")/$(reward_rows "$REP")" "true/5000000/5000000/1"
expect_value "retrying with a new key changes nothing" "$(val "$(as "$REP" "SELECT public.claim_representative_reward('$C_PAID', gen_random_uuid())->>'duplicate';")")/$(earnings "$REP")/$(reward_rows "$REP")" "true/5000000/5000000/1"
expect_error "the ledger itself refuses a second credit for the same claim" "organizer_transactions_rep_reward_once" \
  "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, metadata) VALUES ('$REP', 'representative_reward', 5000000, jsonb_build_object('representative_reward_claim_id', '$C_PAID'));"
expect_value "pool: the reservation moved to credited" "$(pool)" "0/0/5000000"

echo "== Concurrent claims never double-credit =="
"${PSQL[@]}" -q -c "$(submit "$REP" "$ORG_RACE" "$EV_RACE")" >/dev/null
C_RACE=$(claim_of "$ORG_RACE"); confirm_claim "$ORG_RACE" "$C_RACE"
expect_ok "race claim approved by two admins" "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_RACE\",\"event_verified\":true}")")"
recognize "$EV_RACE" "race event profit recognized"
for i in 1 2 3 4; do
  ( "${PSQL[@]}" -tA -c "$(as "$REP" "SELECT public.claim_representative_reward('$C_RACE', gen_random_uuid())->>'status';")" >"$TMP/race$i" 2>&1 ) &
done
wait
expect_value "four simultaneous claims: all report credited, exactly one ledger row, N50,000 once" \
  "$(cat "$TMP"/race* | grep -c '^credited$')/$(val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'representative_reward' AND metadata->>'representative_reward_claim_id' = '$C_RACE';")/$(earnings "$REP")" \
  "4/1/10000000/10000000"

echo "== An approved reward whose event is cancelled, deleted or hidden is not credited =="
"${PSQL[@]}" -q -c "$(submit "$REP" "$ORG_AFTER" "$EV_AFTER")" >/dev/null
C_AFTER=$(claim_of "$ORG_AFTER"); confirm_claim "$ORG_AFTER" "$C_AFTER"
expect_ok "approved while the event was valid" "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_AFTER\",\"event_verified\":true}")")"
recognize "$EV_AFTER" "its profit recognized"
"${PSQL[@]}" -q -c "UPDATE public.events SET status = 'draft' WHERE id = '$EV_AFTER';"
expect_error "the organizer takes the event off live: not credited" "no longer qualifies" "$(as "$REP" "SELECT public.claim_representative_reward('$C_AFTER', gen_random_uuid());")"
"${PSQL[@]}" -q -c "UPDATE public.events SET status = 'live', deleted_at = now() WHERE id = '$EV_AFTER';"
expect_error "the event is deleted: not credited" "no longer qualifies" "$(as "$REP" "SELECT public.claim_representative_reward('$C_AFTER', gen_random_uuid());")"
"${PSQL[@]}" -q -c "UPDATE public.events SET deleted_at = NULL, hidden_by_admin = true WHERE id = '$EV_AFTER';"
expect_error "an admin hides the event: not credited" "no longer qualifies" "$(as "$REP" "SELECT public.claim_representative_reward('$C_AFTER', gen_random_uuid());")"
"${PSQL[@]}" -q -c "UPDATE public.events SET hidden_by_admin = false WHERE id = '$EV_AFTER'; UPDATE public.tickets SET payment_status = 'refunded' WHERE event_id = '$EV_AFTER';"
expect_error "its only ticket is refunded after approval: not credited (reason free_event in the detail)" "eligibility reasons: \[\"free_event\"\]" "$(as "$REP" "SELECT public.claim_representative_reward('$C_AFTER', gen_random_uuid());")"
expect_value "the claim stays approved for admin review; no money moved and nothing reserved" \
  "$(status_of "$C_AFTER")/$(earnings "$REP")/$(val "SELECT count(*) FROM public.earn_profit_ledger WHERE claim_id = '$C_AFTER';")" "approved/10000000/10000000/0"
expect_ok "admins can still reject it through dual control" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_reject_reward "{\"claim_id\":\"$C_AFTER\",\"reason\":\"event cancelled\"}")")"
expect_value "rejected" "$(status_of "$C_AFTER")" "rejected"

echo "== A free-event reward approved before 0216: not credited, not counted, reversed with its reservation released =="
unlock_constraint() { "${PSQL[@]}" -q -c "ALTER TABLE public.representative_reward_claims DROP CONSTRAINT representative_reward_claims_free_never_qualifies;"; }
relock_constraint() { "${PSQL[@]}" -q -c "ALTER TABLE public.representative_reward_claims ADD CONSTRAINT representative_reward_claims_free_never_qualifies CHECK (status NOT IN ('approved', 'funded', 'credited') OR NOT is_free_event) NOT VALID;"; }
# Test-only owner writes recreate the state production could hold from before 0209/0216.
unlock_constraint
"${PSQL[@]}" -q -c "UPDATE public.representative_reward_claims SET status = 'approved', rejected_at = NULL, decision_reason = NULL WHERE id = '$LEGACY_CLAIM';"
relock_constraint
expect_error "claiming the legacy free-event reward is refused" "Free events never qualify" "$(as "$REP" "SELECT public.claim_representative_reward('$LEGACY_CLAIM', gen_random_uuid());")"
expect_value "nothing credited, nothing reserved for it" "$(earnings "$REP")/$(val "SELECT count(*) FROM public.earn_profit_ledger WHERE claim_id = '$LEGACY_CLAIM';")" "10000000/10000000/0"

LM=$(val "SELECT reward_month FROM public.representative_reward_claims WHERE id = '$LEGACY_CLAIM';")
count_q() { val "SELECT public.representative_qualifying_count('$REP', '$1');"; }
raw_0201_count() { val "SELECT count(*) FROM public.representative_reward_claims WHERE representative_id = '$REP' AND reward_month = '$1' AND status IN ('approved', 'funded', 'credited');"; }
Q_WITH=$(count_q "$LM")
"${PSQL[@]}" -q -c "UPDATE public.representative_reward_claims SET status = 'rejected' WHERE id = '$LEGACY_CLAIM';"
Q_WITHOUT=$(count_q "$LM")
unlock_constraint; "${PSQL[@]}" -q -c "UPDATE public.representative_reward_claims SET status = 'approved' WHERE id = '$LEGACY_CLAIM';"; relock_constraint
expect_value "the approved legacy free claim adds nothing to the qualifying count (0201's count would add 1)" \
  "$Q_WITH/$(( $(raw_0201_count "$LM") - Q_WITH ))" "$Q_WITHOUT/1"

# Nine more legacy free approvals for last month: none of them counts as a
# qualifying organizer (the count no longer affects any amount after 0217).
THIS=$(val "SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')::date;")
PREV=$(val "SELECT (date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') - interval '1 month')::date;")
for i in 1 2 3 4 5 6 7 8 9; do
  u="00000000-0000-0000-0000-0000000f00$(printf '%02d' $i)"
  "${PSQL[@]}" -q -c "INSERT INTO public.users (id, role, is_organizer, full_name, email, created_at) VALUES ('$u', 'user', true, 'Free Org $i', 'free$i@example.test', now());"
  val "$(as "$u" "SELECT public.claim_representative_referral('$CODE')->>'status';")" >/dev/null
done
unlock_constraint
"${PSQL[@]}" -q <<SQL
INSERT INTO public.events (id, organizer_id, title, event_date, end_date, status, ticket_types, created_at)
  SELECT ('00000000-0000-0000-0000-0000000fe0' || lpad(i::text, 2, '0'))::uuid, ('00000000-0000-0000-0000-0000000f00' || lpad(i::text, 2, '0'))::uuid,
         'Free ' || i, now() - interval '40 days', now() - interval '39 days', 'live', '[{"name": "Free", "price": 0}]', now()
    FROM generate_series(1, 9) i;
INSERT INTO public.representative_reward_claims
  (attribution_id, representative_id, organizer_id, event_id, reward_month, amount_kobo, status, is_free_event, free_event_verified,
   event_verified, organizer_verified, organizer_confirmed_at, approved_at, approved_by, approval_requested_by)
SELECT a.id, '$REP', a.organizer_id, ('00000000-0000-0000-0000-0000000fe0' || right(a.organizer_id::text, 2))::uuid, '$PREV', 5000000, 'approved',
       true, true, true, true, now(), now(), '$ADMIN_B', '$ADMIN_A'
  FROM public.representative_attributions a WHERE a.organizer_id::text LIKE '00000000-0000-0000-0000-0000000f00%';
SQL
relock_constraint
K=$(count_q "$PREV")
expect_value "0201's monthly count would see 9+ free claims for last month; 0216's count excludes all nine" \
  "$( [ "$(raw_0201_count "$PREV")" -ge 9 ] && echo yes)/$( [ "$K" -lt 9 ] && echo below-9)" "yes/below-9"

# A legacy free claim that was FUNDED (profit reserved) before 0216.
POOL_BEFORE=$(pool)
unlock_constraint
"${PSQL[@]}" -q -c "SELECT public.earn_pool_move('reservation', 5000000, NULL, '$LEGACY_CLAIM', NULL);
  UPDATE public.representative_reward_claims SET status = 'funded', funded_at = now(), funding_idempotency_key = gen_random_uuid() WHERE id = '$LEGACY_CLAIM';"
relock_constraint
expect_value "the legacy funded free claim holds N50,000 of reserved profit" "$(pool)" "$(echo "$POOL_BEFORE" | awk -F/ '{print $1-5000000 "/" $2+5000000 "/" $3}')"
expect_error "crediting the funded legacy free claim is refused" "Free events never qualify" "$(as "$REP" "SELECT public.claim_representative_reward('$LEGACY_CLAIM', gen_random_uuid());")"
expect_ok "admins reverse it through dual control" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_reverse_reward "{\"claim_id\":\"$LEGACY_CLAIM\",\"reason\":\"free events never qualify\"}")")"
expect_value "reversed; the reservation is released back to available profit; no wallet or ledger credit" \
  "$(status_of "$LEGACY_CLAIM")/$(pool)/$(val "SELECT string_agg(entry_type, ',' ORDER BY created_at) FROM public.earn_profit_ledger WHERE claim_id = '$LEGACY_CLAIM';")/$(earnings "$REP")/$(val "SELECT count(*) FROM public.organizer_transactions WHERE metadata->>'representative_reward_claim_id' = '$LEGACY_CLAIM';")" \
  "reversed/$POOL_BEFORE/reservation,release/10000000/10000000/0"

echo "== Before 0217: a claim approved at a higher monthly rate (0201 behaviour), and concurrent approvals by two admins =="
"${PSQL[@]}" -q -c "$(submit "$REP" "$ORG_RATE" "$EV_RATE")" >/dev/null
C_RATE=$(claim_of "$ORG_RATE"); confirm_claim "$ORG_RATE" "$C_RATE"
RM=$(val "SELECT reward_month FROM public.representative_reward_claims WHERE id = '$C_RATE';")
# A rate approved earlier through 0201's dual-control rule (owner write; the
# discontinued path itself is covered historically by run-representative-rewards-verification.sh).
"${PSQL[@]}" -q -c "INSERT INTO public.representative_monthly_rates (representative_id, month, reward_kobo, basis_month_count, reason, requested_by, approved_by) VALUES ('$REP', '$RM', 7500000, 9, 'approved rate', '$ADMIN_A', '$ADMIN_C');"
expect_error "the table refuses a rate at or below the N50,000 base" "representative_monthly_rates_reward_kobo_check" \
  "INSERT INTO public.representative_monthly_rates (representative_id, month, reward_kobo, basis_month_count, reason, requested_by, approved_by) VALUES ('$REP2', '$RM', 5000000, 9, 'x', '$ADMIN_A', '$ADMIN_C');"
Q_RM_BEFORE=$(count_q "$RM")
R1=$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_RATE\",\"event_verified\":true}")
R2=$(request "$ADMIN_C" earn_approve_reward "{\"claim_id\":\"$C_RATE\",\"event_verified\":true}")
( "${PSQL[@]}" -tA -c "$(approve "$ADMIN_B" "$R1")" >"$TMP/appr1" 2>&1; echo "rc=$?" >>"$TMP/appr1" ) &
( "${PSQL[@]}" -tA -c "$(approve "$ADMIN_A" "$R2")" >"$TMP/appr2" 2>&1; echo "rc=$?" >>"$TMP/appr2" ) &
wait
expect_value "two admins approving the same claim at the same time: exactly one succeeds, the other is refused" \
  "$(cat "$TMP/appr1" "$TMP/appr2" | grep -c '^rc=0$')/$(cat "$TMP/appr1" "$TMP/appr2" | grep -c 'Only a claim the organizer confirmed')" "1/1"
expect_value "the claim was approved once, recorded once in the audit trail, and one request stays pending" \
  "$(status_of "$C_RATE")/$(val "SELECT count(*) FROM public.earn_audit_log WHERE entity_id = '$C_RATE' AND action = 'admin_approved';")/$(val "SELECT string_agg(status, ',' ORDER BY status) FROM public.admin_action_requests WHERE id IN ('$R1', '$R2');")" \
  "approved/1/approved,pending"
expect_value "before 0217, the approved higher rate still applied (N75,000)" "$(val "SELECT amount_kobo FROM public.representative_reward_claims WHERE id = '$C_RATE';")" "7500000"
expect_value "a valid paid-event claim counts in the monthly qualifying count (+1)" "$(( $(count_q "$RM") - Q_RM_BEFORE ))" "1"
expect_value "a claim for a month with no approved rate uses the N50,000 base" "$(val "SELECT amount_kobo FROM public.representative_reward_claims WHERE id = '$C_PAID';")" "5000000"

# The higher-rate claim is funded (profit reserved) before 0217, with payouts
# briefly off so funding stops at 'funded'. A monthly-rate request is left pending.
expect_ok "payouts paused by two admins" "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_update_settings '{"payouts_enabled": false, "note": "test"}')")"
recognize "$EV_RATE" "the rate event's profit is recognized"
expect_value "before 0217, the N75,000 claim is funded (N75,000 reserved)" "$(fund "$REP" "$C_RATE" 33333333-3333-3333-3333-333333333333)/$(val "SELECT reserved_kobo FROM public.earn_profit_pool;")" "funded/7500000"
expect_ok "payouts back on" "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_update_settings '{"payouts_enabled": true, "note": "test"}')")"
R_PEND=$(val "$(as "$ADMIN_A" "SELECT public.request_admin_action('earn_set_monthly_rate', 'vents_earn', '$REP', 'test', '{\"month\":\"$THIS\",\"reward_kobo\":9000000,\"reason\":\"filed before 0217\"}'::jsonb)->>'id';")")
expect_value "before 0217, a monthly-rate request could still be filed" "$(val "SELECT status FROM public.admin_action_requests WHERE id = '$R_PEND';")" "pending"

echo "== Applying 0217 (fixed N50,000, no monthly uplift) =="
STATE17_SQL="SELECT md5(string_agg(p.proname || ':' || p.prosrc, '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT string_agg(conname || ':' || convalidated || ':' || md5(pg_get_constraintdef(oid)), ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.representative_reward_claims'::regclass) || '/' || COALESCE((SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.representative_monthly_rates'::regclass AND NOT tgisinternal), '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
ROWS17_SQL="SELECT md5(COALESCE((SELECT string_agg(c::text, '|' ORDER BY c.id) FROM public.representative_reward_claims c), '')) || '/' || md5(COALESCE((SELECT string_agg(r::text, '|' ORDER BY r.id) FROM public.representative_monthly_rates r), '')) || '/' || md5(COALESCE((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM public.organizer_transactions t), '')) || '/' || md5(COALESCE((SELECT string_agg(l::text, '|' ORDER BY l.id) FROM public.earn_profit_ledger l), '')) || '/' || md5(COALESCE((SELECT string_agg(a::text, '|' ORDER BY a.id) FROM public.earn_audit_log a), ''));"
PRE_0217=$(val "$STATE17_SQL"); PRE_ROWS_0217=$(val "$ROWS17_SQL")
if "${PSQL[@]}" -f "$MIG/0217_representative_reward_fixed_50000.sql" >"$OUT" 2>"$ERR"; then pass "0217 applies on top of 0216"; else fail "0217 applies"; cat "$ERR" >&2; fi
expect_value "0217 reports the history it keeps: 1 rate row, 1 held claim above N50,000, 0 paid above N50,000, 1 pending rate request" \
  "$(grep -c "1 monthly rate row(s) kept as history; 1 approved/funded claim(s) above N50,000 now on hold; 0 credited claim(s) above N50,000 left as paid history; 1 pending monthly-rate request(s)" "$ERR")" "1"
expect_value "applying 0217 changed no claim, rate, ledger, profit-ledger or audit row" "$(val "$ROWS17_SQL")" "$PRE_ROWS_0217"
expect_ok "undo_0217 runs" "SET vents.rollback_confirm = 'undo-0217'; $(cat "$REPO_ROOT/supabase/rollback/undo_0217.sql")"
expect_value "undo_0217 restores every function, claim constraint and rate-table trigger exactly" "$(val "$STATE17_SQL")" "$PRE_0217"
expect_value "... and changed no row" "$(val "$ROWS17_SQL")" "$PRE_ROWS_0217"
expect_error "undo_0217 refuses without the confirmation" "undo-0217" "$(cat "$REPO_ROOT/supabase/rollback/undo_0217.sql")"
expect_ok "0217 re-applies after the undo" "$(cat "$MIG/0217_representative_reward_fixed_50000.sql")"
expect_ok "0217 is idempotent (second run)" "$(cat "$MIG/0217_representative_reward_fixed_50000.sql")"
expect_value "0217 markers: rate function, executor and claim; request_admin_action no longer lists the type" \
  "$(val "SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%[0217]%';")/$(val "SELECT position('earn_set_monthly_rate' IN pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure)) = 0;")" \
  "claim_representative_reward,earn_execute_admin_action,representative_reward_rate_kobo/t"

echo "== The reward is exactly N50,000 (0217) =="
expect_value "the rate function returns N50,000 even for a month with a (historical) higher rate row" \
  "$(val "SELECT public.representative_reward_rate_kobo('$REP', '$RM');")/$(val "SELECT reward_kobo FROM public.representative_monthly_rates WHERE representative_id = '$REP' AND month = '$RM';")" "5000000/7500000"
expect_ok "a new paid-event claim in that same month is submitted" "$(submit "$REP" "$ORG_FIX" "$EV_FIX")"
C_FIX=$(claim_of "$ORG_FIX"); confirm_claim "$ORG_FIX" "$C_FIX"
expect_value "... at exactly N50,000" "$(val "SELECT amount_kobo FROM public.representative_reward_claims WHERE id = '$C_FIX';")" "5000000"
expect_ok "two admins approve it, the request naming a higher amount (ignored)" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_approve_reward "{\"claim_id\":\"$C_FIX\",\"event_verified\":true,\"amount_kobo\":9000000,\"reward_kobo\":9000000}")")"
expect_value "approved at exactly N50,000" "$(status_of "$C_FIX")/$(val "SELECT amount_kobo FROM public.representative_reward_claims WHERE id = '$C_FIX';")" "approved/5000000"
expect_error "an admin can no longer file a monthly-rate request" "Unknown action_type" \
  "$(as "$ADMIN_A" "SELECT public.request_admin_action('earn_set_monthly_rate', 'vents_earn', '$REP', 'test', '{\"month\":\"$THIS\",\"reward_kobo\":9000000,\"reason\":\"x\"}'::jsonb);")"
expect_error "a monthly-rate request filed before 0217 cannot be approved" "monthly rates are discontinued" "$(approve "$ADMIN_B" "$R_PEND")"
expect_value "... it stays pending and no rate was set" \
  "$(val "SELECT status FROM public.admin_action_requests WHERE id = '$R_PEND';")/$(val "SELECT count(*) FROM public.representative_monthly_rates;")" "pending/1"
expect_error "no direct write can add a monthly rate" "monthly rates are discontinued" \
  "INSERT INTO public.representative_monthly_rates (representative_id, month, reward_kobo, basis_month_count, reason, requested_by, approved_by) VALUES ('$REP', '$THIS', 9000000, 9, 'x', '$ADMIN_A', '$ADMIN_C');"
expect_error "... or change one" "monthly rates are discontinued" "UPDATE public.representative_monthly_rates SET reward_kobo = 9000000;"
expect_error "... or delete the history" "monthly rates are discontinued" "DELETE FROM public.representative_monthly_rates;"
expect_error "... or truncate it" "monthly rates are discontinued" "TRUNCATE public.representative_monthly_rates;"
expect_error "the N50,000 base itself cannot be changed" "check constraint" "UPDATE public.earn_settings SET base_reward_kobo = 9000000;"
expect_error "the table refuses an approved claim at any other amount" "representative_reward_claims_fixed_amount" \
  "UPDATE public.representative_reward_claims SET amount_kobo = 9000000 WHERE id = '$C_FIX';"
expect_value "the representative's dashboards show N50,000 (current rate and every month)" \
  "$(val "$(as "$REP" "SELECT public.get_my_representative_rewards()->>'current_rate_kobo';")")/$(val "$(as "$REP" "SELECT string_agg(DISTINCT m->>'rate_kobo', ',') FROM jsonb_array_elements(public.get_my_representative_performance()->'months') m;")")" "5000000/5000000"

echo "== A claim approved and funded at a higher rate before 0217: held, never rewritten, reversed with its reservation released =="
expect_error "crediting it is refused" "not the fixed N50,000" "$(as "$REP" "SELECT public.claim_representative_reward('$C_RATE', gen_random_uuid());")"
expect_value "its recorded amount is not rewritten" "$(status_of "$C_RATE")/$(val "SELECT amount_kobo FROM public.representative_reward_claims WHERE id = '$C_RATE';")" "funded/7500000"
POOL_R=$(pool)
expect_ok "admins reverse it through dual control (the fixed-amount CHECK allows leaving the funded state)" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_reverse_reward "{\"claim_id\":\"$C_RATE\",\"reason\":\"reward is fixed at N50,000\"}")")"
expect_value "reversed; the full N75,000 reservation is released, nothing stranded, nothing credited" \
  "$(status_of "$C_RATE")/$(pool)/$(val "SELECT string_agg(entry_type, ',' ORDER BY created_at) FROM public.earn_profit_ledger WHERE claim_id = '$C_RATE';")/$(val "SELECT count(*) FROM public.organizer_transactions WHERE metadata->>'representative_reward_claim_id' = '$C_RATE';")" \
  "reversed/$(echo "$POOL_R" | awk -F/ '{print $1+7500000 "/" $2-7500000 "/" $3}')/reservation,release/0"
expect_value "the audit trail records the approval at N75,000 and the reversal (history kept)" \
  "$(val "SELECT string_agg(action, ',' ORDER BY created_at) FROM public.earn_audit_log WHERE entity_id = '$C_RATE' AND action IN ('admin_approved', 'admin_reversed');")" "admin_approved,admin_reversed"
expect_value "the fixed N50,000 reward is credited to the earnings wallet, exactly once" \
  "$(fund "$REP" "$C_FIX" 44444444-4444-4444-4444-444444444444)/$(fund "$REP" "$C_FIX" 44444444-4444-4444-4444-444444444444)/$(val "SELECT count(*) || '/' || sum(amount_kobo) FROM public.organizer_transactions WHERE type = 'representative_reward' AND metadata->>'representative_reward_claim_id' = '$C_FIX';")" \
  "credited/credited/1/5000000"

echo "== Totals =="
expect_value "the representative earned exactly three N50,000 rewards: three ledger rows of N50,000, N150,000, VENTS Wallet untouched" \
  "$(reward_rows "$REP")/$(val "SELECT string_agg(DISTINCT amount_kobo::text, ',') FROM public.organizer_transactions WHERE type = 'representative_reward';")/$(earnings "$REP")/$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$REP';")" "3/5000000/15000000/15000000/10000"
expect_value "no reward ever reached any spend-only VENTS Wallet" "$(val "SELECT count(*) FROM public.user_wallet_transactions;")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES REPRESENTATIVE REWARD INTEGRITY (0216 + 0217) CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
