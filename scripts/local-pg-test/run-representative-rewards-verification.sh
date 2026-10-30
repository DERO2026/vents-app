#!/usr/bin/env bash
# Real-execution verification for migration 0201 (VENTS Earn representative
# rewards, realized-profit pool, expenses, audit trail).
#
# Applies schema-vents-earn.sql + 0193/0196/0197 + schema-representative-
# rewards.sql (which carries verbatim copies of the LIVE request_admin_action
# / approve_admin_action) and then 0201, to a throwaway local database, and
# calls the real functions as different users (auth.uid() reads the
# test.uid GUC; client calls run under SET ROLE authenticated / anon).
# Never touches the real Supabase project.
#
# Usage: scripts/local-pg-test/run-representative-rewards-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$(cd "$SCRIPT_DIR/../.." && pwd)/supabase/migrations"
DB_NAME="vents_local_pg_rep_rewards_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")
OUT=$(mktemp); ERR=$(mktemp)
trap 'rm -f "$OUT" "$ERR"' EXIT

REP="00000000-0000-0000-0000-00000000c001"
REP2="00000000-0000-0000-0000-00000000c002"
ADMIN_REP="00000000-0000-0000-0000-00000000c003"
ORG="00000000-0000-0000-0000-00000000c011"
ORG2="00000000-0000-0000-0000-00000000c012"
ORG3="00000000-0000-0000-0000-00000000c013"
ORG_FREE="00000000-0000-0000-0000-00000000c014"
ORG_PRE="00000000-0000-0000-0000-00000000c015"
ADMIN_A="00000000-0000-0000-0000-00000000c021"
ADMIN_B="00000000-0000-0000-0000-00000000c022"
SUB="00000000-0000-0000-0000-00000000c023"
OTHER="00000000-0000-0000-0000-00000000c031"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }

# as <uid> <sql>: run <sql> as an authenticated client
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }

expect_error() {
  local label="$1" expected="$2" sql="$3"
  if "${PSQL[@]}" -c "$sql" >"$OUT" 2>"$ERR"; then
    fail "$label (expected an exception, call succeeded)"; return
  fi
  if grep -q -- "$expected" "$ERR"; then pass "$label"; else fail "$label (wrong error)"; cat "$ERR" >&2; fi
}
expect_ok() {
  local label="$1" sql="$2"
  if "${PSQL[@]}" -c "$sql" >"$OUT" 2>"$ERR"; then pass "$label"; else fail "$label"; cat "$ERR" >&2; fi
}
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; cat "$ERR" >&2; fi
}
# request <admin> <action_type> <target_id|NULL> <payload json> -> request id
request() {
  val "SET test.uid='$1'; SET ROLE authenticated; SELECT public.request_admin_action('$2', 'vents_earn', $3, 'test', '$4'::jsonb)->>'id';"
}
approve() { as "$1" "SELECT public.approve_admin_action('$2');"; }
claim_id_for() { val "SELECT id FROM public.representative_reward_claims WHERE organizer_id = '$1' AND status <> 'rejected';"; }
pool() { val "SELECT available_kobo || '/' || reserved_kobo || '/' || credited_kobo FROM public.earn_profit_pool;"; }

echo "== Building throwaway database $DB_NAME =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null

"${PSQL[@]}" -q <<SQL
INSERT INTO public.users (id, role, is_organizer, full_name) VALUES
  ('$REP', 'user', false, 'Rep One'), ('$REP2', 'user', false, 'Rep Two'),
  ('$ADMIN_REP', 'admin', false, 'Admin Rep'),
  ('$ORG', 'user', true, 'Org One'), ('$ORG2', 'user', true, 'Org Two'), ('$ORG3', 'user', true, 'Org Three'),
  ('$ORG_FREE', 'user', true, 'Org Free'), ('$ORG_PRE', 'user', true, 'Org Pre'),
  ('$ADMIN_A', 'admin', false, 'Admin A'), ('$ADMIN_B', 'admin', false, 'Admin B'),
  ('$SUB', 'sub-admin', false, 'Sub'), ('$OTHER', 'user', false, 'Other');
-- Rule 4: rewards need an approved organizer verification. Every
-- organizer starts verified; the negative case is tested explicitly.
INSERT INTO public.organizer_verification_requests (user_id, status)
  SELECT id, 'approved' FROM public.users WHERE is_organizer;
UPDATE public.users SET is_verified = true WHERE is_organizer;  -- as admin_approve_organizer_verification does
SQL
for r in "$REP" "$REP2" "$ADMIN_REP"; do
  "${PSQL[@]}" -q -c "$(as "$r" "SELECT public.register_as_recruiter('R', NULL);")" >/dev/null
done

# Partnership that already exists in production before 0201 (backfill).
"${PSQL[@]}" -q -c "$(as "$REP" "SELECT public.invite_recruiter_partnership('$ORG_PRE', NULL, 10000);")" >/dev/null
P=$(val "SELECT id FROM public.recruiter_partnerships WHERE organizer_id = '$ORG_PRE';")
"${PSQL[@]}" -q -c "$(as "$ORG_PRE" "SELECT public.respond_to_recruiter_invitation('$P', true);")" >/dev/null

echo "== Applying 0201 =="
"${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
pass "0201 applies cleanly on top of the live maker-checker definitions"
expect_ok "0201 is idempotent for the maker-checker patch (re-running the patch block is a no-op)" \
  "$(sed -n '/^DO \$patch\$/,/^\$patch\$;/p' "$MIG/0201_vents_earn_representative_rewards.sql")"

echo "== Backfill, legacy snapshot and patch =="
expect_value "existing accepted partnership was backfilled as an attribution" \
  "$(val "SELECT representative_id FROM public.representative_attributions WHERE organizer_id = '$ORG_PRE';")" "$REP"
expect_value "legacy 10% snapshot recorded zero accrued and zero paid" \
  "$(val "SELECT (details->>'commission_accrued_kobo') || '/' || (details->>'commission_paid_kobo') || '/' || (details->>'accepted_partnerships') FROM public.earn_audit_log WHERE action = 'legacy_commission_snapshot';")" "0/0/1"
expect_value "approve_admin_action now dispatches earn_* (and kept every live executor)" \
  "$(val "SELECT (pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure) LIKE '%earn_execute_admin_action%')::text || '/' || (pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure) LIKE '%toggle_event_trending%')::text;")" "true/true"
expect_error "request_admin_action still rejects unknown action types" "Unknown action_type" \
  "$(as "$ADMIN_A" "SELECT public.request_admin_action('earn_make_me_rich', 'x', NULL, 'x', '{}'::jsonb);")"
