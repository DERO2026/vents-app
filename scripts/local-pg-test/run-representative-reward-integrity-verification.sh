#!/usr/bin/env bash
# Real-execution verification of migration 0216 (Batch 1: representative
# reward integrity) on top of the full 0201 -> 0210 stack.
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
ORGS=("$ORG_PAID" "$ORG_FREE" "$ORG_DRAFT" "$ORG_DEL" "$ORG_LEGACY" "$ORG_AFTER" "$ORG_RACE")
EV_PAID="00000000-0000-0000-0000-00000000e001"; EV_PAID_2="00000000-0000-0000-0000-00000000e002"
EV_FREE="00000000-0000-0000-0000-00000000e003"; EV_DRAFT="00000000-0000-0000-0000-00000000e004"
EV_DEL="00000000-0000-0000-0000-00000000e005"; EV_LEGACY="00000000-0000-0000-0000-00000000e006"
EV_AFTER="00000000-0000-0000-0000-00000000e007"; EV_RACE="00000000-0000-0000-0000-00000000e008"
LEGACY_CLAIM="00000000-0000-0000-0000-00000000c001"

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
    FROM unnest(ARRAY['${ORGS[0]}', '${ORGS[1]}', '${ORGS[2]}', '${ORGS[3]}', '${ORGS[4]}', '${ORGS[5]}', '${ORGS[6]}']::uuid[]) u;
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
UPDATE public.users SET is_organizer = true, is_verified = true
 WHERE id IN ('${ORGS[0]}', '${ORGS[1]}', '${ORGS[2]}', '${ORGS[3]}', '${ORGS[4]}', '${ORGS[5]}', '${ORGS[6]}');
INSERT INTO public.organizer_verification_requests (user_id, status)
  SELECT u, 'approved' FROM unnest(ARRAY['${ORGS[0]}', '${ORGS[1]}', '${ORGS[2]}', '${ORGS[3]}', '${ORGS[4]}', '${ORGS[5]}', '${ORGS[6]}']::uuid[]) u;
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EV_PAID',   '$ORG_PAID',   'Paid concert',   now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_PAID_2', '$ORG_PAID',   'Second concert', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_FREE',   '$ORG_FREE',   'Free meetup',    now() + interval '30 days', 'live', '[{"name": "Free", "price": 0}]'),
  ('$EV_DRAFT',  '$ORG_DRAFT',  'Taken down',     now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_DEL',    '$ORG_DEL',    'Deleted',        now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_LEGACY', '$ORG_LEGACY', 'Old free night', now() + interval '30 days', 'live', '[{"name": "Free", "price": 0}]'),
  ('$EV_AFTER',  '$ORG_AFTER',  'Later cancelled', now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]'),
  ('$EV_RACE',   '$ORG_RACE',   'Race night',     now() + interval '30 days', 'live', '[{"name": "Regular", "price": 1000000}]');
SQL
for e in "$EV_PAID" "$EV_PAID_2" "$EV_DRAFT" "$EV_DEL" "$EV_AFTER" "$EV_RACE"; do buy_one "$e"; done
for e in "$EV_PAID" "$EV_PAID_2" "$EV_FREE" "$EV_DRAFT" "$EV_DEL" "$EV_LEGACY" "$EV_AFTER" "$EV_RACE"; do end_event "$e"; done
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
STATE_SQL="SELECT md5(string_agg(p.proname || ':' || p.prosrc, '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conname LIKE 'representative_reward_claims_free%') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
PRE_0216=$(val "$STATE_SQL")
if "${PSQL[@]}" -f "$MIG/0216_representative_rewards_free_events_never_qualify.sql" >"$OUT" 2>"$ERR"; then pass "0216 applies on top of 0201-0210"; else fail "0216 applies"; cat "$ERR" >&2; fi
expect_value "0216 reports the pre-existing free-event approval for admin follow-up (and changes no row)" \
  "$(grep -c "1 free-event reward claim(s) are approved" "$ERR")/$(status_of "$LEGACY_CLAIM")" "1/approved"