expect_value "payouts ship disabled and the programme ships closed" \
  "$(val "SELECT payouts_enabled::text || '/' || legacy_commission_reconciled::text FROM public.earn_settings;")" "false/false"

echo "== Retired 10% commission: history kept, nothing active =="
expect_value "a pre-0201 partnership keeps its legacy commission_split_bps (reconciliation evidence)" \
  "$(val "SELECT commission_split_bps FROM public.recruiter_partnerships WHERE organizer_id = '$ORG_PRE';")" "10000"
expect_value "the legacy snapshot records the split values that existed before 0201" \
  "$(val "SELECT details->'partnerships_by_commission_split_bps'->>'10000' FROM public.earn_audit_log WHERE action = 'legacy_commission_snapshot';")" "1"
expect_value "a notification sent before 0201 is left exactly as written (history)" \
  "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG_PRE' AND body LIKE '%share part of their commission%';")" "1"
expect_value "the dual-admin legacy reconciliation gate is still closed" \
  "$(val "SELECT legacy_commission_reconciled::text FROM public.earn_settings;")" "false"
expect_value "no database function except the reconciliation gate and snapshot references commission" \
  "$(val "SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosrc ILIKE '%commission%';")" \
  "claim_representative_reward,earn_execute_admin_action,get_my_representative_rewards"

echo "== Attribution =="
# An installed app that still sends the old 10000 split value.
expect_ok "an invitation that still sends the old split value is accepted" \
  "$(as "$REP" "SELECT public.invite_recruiter_partnership('$ORG', NULL, 10000);")"
P=$(val "SELECT id FROM public.recruiter_partnerships WHERE organizer_id = '$ORG' AND recruiter_id = '$REP';")
expect_value "the old split value is ignored: nothing commission-related is stored" \
  "$(val "SELECT COALESCE(commission_split_bps::text, 'null') FROM public.recruiter_partnerships WHERE id = '$P';")" "null"
expect_ok "organizer accepts the representative" "$(as "$ORG" "SELECT public.respond_to_recruiter_invitation('$P', true);")"
expect_value "acceptance attributes the organizer to the representative" \
  "$(val "SELECT representative_id FROM public.representative_attributions WHERE organizer_id = '$ORG';")" "$REP"
# The current app sends no split value at all.
expect_ok "an invitation with no split value is accepted" \
  "$(as "$REP2" "SELECT public.invite_recruiter_partnership('$ORG', NULL);")"
P2=$(val "SELECT id FROM public.recruiter_partnerships WHERE organizer_id = '$ORG' AND recruiter_id = '$REP2';")
expect_value "a new invitation stores no commission split" \
  "$(val "SELECT COALESCE(commission_split_bps::text, 'null') FROM public.recruiter_partnerships WHERE id = '$P2';")" "null"
expect_value "invitations no longer promise commission sharing (body and push data)" \
  "$(val "SELECT count(*) FROM public.notifications WHERE push_data->>'partnershipId' IN ('$P', '$P2') AND (body ILIKE '%commission%' OR push_data ? 'commissionSplitBps');")" "0"
expect_value "invitations use the fixed-reward wording" \
  "$(val "SELECT count(*) FROM public.notifications WHERE push_data->>'partnershipId' IN ('$P', '$P2') AND body = 'A VENTS representative wants to partner with you. VENTS rewards representatives directly; nothing is shared from or deducted from your earnings.';")" "2"
expect_value "invitation push data carries only the partnership and the representative" \
  "$(val "SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM public.notifications, jsonb_object_keys(push_data) k WHERE push_data->>'partnershipId' IN ('$P', '$P2');")" "partnershipId,recruiterId"
expect_ok "organizer also accepts a second representative" "$(as "$ORG" "SELECT public.respond_to_recruiter_invitation('$P2', true);")"
expect_value "duplicate attribution blocked: still the first representative, one row" \
  "$(val "SELECT count(*) || '/' || max(representative_id::text) FROM public.representative_attributions WHERE organizer_id = '$ORG';")" "1/$REP"
expect_value "duplicate attempt is in the audit trail" \
  "$(val "SELECT count(*) FROM public.earn_audit_log WHERE action = 'duplicate_attribution_blocked' AND subject_user_id = '$ORG';")" "1"
expect_error "self-attribution is impossible even for a direct write" "representative_attributions_no_self" \
  "INSERT INTO public.representative_attributions (representative_id, organizer_id, partnership_id) VALUES ('$REP', '$REP', '$P');"
expect_ok "revoking the partnership" "$(as "$REP" "SELECT public.revoke_recruiter_partnership('$P');")"
expect_value "attribution (referral history) survives the revoke" \
  "$(val "SELECT count(*) FROM public.representative_attributions WHERE organizer_id = '$ORG';")" "1"

for pair in "$REP2:$ORG2" "$ADMIN_REP:$ORG3" "$REP:$ORG_FREE"; do
  r=${pair%%:*}; o=${pair##*:}
  "${PSQL[@]}" -q -c "$(as "$r" "SELECT public.invite_recruiter_partnership('$o', NULL, 10000);")" >/dev/null
  pp=$(val "SELECT id FROM public.recruiter_partnerships WHERE organizer_id = '$o' AND recruiter_id = '$r';")
  "${PSQL[@]}" -q -c "$(as "$o" "SELECT public.respond_to_recruiter_invitation('$pp', true);")" >/dev/null
done

echo "== Events =="
"${PSQL[@]}" -q <<SQL
INSERT INTO public.events (id, organizer_id, title, event_date, end_date, created_at) VALUES
  ('00000000-0000-0000-0000-0000000e0001', '$ORG', 'Over and settled', now() - interval '31 days', now() - interval '30 days', now()),
  ('00000000-0000-0000-0000-0000000e0002', '$ORG', 'Future', now() + interval '5 days', NULL, now()),
  ('00000000-0000-0000-0000-0000000e0003', '$ORG', 'Just ended', now() - interval '2 days', now() - interval '2 days', now()),
  ('00000000-0000-0000-0000-0000000e0004', '$ORG', 'Pending refund', now() - interval '30 days', NULL, now()),
  ('00000000-0000-0000-0000-0000000e0005', '$ORG', 'Before referral', now() - interval '60 days', NULL, now() - interval '90 days'),
  ('00000000-0000-0000-0000-0000000e0006', '$ORG', 'Deleted', now() - interval '30 days', NULL, now()),
  ('00000000-0000-0000-0000-0000000e0007', '$ORG2', 'Org2 event', now() - interval '30 days', NULL, now()),
  ('00000000-0000-0000-0000-0000000e0008', '$ORG3', 'Org3 event', now() - interval '30 days', NULL, now()),
  ('00000000-0000-0000-0000-0000000e0009', '$ORG_FREE', 'Free meetup', now() - interval '30 days', NULL, now()),
  ('00000000-0000-0000-0000-0000000e0010', '$ORG', 'Pending payment', now() - interval '30 days', NULL, now());
UPDATE public.events SET deleted_at = now() WHERE id = '00000000-0000-0000-0000-0000000e0006';
INSERT INTO public.tickets (id, event_id, amount, payment_status) VALUES
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000e0001', 10000, 'paid'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-0000000e0001', 10000, 'paid'),
  ('00000000-0000-0000-0000-0000000f0003', '00000000-0000-0000-0000-0000000e0001', 10000, 'refunded'),
  ('00000000-0000-0000-0000-0000000f0004', '00000000-0000-0000-0000-0000000e0004', 5000, 'refund_pending'),
  ('00000000-0000-0000-0000-0000000f0005', '00000000-0000-0000-0000-0000000e0007', 20000, 'paid'),
  ('00000000-0000-0000-0000-0000000f0006', '00000000-0000-0000-0000-0000000e0008', 20000, 'paid'),
  ('00000000-0000-0000-0000-0000000f0007', '00000000-0000-0000-0000-0000000e0010', 20000, 'pending');
-- Recorded buyer fees (organizer_transactions credit metadata), per order.
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, ticket_sale_id, metadata) VALUES
  ('$ORG',  'credit', 2000000, '00000000-0000-0000-0000-0000000f0001', '{"buyer_fee_kobo": 6000000}'),
  ('$ORG2', 'credit', 2000000, '00000000-0000-0000-0000-0000000f0005', '{"buyer_fee_kobo": 5000000}'),
  ('$ORG3', 'credit', 2000000, '00000000-0000-0000-0000-0000000f0006', '{"buyer_fee_kobo": 5000000}');
SQL

echo "== Event eligibility =="
elig() { val "SELECT public.earn_event_eligibility('$1')->>'$2';"; }
expect_value "future event is not over" "$(elig 00000000-0000-0000-0000-0000000e0002 reasons)" '["event_not_over"]'
expect_value "just-ended event is inside the settlement hold" "$(elig 00000000-0000-0000-0000-0000000e0003 reasons)" '["settlement_hold"]'
expect_value "pending refund blocks" "$(elig 00000000-0000-0000-0000-0000000e0004 reasons)" '["pending_refunds"]'
expect_value "pending payment blocks" "$(elig 00000000-0000-0000-0000-0000000e0010 reasons)" '["pending_payments"]'
expect_value "deleted event is not eligible" "$(elig 00000000-0000-0000-0000-0000000e0006 eligible)" "false"
expect_value "fee candidate = recorded buyer fees - nominal 5% of the refunded ticket (never gross sales)" \
  "$(elig 00000000-0000-0000-0000-0000000e0001 fee_candidate_kobo)" "5950000"
expect_value "free event is flagged" "$(elig 00000000-0000-0000-0000-0000000e0009 is_free_event)" "true"
"${PSQL[@]}" -q -c "INSERT INTO public.pending_purchases (event_id) VALUES ('00000000-0000-0000-0000-0000000e0007');"
expect_value "a pending purchase blocks" "$(elig 00000000-0000-0000-0000-0000000e0007 reasons)" '["pending_purchases"]'
"${PSQL[@]}" -q -c "UPDATE public.pending_purchases SET status = 'completed';"

echo "== Claim submission =="
expect_error "a representative cannot claim an organizer attributed to someone else" "not attributed to you" \
  "$(as "$REP2" "SELECT public.submit_representative_reward_claim('$ORG', '00000000-0000-0000-0000-0000000e0001');")"
expect_error "a non-representative cannot claim" "active representative" \
  "$(as "$OTHER" "SELECT public.submit_representative_reward_claim('$ORG', '00000000-0000-0000-0000-0000000e0001');")"
expect_error "not-over event rejected" "event_not_over" \
  "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG', '00000000-0000-0000-0000-0000000e0002');")"
expect_error "event created before the referral rejected" "created before you referred" \
  "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG', '00000000-0000-0000-0000-0000000e0005');")"
expect_error "another organizer's event rejected" "does not belong" \
  "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG', '00000000-0000-0000-0000-0000000e0007');")"
expect_value "eligible event: claim created, waiting for the organizer" \
  "$(val "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG', '00000000-0000-0000-0000-0000000e0001')->>'status';")")" "pending_organizer"
expect_value "resubmitting the same claim is idempotent" \
  "$(val "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG', '00000000-0000-0000-0000-0000000e0001')->>'duplicate';")")" "true"
expect_error "one reward per organizer: a second event cannot be claimed" "already exists" \
  "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG', '00000000-0000-0000-0000-0000000e0004');")"
C1=$(claim_id_for "$ORG")
expect_error "clients cannot write claims directly" "permission denied" \
  "$(as "$REP" "UPDATE public.representative_reward_claims SET status = 'approved' WHERE id = '$C1';")"
expect_error "clients cannot read the profit pool" "permission denied" "$(as "$REP" "SELECT * FROM public.earn_profit_pool;")"
expect_error "clients cannot call the executor directly" "permission denied" \
  "$(as "$ADMIN_B" "SELECT public.earn_execute_admin_action(gen_random_uuid());")"
expect_error "clients cannot move pool money directly" "permission denied" \
  "$(as "$ADMIN_B" "SELECT public.earn_pool_move('recognition', 100, NULL, NULL, NULL);")"
expect_error "clients cannot read fee figures through the eligibility helper" "permission denied" \
  "$(as "$REP" "SELECT public.earn_event_eligibility('00000000-0000-0000-0000-0000000e0001');")"
expect_error "anon cannot call the representative read API" "permission denied" \
  "SET test.uid='$REP'; SET ROLE anon; SELECT public.get_my_representative_rewards();"

echo "== Organizer confirmation =="
expect_error "the representative cannot confirm their own claim" "Not authorized" \
  "$(as "$REP" "SELECT public.respond_to_representative_reward_claim('$C1', true);")"
expect_error "an unrelated user cannot confirm" "Not authorized" \
  "$(as "$OTHER" "SELECT public.respond_to_representative_reward_claim('$C1', true);")"
expect_ok "organizer confirms" "$(as "$ORG" "SELECT public.respond_to_representative_reward_claim('$C1', true);")"
expect_value "claim moves to VENTS review" "$(val "SELECT status FROM public.representative_reward_claims WHERE id = '$C1';")" "pending_review"