expect_ok "undo_0216 runs" "SET vents.rollback_confirm = 'undo-0216'; $(cat "$REPO_ROOT/supabase/rollback/undo_0216.sql")"
expect_value "undo_0216 restores every function and the old CHECK exactly" "$(val "$STATE_SQL")" "$PRE_0216"
expect_error "undo_0216 refuses without the confirmation" "undo-0216" "$(cat "$REPO_ROOT/supabase/rollback/undo_0216.sql")"
expect_ok "0216 re-applies after the undo" "$(cat "$MIG/0216_representative_rewards_free_events_never_qualify.sql")"
expect_ok "0216 is idempotent (second run)" "$(cat "$MIG/0216_representative_rewards_free_events_never_qualify.sql")"
expect_value "two functions carry the 0216 patch; the old free-event override text is gone" \
  "$(val "SELECT count(*) FILTER (WHERE prosrc LIKE '%[0216]%') || '/' || count(*) FILTER (WHERE prosrc LIKE '%must be explicitly verified as genuine%') FROM pg_proc WHERE pronamespace = 'public'::regnamespace;")" "2/0"
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
expect_error "the organizer takes the event off live: not credited" "was cancelled, deleted or hidden" "$(as "$REP" "SELECT public.claim_representative_reward('$C_AFTER', gen_random_uuid());")"
"${PSQL[@]}" -q -c "UPDATE public.events SET status = 'live', deleted_at = now() WHERE id = '$EV_AFTER';"
expect_error "the event is deleted: not credited" "was cancelled, deleted or hidden" "$(as "$REP" "SELECT public.claim_representative_reward('$C_AFTER', gen_random_uuid());")"
"${PSQL[@]}" -q -c "UPDATE public.events SET deleted_at = NULL, hidden_by_admin = true WHERE id = '$EV_AFTER';"
expect_error "an admin hides the event: not credited" "was cancelled, deleted or hidden" "$(as "$REP" "SELECT public.claim_representative_reward('$C_AFTER', gen_random_uuid());")"
expect_value "the claim stays approved for admin review; no money moved and nothing reserved" \
  "$(status_of "$C_AFTER")/$(earnings "$REP")/$(val "SELECT count(*) FROM public.earn_profit_ledger WHERE claim_id = '$C_AFTER';")" "approved/10000000/10000000/0"
expect_ok "admins can still reject it through dual control" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_reject_reward "{\"claim_id\":\"$C_AFTER\",\"reason\":\"event cancelled\"}")")"
expect_value "rejected" "$(status_of "$C_AFTER")" "rejected"

echo "== A free-event reward approved before 0216 can no longer be credited =="
"${PSQL[@]}" -q -c "ALTER TABLE public.representative_reward_claims DISABLE TRIGGER USER;
  ALTER TABLE public.representative_reward_claims DROP CONSTRAINT representative_reward_claims_free_never_qualifies;
  UPDATE public.representative_reward_claims SET status = 'approved', rejected_at = NULL, decision_reason = NULL WHERE id = '$LEGACY_CLAIM';
  ALTER TABLE public.representative_reward_claims ADD CONSTRAINT representative_reward_claims_free_never_qualifies
    CHECK (status NOT IN ('approved', 'funded', 'credited') OR NOT is_free_event) NOT VALID;
  ALTER TABLE public.representative_reward_claims ENABLE TRIGGER USER;"
expect_error "claiming the legacy free-event reward is refused" "Free events never qualify" "$(as "$REP" "SELECT public.claim_representative_reward('$LEGACY_CLAIM', gen_random_uuid());")"
expect_value "nothing credited, nothing reserved for it" "$(earnings "$REP")/$(val "SELECT count(*) FROM public.earn_profit_ledger WHERE claim_id = '$LEGACY_CLAIM';")" "10000000/10000000/0"
expect_ok "admins can reverse or reject it through dual control (the CHECK allows leaving the approved state)" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_reject_reward "{\"claim_id\":\"$LEGACY_CLAIM\",\"reason\":\"free events never qualify\"}")")"
expect_value "rejected" "$(status_of "$LEGACY_CLAIM")" "rejected"

echo "== Totals =="
expect_value "the representative earned exactly two N50,000 rewards: two ledger rows, N100,000, VENTS Wallet untouched" \
  "$(reward_rows "$REP")/$(earnings "$REP")/$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$REP';")" "2/10000000/10000000/10000"
expect_value "no reward ever reached any spend-only VENTS Wallet" "$(val "SELECT count(*) FROM public.user_wallet_transactions;")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES REPRESENTATIVE REWARD INTEGRITY (0216) CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