echo "== Admin approval (maker-checker) =="
# Values ::boolean would coerce ("t", "yes", "true") or that are not booleans
# at all. The executor must refuse every one of them (fail closed).
BAD_BOOLS=('"t"' '"yes"' '"true"' '"false"' '1' 'null' '[true]')
R=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C1\",\"event_verified\":true}")
expect_error "requester cannot approve their own request" "Cannot approve your own request" "$(approve "$ADMIN_A" "$R")"
expect_error "a sub-admin cannot approve" "Super Admin access required" "$(approve "$SUB" "$R")"
expect_error "approval blocked until the legacy 10% programme is reconciled" "Reconcile the legacy" "$(approve "$ADMIN_B" "$R")"
for b in "${BAD_BOOLS[@]}"; do
  RB=$(request "$ADMIN_A" earn_update_settings NULL "{\"legacy_commission_reconciled\": $b, \"note\": \"malformed\"}")
  expect_error "legacy_commission_reconciled = $b is refused" "legacy_commission_reconciled must be true or false" "$(approve "$ADMIN_B" "$RB")"
done
expect_value "malformed reconciliation requests changed nothing and stay pending" \
  "$(val "SELECT legacy_commission_reconciled::text FROM public.earn_settings;")/$(val "SELECT count(*) FROM public.admin_action_requests WHERE action_type = 'earn_update_settings' AND status = 'pending';")" "false/${#BAD_BOOLS[@]}"
RS=$(request "$ADMIN_A" earn_update_settings NULL '{"legacy_commission_reconciled": true, "note": "Both reps accepted the 50k model in writing"}')
expect_ok "reconciliation recorded through dual control" "$(approve "$ADMIN_B" "$RS")"
echo "== Rule 4: verified organizer and admin-verified event =="
RV=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C1\"}")
expect_error "approval without an explicit event verification is refused" "qualifying event must be verified" "$(approve "$ADMIN_B" "$RV")"
RV=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C1\",\"event_verified\":false}")
expect_error "event_verified = false is refused" "qualifying event must be verified" "$(approve "$ADMIN_B" "$RV")"
RV=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C1\",\"event_verified\":\"true\"}")
expect_error "event_verified as a string is refused" "event_verified must be true or false" "$(approve "$ADMIN_B" "$RV")"
"${PSQL[@]}" -q -c "UPDATE public.organizer_verification_requests SET status = 'rejected' WHERE user_id = '$ORG';" >/dev/null
RV=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C1\",\"event_verified\":true}")
expect_error "an organizer without an approved verification blocks the reward" "approved organizer verification" "$(approve "$ADMIN_B" "$RV")"
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_verification_requests (user_id, status) VALUES ('$ORG', 'pending');" >/dev/null
expect_error "a pending (not yet approved) verification still blocks it" "approved organizer verification" "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C1\",\"event_verified\":true}")")"
"${PSQL[@]}" -q -c "UPDATE public.organizer_verification_requests SET status = 'approved' WHERE user_id = '$ORG';" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.users SET is_verified = false WHERE id = '$ORG';" >/dev/null
expect_error "an approved request whose verification an admin later revoked (is_verified = false) blocks the reward" "approved organizer verification" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C1\",\"event_verified\":true}")")"
"${PSQL[@]}" -q -c "UPDATE public.users SET is_verified = true, is_organizer = false WHERE id = '$ORG';" >/dev/null
expect_error "an organizer whose organizer capability was removed does not qualify" "approved organizer verification" \
  "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C1\",\"event_verified\":true}")")"
"${PSQL[@]}" -q -c "UPDATE public.users SET is_organizer = true WHERE id = '$ORG';" >/dev/null
expect_value "refused approvals left the claim under review" "$(val "SELECT status FROM public.representative_reward_claims WHERE id = '$C1';")" "pending_review"
expect_ok "second admin approves the reward" "$(approve "$ADMIN_B" "$R")"
expect_value "approval records the event and organizer verification" \
  "$(val "SELECT event_verified::text || '/' || organizer_verified::text FROM public.representative_reward_claims WHERE id = '$C1';")" "true/true"
expect_value "claim approved at the base rate (₦50,000)" \
  "$(val "SELECT status || '/' || amount_kobo FROM public.representative_reward_claims WHERE id = '$C1';")" "approved/5000000"
expect_value "admin request marked approved" "$(val "SELECT status FROM public.admin_action_requests WHERE id = '$R';")" "approved"

# A representative who is also an admin.
"${PSQL[@]}" -q -c "$(as "$ADMIN_REP" "SELECT public.submit_representative_reward_claim('$ORG3', '00000000-0000-0000-0000-0000000e0008');")" >/dev/null
C3=$(claim_id_for "$ORG3")
"${PSQL[@]}" -q -c "$(as "$ORG3" "SELECT public.respond_to_representative_reward_claim('$C3', true);")" >/dev/null
R3=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C3\",\"event_verified\":true}")
expect_error "an admin who is the representative cannot approve their own reward" "cannot request or approve their own reward" "$(approve "$ADMIN_REP" "$R3")"
R3b=$(request "$ADMIN_REP" earn_approve_reward NULL "{\"claim_id\":\"$C3\",\"event_verified\":true}")
expect_error "an admin who is the representative cannot request approval of their own reward" "cannot request or approve their own reward" "$(approve "$ADMIN_B" "$R3b")"
expect_value "the representative-admin's claim is still under review" "$(val "SELECT status FROM public.representative_reward_claims WHERE id = '$C3';")" "pending_review"

echo "== Funding against realized profit =="
"${PSQL[@]}" -q -c "UPDATE public.users SET is_verified = false WHERE id = '$ORG';" >/dev/null
expect_error "a verification revoked by an admin (is_verified = false) after approval blocks the claim" "no longer verified" \
  "$(as "$REP" "SELECT public.claim_representative_reward('$C1', gen_random_uuid());")"
"${PSQL[@]}" -q -c "UPDATE public.users SET is_verified = true WHERE id = '$ORG';" >/dev/null
"${PSQL[@]}" -q -c "UPDATE public.organizer_verification_requests SET status = 'rejected' WHERE user_id = '$ORG';" >/dev/null
expect_error "a verification revoked after approval blocks the claim" "no longer verified" \
  "$(as "$REP" "SELECT public.claim_representative_reward('$C1', gen_random_uuid());")"
"${PSQL[@]}" -q -c "UPDATE public.organizer_verification_requests SET status = 'approved' WHERE user_id = '$ORG';" >/dev/null
expect_value "no realized profit: claim returns awaiting_profit, nothing reserved" \
  "$(val "$(as "$REP" "SELECT public.claim_representative_reward('$C1', '11111111-1111-1111-1111-111111111111')->>'status';")")" "awaiting_profit"
expect_value "pool untouched" "$(pool)" "0/0/0"
RP=$(request "$ADMIN_A" earn_recognize_event_profit NULL '{"event_id":"00000000-0000-0000-0000-0000000e0001","cost_deductions_kobo":9000000,"note":"x"}')
expect_error "costs cannot exceed the fee candidate" "Costs exceed" "$(approve "$ADMIN_B" "$RP")"
RP=$(request "$ADMIN_A" earn_recognize_event_profit NULL '{"event_id":"00000000-0000-0000-0000-0000000e0001","note":"x"}')
expect_error "costs must be stated explicitly" "cost_deductions_kobo must be stated" "$(approve "$ADMIN_B" "$RP")"
RP=$(request "$ADMIN_A" earn_recognize_event_profit NULL '{"event_id":"00000000-0000-0000-0000-0000000e0003","cost_deductions_kobo":0,"note":"x"}')
expect_error "an unsettled event cannot be recognized" "settlement_hold" "$(approve "$ADMIN_B" "$RP")"
RP=$(request "$ADMIN_A" earn_recognize_event_profit NULL '{"event_id":"00000000-0000-0000-0000-0000000e0001","cost_deductions_kobo":900000,"note":"Paystack fees and VC rewards for this event"}')
expect_ok "profit recognized for a settled event" "$(approve "$ADMIN_B" "$RP")"
expect_value "pool = candidate - stated costs" "$(pool)" "5050000/0/0"
RP2=$(request "$ADMIN_A" earn_recognize_event_profit NULL '{"event_id":"00000000-0000-0000-0000-0000000e0001","cost_deductions_kobo":0,"note":"again"}')
expect_error "the same event's profit cannot be recognized twice" "duplicate key" "$(approve "$ADMIN_B" "$RP2")"
expect_error "only the representative can claim their reward" "Not authorized" \
  "$(as "$ORG" "SELECT public.claim_representative_reward('$C1', gen_random_uuid());")"
expect_value "claim reserves profit (payouts still disabled, so it stays funded)" \
  "$(val "$(as "$REP" "SELECT public.claim_representative_reward('$C1', '22222222-2222-2222-2222-222222222222')->>'status';")")" "funded"
expect_value "pool: 50,000 kobo left available, ₦50,000 reserved" "$(pool)" "50000/5000000/0"
"${PSQL[@]}" -q -c "$(as "$REP" "SELECT public.claim_representative_reward('$C1', '22222222-2222-2222-2222-222222222222');")" >/dev/null
expect_value "retrying the claim does not reserve twice" \
  "$(val "SELECT count(*) FROM public.earn_profit_ledger WHERE claim_id = '$C1' AND entry_type = 'reservation';")/$(pool)" "1/50000/5000000/0"
expect_value "nothing reached the earnings wallet while payouts are disabled" \
  "$(val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'representative_reward';")/$(val "SELECT count(*) FROM public.organizer_wallets WHERE organizer_id = '$REP';")" "0/0"

echo "== Concurrency: two claims, profit for one =="
# ORG2 (REP2) and ORG3 (approved by two uninvolved admins) both approved;
# recognize exactly enough for one more reward.
"${PSQL[@]}" -q -c "$(as "$REP2" "SELECT public.submit_representative_reward_claim('$ORG2', '00000000-0000-0000-0000-0000000e0007');")" >/dev/null
C2=$(claim_id_for "$ORG2")
"${PSQL[@]}" -q -c "$(as "$ORG2" "SELECT public.respond_to_representative_reward_claim('$C2', true);")" >/dev/null
"${PSQL[@]}" -q -c "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$C2\",\"event_verified\":true}")")" >/dev/null
"${PSQL[@]}" -q -c "$(approve "$ADMIN_A" "$(request "$ADMIN_B" earn_approve_reward NULL "{\"claim_id\":\"$C3\",\"event_verified\":true}")")" >/dev/null
"${PSQL[@]}" -q -c "$(approve "$ADMIN_B" "$(request "$ADMIN_A" earn_recognize_event_profit NULL '{"event_id":"00000000-0000-0000-0000-0000000e0007","cost_deductions_kobo":50000,"note":"fees"}')")" >/dev/null
expect_value "pool before the race: exactly one reward available" "$(pool)" "5000000/5000000/0"
( "${PSQL[@]}" -tA -c "$(as "$REP2" "SELECT public.claim_representative_reward('$C2', gen_random_uuid())->>'status';")" | tail -n1 >"$OUT.a" ) &
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_REP" "SELECT public.claim_representative_reward('$C3', gen_random_uuid())->>'status';")" | tail -n1 >"$OUT.b" ) &
wait
expect_value "exactly one concurrent claim was funded, the other waits for profit" \
  "$(printf '%s\n%s\n' "$(cat "$OUT.a")" "$(cat "$OUT.b")" | sort | tr '\n' ' ')" "awaiting_profit funded "
expect_value "pool never overspent" "$(pool)" "0/10000000/0"
rm -f "$OUT.a" "$OUT.b"

echo "== Credit to the withdrawable earnings wallet =="
# The representative already holds VENTS Wallet money; it must never move.
"${PSQL[@]}" -q -c "INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$REP', 10000);"
earn() { val "SELECT balance_kobo || '/' || pending_kobo || '/' || total_withdrawn_kobo || '/' || total_earned_kobo FROM public.organizer_wallets WHERE organizer_id = '$1';"; }
for b in "${BAD_BOOLS[@]}"; do
  RB=$(request "$ADMIN_A" earn_update_settings NULL "{\"payouts_enabled\": $b, \"note\": \"malformed\"}")
  expect_error "payouts_enabled = $b is refused" "payouts_enabled must be true or false" "$(approve "$ADMIN_B" "$RB")"
done
RB=$(request "$ADMIN_A" earn_update_settings NULL '{"payouts_enabled": true, "legacy_commission_reconciled": "no", "note": "one bad flag"}')
expect_error "one malformed flag refuses the whole settings request" "legacy_commission_reconciled must be true or false" "$(approve "$ADMIN_B" "$RB")"
expect_value "reward credit is still off after every malformed request" \
  "$(val "SELECT payouts_enabled::text || '/' || legacy_commission_reconciled::text FROM public.earn_settings;")" "false/true"
RB=$(request "$ADMIN_A" earn_update_settings NULL '{"payouts_enabled": false, "note": "explicitly keep off"}')
expect_ok "payouts_enabled = false (a real boolean) is accepted" "$(approve "$ADMIN_B" "$RB")"
expect_value "payouts_enabled = false leaves reward credit off" \
  "$(val "SELECT payouts_enabled::text FROM public.earn_settings;")" "false"
# settlement_hold_days: only a JSON whole number 0..120.
hold() { val "SELECT settlement_hold_days FROM public.earn_settings;"; }
expect_value "settlement hold ships at the 7-day default" "$(hold)" "7"
BAD_HOLDS=('"7"' '"0"' '7.5' '7.0' '-1' '121' '1000000000000' 'true' 'null' '[7]' '{"days":7}')
for b in "${BAD_HOLDS[@]}"; do
  RB=$(request "$ADMIN_A" earn_update_settings NULL "{\"settlement_hold_days\": $b, \"note\": \"malformed\"}")
  expect_error "settlement_hold_days = $b is refused" "settlement_hold_days must be a whole number of days from 0 to 120" "$(approve "$ADMIN_B" "$RB")"
done
RB=$(request "$ADMIN_A" earn_update_settings NULL '{"payouts_enabled": true, "settlement_hold_days": "14", "note": "valid flag, bad hold"}')
expect_error "a bad hold refuses the whole request, valid flags included" "settlement_hold_days must be a whole number" "$(approve "$ADMIN_B" "$RB")"
expect_value "refused hold requests changed nothing (hold/payouts) and stay pending" \
  "$(hold)/$(val "SELECT payouts_enabled::text FROM public.earn_settings;")/$(val "SELECT status FROM public.admin_action_requests WHERE id = '$RB';")" "7/false/pending"
for h in 0 120 14; do
  RB=$(request "$ADMIN_A" earn_update_settings NULL "{\"settlement_hold_days\": $h, \"note\": \"hold $h\"}")
  expect_ok "settlement_hold_days = $h is accepted" "$(approve "$ADMIN_B" "$RB")"
  expect_value "settlement hold is now $h days" "$(hold)" "$h"
done
RB=$(request "$ADMIN_A" earn_update_settings NULL '{"payouts_enabled": false, "note": "no hold key"}')
expect_ok "a settings request without settlement_hold_days is accepted" "$(approve "$ADMIN_B" "$RB")"
expect_value "a missing settlement_hold_days keeps the current hold" "$(hold)" "14"
RB=$(request "$ADMIN_A" earn_update_settings NULL '{"settlement_hold_days": 7, "note": "back to the default"}')
expect_ok "settlement hold restored to 7 days" "$(approve "$ADMIN_B" "$RB")"
expect_value "settlement hold back at 7 days" "$(hold)" "7"
RE=$(request "$ADMIN_A" earn_update_settings NULL '{"payouts_enabled": true, "note": "Go-live approved by management"}')
expect_ok "reward credit enabled through dual control" "$(approve "$ADMIN_B" "$RE")"
expect_value "funded reward is credited" \
  "$(val "$(as "$REP" "SELECT public.claim_representative_reward('$C1', '22222222-2222-2222-2222-222222222222')->>'status';")")" "credited"
expect_value "earnings wallet: ₦50,000 available, nothing pending or withdrawn, ₦50,000 earned" "$(earn "$REP")" "5000000/0/0/5000000"
expect_value "exactly one representative_reward ledger row, linked from the claim" \
  "$(val "SELECT count(*) || '/' || bool_and(ot.id = c.earnings_transaction_id)::text FROM public.organizer_transactions ot JOIN public.representative_reward_claims c ON c.id = '$C1' WHERE ot.type = 'representative_reward' AND ot.organizer_id = '$REP';")" "1/true"
expect_value "the reward is not booked as ticket revenue ('credit')" \
  "$(val "SELECT count(*) FROM public.organizer_transactions WHERE organizer_id = '$REP' AND type = 'credit';")" "0"
expect_value "retrying after credit changes nothing" \
  "$(val "$(as "$REP" "SELECT public.claim_representative_reward('$C1', gen_random_uuid())->>'duplicate';")")/$(earn "$REP")" "true/5000000/0/0/5000000"
expect_error "the ledger itself refuses a second credit for the same claim" "organizer_transactions_rep_reward_once" \
  "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, metadata) VALUES ('$REP', 'representative_reward', 5000000, jsonb_build_object('representative_reward_claim_id', '$C1'));"
expect_error "a reward ledger row must name its claim" "organizer_transactions_rep_reward_has_claim" \
  "INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, metadata) VALUES ('$REP', 'representative_reward', 100, '{}'::jsonb);"
expect_value "VENTS Wallet untouched (balance and transactions)" \
  "$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$REP';")/$(val "SELECT count(*) FROM public.user_wallet_transactions;")" "10000/0"
expect_value "pool: reservation moved to credited" "$(pool)" "0/5000000/5000000"

echo "== Withdrawal through the existing payout flow =="
"${PSQL[@]}" -q -c "INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, account_number, account_name, recipient_code, is_default) VALUES ('00000000-0000-0000-0000-0000000ba001', '$REP', 'Test Bank', '0123456789', 'Rep One', 'RCP_test', true);"
BANK=00000000-0000-0000-0000-0000000ba001
WD=$(val "$(as "$REP" "SELECT public.request_organizer_payout(2000000, '$BANK', 'wd-key-1');")")
expect_value "withdrawal request moves ₦20,000 from available to pending" "$(earn "$REP")" "3000000/2000000/0/5000000"
expect_value "retrying the withdrawal with the same key returns the same request, no double hold" \
  "$(val "$(as "$REP" "SELECT (public.request_organizer_payout(2000000, '$BANK', 'wd-key-1') = '$WD')::text;")")/$(earn "$REP")" "true/3000000/2000000/0/5000000"
RV=$(request "$ADMIN_A" earn_reverse_reward NULL "{\"claim_id\":\"$C1\",\"reason\":\"Organizer was a duplicate account\"}")
expect_error "a reversal is refused when part of the reward is pending withdrawal" "does not cover the reversal" "$(approve "$ADMIN_B" "$RV")"
expect_value "the refused reversal changed nothing" \
  "$(val "SELECT status FROM public.representative_reward_claims WHERE id = '$C1';")/$(earn "$REP")/$(pool)" "credited/3000000/2000000/0/5000000/0/5000000/5000000"
expect_value "completing the payout marks it withdrawn" \
  "$(val "SELECT status FROM public.complete_organizer_payout('$WD');")/$(earn "$REP")" "completed/3000000/0/2000000/5000000"

echo "== Refund after recognition =="
"${PSQL[@]}" -q -c "UPDATE public.tickets SET payment_status = 'refunded' WHERE id = '00000000-0000-0000-0000-0000000f0002';"
"${PSQL[@]}" -q -c "UPDATE public.tickets SET payment_status = 'paid' WHERE id = '00000000-0000-0000-0000-0000000f0002';"
"${PSQL[@]}" -q -c "UPDATE public.tickets SET payment_status = 'refunded' WHERE id = '00000000-0000-0000-0000-0000000f0002';"
expect_value "a later refund takes its fee back out of the pool, once per ticket" \
  "$(pool)/$(val "SELECT count(*) FROM public.earn_profit_ledger WHERE entry_type = 'refund_adjustment';")" "-50000/5000000/5000000/1"

echo "== Reversal of an available reward =="
# Whichever claim won the concurrency race is funded; credit and reverse it.
W=$(val "SELECT id FROM public.representative_reward_claims WHERE id IN ('$C2', '$C3') AND status = 'funded';")
WR=$(val "SELECT representative_id FROM public.representative_reward_claims WHERE id = '$W';")
WO=$(val "SELECT organizer_id || '|' || event_id FROM public.representative_reward_claims WHERE id = '$W';")
expect_value "the race winner is credited to its own earnings wallet" \
  "$(val "$(as "$WR" "SELECT public.claim_representative_reward('$W', gen_random_uuid())->>'status';")")/$(earn "$WR")" "credited/5000000/0/0/5000000"
RV=$(request "$ADMIN_A" earn_reverse_reward NULL "{\"claim_id\":\"$W\",\"reason\":\"Referral was not genuine\"}")
expect_ok "credited reward reversed through dual control" "$(approve "$ADMIN_B" "$RV")"
expect_value "available balance and lifetime earned debited, one reversal row, money back in the pool" \
  "$(earn "$WR")/$(val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'representative_reward_reversal' AND organizer_id = '$WR';")/$(val "SELECT status FROM public.representative_reward_claims WHERE id = '$W';")/$(pool)" \
  "0/0/0/0/1/reversed/4950000/0/5000000"
RV=$(request "$ADMIN_A" earn_reverse_reward NULL "{\"claim_id\":\"$W\",\"reason\":\"again\"}")
expect_error "a reversed reward cannot be reversed again" "cannot be reversed" "$(approve "$ADMIN_B" "$RV")"
expect_value "a reversed organizer cannot be claimed again (same claim comes back, no new one)" \
  "$(val "$(as "$WR" "SELECT public.submit_representative_reward_claim('${WO%%|*}', '${WO##*|}')->>'status';")")/$(val "SELECT count(*) FROM public.representative_reward_claims WHERE organizer_id = '${WO%%|*}';")" "reversed/1"

echo "== Free events =="
"${PSQL[@]}" -q -c "$(as "$REP" "SELECT public.submit_representative_reward_claim('$ORG_FREE', '00000000-0000-0000-0000-0000000e0009');")" >/dev/null
CF=$(claim_id_for "$ORG_FREE")
"${PSQL[@]}" -q -c "$(as "$ORG_FREE" "SELECT public.respond_to_representative_reward_claim('$CF', true);")" >/dev/null
RF=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$CF\",\"event_verified\":true}")
expect_error "a free event needs explicit verification" "free event must be explicitly verified" "$(approve "$ADMIN_B" "$RF")"
for b in "${BAD_BOOLS[@]}"; do
  RB=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$CF\",\"event_verified\":true,\"free_event_verified\":$b}")
  expect_error "free_event_verified = $b is refused" "free_event_verified must be true or false" "$(approve "$ADMIN_B" "$RB")"
done
RB=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$CF\",\"event_verified\":true,\"free_event_verified\":false}")
expect_error "free_event_verified = false (a real boolean) still does not qualify a free event" "free event must be explicitly verified" "$(approve "$ADMIN_B" "$RB")"
expect_value "the free-event claim is still under review" "$(val "SELECT status FROM public.representative_reward_claims WHERE id = '$CF';")" "pending_review"
RF=$(request "$ADMIN_A" earn_approve_reward NULL "{\"claim_id\":\"$CF\",\"event_verified\":true,\"free_event_verified\":true}")
expect_ok "a verified free event qualifies" "$(approve "$ADMIN_B" "$RF")"

echo "== Monthly rate review =="
NEXT=$(val "SELECT (date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') + interval '1 month')::date;")
THIS=$(val "SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')::date;")
RM=$(request "$ADMIN_A" earn_set_monthly_rate "'$REP'" "{\"month\":\"$NEXT\",\"reward_kobo\":7500000,\"reason\":\"strong month\"}")
expect_error "no higher rate below 9 qualifying organizers" "are required" "$(approve "$ADMIN_B" "$RM")"
"${PSQL[@]}" -q <<SQL
DO \$\$
DECLARE i int; v_org uuid; v_ev uuid; v_att uuid;
BEGIN
  FOR i IN 1..9 LOOP
    v_org := gen_random_uuid(); v_ev := gen_random_uuid();
    INSERT INTO public.users (id, is_organizer) VALUES (v_org, true);
    INSERT INTO public.recruiter_partnerships (recruiter_id, organizer_id, status, commission_split_bps, responded_at, responded_by)
      VALUES ('$REP', v_org, 'accepted', 0, now(), v_org);
    INSERT INTO public.representative_attributions (representative_id, organizer_id, partnership_id)
      SELECT '$REP', v_org, id FROM public.recruiter_partnerships WHERE organizer_id = v_org RETURNING id INTO v_att;
    INSERT INTO public.events (id, organizer_id, title) VALUES (v_ev, v_org, 'x');
    INSERT INTO public.representative_reward_claims
      (attribution_id, representative_id, organizer_id, event_id, reward_month, amount_kobo, status, is_free_event)
      VALUES (v_att, '$REP', v_org, v_ev, '$THIS', 5000000, 'approved', false);
  END LOOP;
END \$\$;
SQL
expect_value "count is by calendar month" "$(val "SELECT public.representative_qualifying_count('$REP', '$THIS');")" "9"
expect_value "nothing increases automatically" "$(val "SELECT public.representative_reward_rate_kobo('$REP', '$NEXT');")" "5000000"
RM=$(request "$ADMIN_A" earn_set_monthly_rate "'$REP'" "{\"month\":\"$THIS\",\"reward_kobo\":7500000,\"reason\":\"x\"}")
expect_error "the higher rate is for the FOLLOWING month only" "are required" "$(approve "$ADMIN_B" "$RM")"
RM=$(request "$ADMIN_A" earn_set_monthly_rate "'$REP'" "{\"month\":\"$NEXT\",\"reward_kobo\":7500000,\"reason\":\"9 organizers in $THIS\"}")
expect_ok "management approves a higher next-month rate" "$(approve "$ADMIN_B" "$RM")"
expect_value "next month's rate applies only after approval" "$(val "SELECT public.representative_reward_rate_kobo('$REP', '$NEXT');")" "7500000"
RM=$(request "$ADMIN_A" earn_set_monthly_rate "'$ADMIN_REP'" "{\"month\":\"$NEXT\",\"reward_kobo\":7500000,\"reason\":\"x\"}")
expect_error "a representative-admin cannot approve their own rate" "cannot request or approve their own rate" "$(approve "$ADMIN_REP" "$RM")"

echo "== Expenses =="
expect_value "representative submits a transport expense" \
  "$(val "$(as "$REP" "SELECT public.submit_representative_expense('transport', 250000, 'Bus to Ikeja meeting', current_date, '$ORG', '33333333-3333-3333-3333-333333333333')->>'status';")")" "submitted"
expect_value "resubmitting with the same key is idempotent" \
  "$(val "$(as "$REP" "SELECT public.submit_representative_expense('transport', 250000, 'Bus to Ikeja meeting', current_date, '$ORG', '33333333-3333-3333-3333-333333333333')->>'duplicate';")")/$(val "SELECT count(*) FROM public.representative_expenses;")" "true/1"
expect_error "a future-dated expense is refused" "today or earlier" \
  "$(as "$REP" "SELECT public.submit_representative_expense('support', 1000, 'Later', current_date + 3, NULL, gen_random_uuid());")"
expect_error "a non-representative cannot submit expenses" "active representative" \
  "$(as "$OTHER" "SELECT public.submit_representative_expense('support', 1000, 'Nope', current_date, NULL, gen_random_uuid());")"
"${PSQL[@]}" -q -c "$(as "$ADMIN_REP" "SELECT public.submit_representative_expense('support', 100000, 'Printing flyers', current_date, NULL, gen_random_uuid());")" >/dev/null
XA=$(val "SELECT id FROM public.representative_expenses WHERE representative_id = '$ADMIN_REP';")
RX=$(request "$ADMIN_A" earn_decide_expense NULL "{\"expense_id\":\"$XA\",\"approve\":true}")
expect_error "a representative-admin cannot approve their own expense" "cannot request or approve their own expense" "$(approve "$ADMIN_REP" "$RX")"
X1=$(val "SELECT id FROM public.representative_expenses WHERE representative_id = '$REP';")
for b in "${BAD_BOOLS[@]}"; do
  RB=$(request "$ADMIN_A" earn_decide_expense NULL "{\"expense_id\":\"$X1\",\"approve\":$b}")
  expect_error "expense approve = $b is refused" "approve must be true or false" "$(approve "$ADMIN_B" "$RB")"
done
RB=$(request "$ADMIN_A" earn_decide_expense NULL "{\"expense_id\":\"$X1\"}")
expect_error "an expense decision with no approve value is refused" "approve must be true or false" "$(approve "$ADMIN_B" "$RB")"
expect_value "malformed expense decisions left the expense undecided" \
  "$(val "SELECT status FROM public.representative_expenses WHERE id = '$X1';")" "submitted"
"${PSQL[@]}" -q -c "$(as "$REP2" "SELECT public.submit_representative_expense('support', 50000, 'Duplicate printing', current_date, NULL, gen_random_uuid());")" >/dev/null
XR=$(val "SELECT id FROM public.representative_expenses WHERE representative_id = '$REP2';")
RB=$(request "$ADMIN_A" earn_decide_expense NULL "{\"expense_id\":\"$XR\",\"approve\":false,\"reason\":\"duplicate\"}")
expect_ok "expense approve = false (a real boolean) is accepted" "$(approve "$ADMIN_B" "$RB")"
expect_value "approve = false rejects the expense" \
  "$(val "SELECT status FROM public.representative_expenses WHERE id = '$XR';")" "rejected"
RX=$(request "$ADMIN_A" earn_decide_expense NULL "{\"expense_id\":\"$X1\",\"approve\":true,\"reason\":\"receipt checked\"}")
expect_ok "expense approved through dual control" "$(approve "$ADMIN_B" "$RX")"
expect_value "expenses never touch the wallet or the pool" \
  "$(val "SELECT status FROM public.representative_expenses WHERE id = '$X1';")/$(earn "$REP")/$(val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$REP';")" "approved/3000000/0/2000000/5000000/10000"

echo "== Read APIs and audit trail =="
REPJSON=$(val "$(as "$REP" "SELECT public.get_my_representative_rewards()::text;")")
if echo "$REPJSON" | grep -q "fee_candidate_kobo\|fee_recorded_kobo\|available_kobo"; then
  fail "representative read API leaks VENTS profit figures"; else pass "representative read API exposes no VENTS profit figures"; fi
expect_value "representative sees their claims and attributions" \
  "$(val "$(as "$REP" "SELECT jsonb_array_length(public.get_my_representative_rewards()->'claims') || '/' || jsonb_array_length(public.get_my_representative_rewards()->'attributions');")")" "11/12"
expect_value "a non-representative gets no representative profile" \
  "$(val "$(as "$OTHER" "SELECT (public.get_my_representative_rewards()->'representative')::text;")")" "null"
expect_value "organizer sees confirmations addressed to them only" \
  "$(val "$(as "$ORG" "SELECT jsonb_array_length(public.get_my_referral_confirmations());")")" "1"
expect_error "non-admins cannot read the admin overview" "Admin access required" \
  "$(as "$REP" "SELECT public.admin_get_vents_earn_overview();")"
expect_ok "admins can read the admin overview" "$(as "$SUB" "SELECT public.admin_get_vents_earn_overview();")"
expect_value "the representative cannot see another representative's claims (RLS)" \
  "$(val "$(as "$REP2" "SELECT count(*) FROM public.representative_reward_claims WHERE representative_id = '$REP';")")" "0"
expect_error "audit log is append-only (UPDATE)" "append-only" "UPDATE public.earn_audit_log SET action = 'x';"
expect_error "audit log is append-only (DELETE)" "append-only" "DELETE FROM public.earn_audit_log;"
expect_error "profit ledger is append-only" "append-only" "DELETE FROM public.earn_profit_ledger;"
for a in attributed duplicate_attribution_blocked submitted organizer_confirmed admin_approved funding_blocked_insufficient_profit \
         recognized funded_profit_reserved earnings_wallet_credited post_recognition_refund admin_reversed rate_approved expense_approved settings_updated; do
  n=$(val "SELECT count(*) FROM public.earn_audit_log WHERE action = '$a';")
  if [ "${n:-0}" -ge 1 ]; then pass "audit trail records '$a'"; else fail "audit trail missing '$a'"; fi
done

sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; exit 1; fi
