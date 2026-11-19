#!/usr/bin/env bash
# Pre-release review of event cancellation (0218) and its safety fixes (0219),
# on the same full local money stack as run-event-cancellation-verification.sh
# (0201 -> 0217 plus the production ticket/refund functions). Covers:
#   * refund accounting per price: attendee, organizer, VENTS;
#   * organizer earnings while refunds are outstanding (release, recovery);
#   * check-in at a cancelled event; checked-in tickets;
#   * who may process / re-queue refunds; attempts used by rejections and
#     rate limits;
#   * transferred wallet tickets; purchases in flight; duplicate callbacks;
#   * a payment confirmed while the approval commits (two real sessions);
#   * 0219 idempotency and undo.
# Checks labelled CURRENT BEHAVIOUR pin what the system does today where a
# business decision is open (docs/event-cancellation.md); they are not
# endorsements, and should change when the owner decides.
#
# Refunds run exactly as production runs them: refund_ticket (wallet credit,
# free cancellation, or Paystack refund_pending) -> the refund API's steps
# (Paystack /refund MOCKED here: accept, reject or time out; then
# attach_ticket_refund_id, or admin_revert_stuck_refund on a rejection) ->
# the webhook (finalize_ticket_refund / fail_ticket_refund). Every mock
# Paystack refund call is logged so duplicates would be caught.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files. No network, no Paystack.
#
# Usage: scripts/local-pg-test/run-event-cancellation-review-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_event_cancellation_review"
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

TMP=$(mktemp -d); OUT="$TMP/out"; ERR="$TMP/err"; PAYSTACK_LOG="$TMP/paystack_refund_calls"; : >"$PAYSTACK_LOG"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ORG="00000000-0000-0000-0000-0000000c0a01"; ORG2="00000000-0000-0000-0000-0000000c0a02"
ADMIN_A="00000000-0000-0000-0000-0000000c0a11"; ADMIN_B="00000000-0000-0000-0000-0000000c0a12"; SUB="00000000-0000-0000-0000-0000000c0a13"
B1="00000000-0000-0000-0000-0000000c0b01"; B2="00000000-0000-0000-0000-0000000c0b02"; B3="00000000-0000-0000-0000-0000000c0b03"; B4="00000000-0000-0000-0000-0000000c0b04"
OTHER="00000000-0000-0000-0000-0000000c0b09"
EV="00000000-0000-0000-0000-0000000c0e01"; EV_EMPTY="00000000-0000-0000-0000-0000000c0e02"
EV_REJ="00000000-0000-0000-0000-0000000c0e03"; EV_OTHER="00000000-0000-0000-0000-0000000c0e04"; EV_RACE="00000000-0000-0000-0000-0000000c0e05"

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
# A real purchase through the production money functions, as the Paystack webhook finalizes it.
buy() {  # buy <buyer> <event> <attendees> -> payment_ref
  local att; att=$(python3 -c "import json,sys; print(json.dumps([{'name': 'A%d' % i} for i in range(int(sys.argv[1]))]))" "$3")
  local ref; ref=$(val "$(as "$1" "SELECT public.create_pending_purchase('$2', 'Regular', '$att'::jsonb, NULL, NULL)->>'payment_ref';")")
  local amount; amount=$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$ref';")
  "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$ref');" >/dev/null 2>&1 || true
  "${PSQL[@]}" -q -c "SELECT public.confirm_ticket_payment('$ref', $amount);" >/dev/null
  echo "$ref"
}
buy_wallet() {  # buy_wallet <buyer> <event> -> payment_ref (paid from the VENTS Wallet)
  local ref; ref=$(val "$(as "$1" "SELECT public.create_pending_purchase('$2', 'Regular', '[{\"name\": \"W\"}]'::jsonb, NULL, NULL)->>'payment_ref';")")
  "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$ref');" >/dev/null 2>&1 || true
  "${PSQL[@]}" -q -c "$(as "$1" "SELECT public.confirm_ticket_payment_via_wallet('$ref');")" >/dev/null
  echo "$ref"
}
tickets_of() { val "SELECT string_agg(id::text, ' ' ORDER BY id) FROM public.tickets WHERE payment_ref = '$1';"; }
pstatus() { val "SELECT payment_status FROM public.tickets WHERE id = '$1';"; }
item() { val "SELECT status || '/' || attempts FROM public.event_cancellation_refunds WHERE ticket_id = '$1';"; }
req_status() { val "SELECT status FROM public.event_cancellation_requests WHERE id = '$1';"; }
wallet() { val "SELECT COALESCE((SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$1'), 0);"; }

# The refund API (api/wallet/refund-ticket.ts) for one ticket, with Paystack
# mocked: ok | reject | timeout. Same calls, same order, same JWT (the admin).
api_refund() {  # api_refund <admin> <ticket> <reason> <paystack: ok|reject|timeout>
  local json; json=$(val "$(as "$1" "SELECT public.refund_ticket('$2', \$r\$$3\$r\$)::text;")" || true)
  if [ -z "$json" ]; then echo "error:$(tail -1 "$ERR")"; return; fi
  local st amt; st=$(echo "$json" | jq -r '.status'); amt=$(echo "$json" | jq -r '.amount_kobo // empty')
  if [ "$st" = "refunded" ] || [ "$st" = "already_refunded" ]; then echo "$st"; return; fi
  if [ "$st" != "refund_pending" ] || [ -z "$amt" ]; then echo "unexpected:$st"; return; fi
  echo "$2 $amt $4" >>"$PAYSTACK_LOG"           # POST https://api.paystack.co/refund (mocked)
  case "$4" in
    ok)      "${PSQL[@]}" -q -c "$(as "$1" "SELECT public.attach_ticket_refund_id('$2', 'RF_${2: -6}');")" >/dev/null; echo "refund_pending" ;;
    reject)  "${PSQL[@]}" -q -c "$(as "$1" "SELECT public.admin_revert_stuck_refund('$2', 'Paystack refund creation failed: insufficient balance');")" >/dev/null; echo "rejected" ;;
    timeout) echo "timeout" ;;                    # no refund id recorded; never retried automatically
  esac
}
webhook_processed() { val "SELECT status FROM public.finalize_ticket_refund('RF_${1: -6}');"; }
webhook_failed() { val "SELECT status FROM public.fail_ticket_refund('RF_${1: -6}', 'Bank rejected the refund');"; }
# One admin "Process refunds" run, as the admin screen drives it.
process() {  # process <admin> <request> <paystack mode> [limit]
  local claim; claim=$(val "$(as "$1" "SELECT public.admin_claim_event_cancellation_refunds('$2', ${4:-10})::text;")")
  local reason; reason=$(echo "$claim" | jq -r '.reason')
  for t in $(echo "$claim" | jq -r '.tickets[].ticket_id'); do
    local r; r=$(api_refund "$1" "$t" "$reason" "$3")
    case "$r" in
      rejected|error:*|unexpected:*) "${PSQL[@]}" -q -c "$(as "$1" "SELECT public.admin_record_event_cancellation_refund_error('$2', '$t', \$e\$$r\$e\$);")" >/dev/null ;;
    esac
  done
  echo "$claim" | jq -r '.tickets | length'
}

echo "== Building throwaway database $DB_NAME (0201 -> 0217 + production refund functions) =="
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
for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment 0208_ticket_fee_1_5_3_5 \
         0209_representative_referral_links 0210_referral_connections 0216_representative_rewards_free_events_never_qualify 0217_representative_reward_fixed_50000; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null 2>&1
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-event-cancellation.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.confirm_ticket_payment_via_wallet(text),
  public.refund_ticket(uuid,text), public.soft_delete_event(uuid,text), public.attach_ticket_refund_id(uuid,text),
  public.admin_revert_stuck_refund(uuid,text) TO authenticated;
-- Production shape of events access (0002 columns; 0012 grants; 0008 RLS
-- policies, verbatim): authenticated may UPDATE any column of an event it
-- organizes -- which is why the deletion guard is a trigger.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS reason text;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO authenticated;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_events ON public.events;
DROP POLICY IF EXISTS update_events ON public.events;
CREATE POLICY select_events ON public.events FOR SELECT TO public USING (((deleted_at IS NULL) OR (organizer_id = ( SELECT auth.uid() AS uid)) OR public.is_admin()));
CREATE POLICY update_events ON public.events FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = organizer_id) OR public.is_admin())) WITH CHECK (((( SELECT auth.uid() AS uid) = organizer_id) OR public.is_admin()));
GRANT SELECT ON public.tickets TO authenticated;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tickets_local_read ON public.tickets;
-- Ticket holders, the event's organizer and admins read tickets (as production's select policies allow).
CREATE POLICY tickets_local_read ON public.tickets FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin()
  OR EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND e.organizer_id = auth.uid()));
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org One', 'org@example.test'), ('$ORG2', 'user', true, 'Org Two', 'org2@example.test'),
  ('$ADMIN_A', 'admin', false, 'Admin A', 'aa@example.test'), ('$ADMIN_B', 'admin', false, 'Admin B', 'ab@example.test'),
  ('$SUB', 'sub-admin', false, 'Sub', 's@example.test'),
  ('$B1', 'user', false, 'Buyer One', 'b1@example.test'), ('$B2', 'user', false, 'Buyer Two', 'b2@example.test'),
  ('$B3', 'user', false, 'Buyer Three', 'b3@example.test'), ('$B4', 'user', false, 'Buyer Four', 'b4@example.test'),
  ('$OTHER', 'user', false, 'Other', 'o@example.test');
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EV',       '$ORG',  'Lagos Jazz Night', now() + interval '20 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$EV_EMPTY', '$ORG',  'Empty draft',      now() + interval '20 days', 'live', '[{"name": "Regular", "price": 10000}]'),
  ('$EV_REJ',   '$ORG',  'Comedy Evening',   now() + interval '20 days', 'live', '[{"name": "Regular", "price": 5000}]'),
  ('$EV_OTHER', '$ORG2', 'Other organizer',  now() + interval '20 days', 'live', '[{"name": "Regular", "price": 5000}]'),
  ('$EV_RACE',  '$ORG',  'Race night',       now() + interval '20 days', 'live', '[{"name": "Regular", "price": 5000}]');
INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$B2', 5000000);
SQL


echo "== Migrations 0218 + 0219 =="
H_FUNCS="SELECT md5(string_agg(proname || ':' || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('event_cancellation_ticket_sync', 'admin_claim_event_cancellation_refunds', 'admin_record_event_cancellation_refund_error');"
expect_ok "0218 applies" "$(cat "$MIG/0218_event_cancellation_workflow.sql")"
H218=$(val "$H_FUNCS")
expect_ok "0219 applies on top of 0218" "$(cat "$MIG/0219_event_cancellation_safety_fixes.sql")"
"${PSQL[@]}" -q -c "GRANT EXECUTE ON FUNCTION public.event_ticket_obligations(uuid) TO postgres;"

# ---------------------------------------------------------------------------
# Review scenarios (0219 + characterization of open policy decisions)
# ---------------------------------------------------------------------------
EVF1="00000000-0000-0000-0000-0000000c0f01"; EVF2="00000000-0000-0000-0000-0000000c0f02"; EVF3="00000000-0000-0000-0000-0000000c0f03"
EV_CHK="00000000-0000-0000-0000-0000000c0f04"; EV_RQ="00000000-0000-0000-0000-0000000c0f05"; EV_TR="00000000-0000-0000-0000-0000000c0f06"
EV_R18="00000000-0000-0000-0000-0000000c0f07"; EV_R19="00000000-0000-0000-0000-0000000c0f08"; EV_ABAND="00000000-0000-0000-0000-0000000c0f09"
EV_LATE="00000000-0000-0000-0000-0000000c0f0a"; EV_HOLD="00000000-0000-0000-0000-0000000c0f0b"
EV_RL="00000000-0000-0000-0000-0000000c0f0c"; EV_BLK="00000000-0000-0000-0000-0000000c0f0d"
"${PSQL[@]}" -q <<SQL
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$EVF1',  '$ORG2', 'Fee example 1000',  now() + interval '20 days', 'live', '[{"name": "Regular", "price": 1000}]'),
  ('$EVF2',  '$ORG2', 'Fee example 5000',  now() + interval '20 days', 'live', '[{"name": "Regular", "price": 5000}]'),
  ('$EVF3',  '$ORG2', 'Fee example 20000', now() + interval '20 days', 'live', '[{"name": "Regular", "price": 20000}]'),
  ('$EV_CHK','$ORG',  'Door test',         now() + interval '20 days', 'live', '[{"name": "Regular", "price": 2000}]'),
  ('$EV_RQ', '$ORG',  'Requeue test',      now() + interval '20 days', 'live', '[{"name": "Regular", "price": 3000}]'),
  ('$EV_TR', '$ORG',  'Transfer test',     now() + interval '20 days', 'live', '[{"name": "Regular", "price": 4000}]'),
  ('$EV_R19','$ORG',  'Race on 0219',      now() + interval '20 days', 'live', '[{"name": "Regular", "price": 2500}]'),
  ('$EV_ABAND','$ORG','Abandoned checkout',now() + interval '20 days', 'live', '[{"name": "Regular", "price": 2500}]'),
  ('$EV_LATE','$ORG', 'Late payment',      now() + interval '20 days', 'live', '[{"name": "Regular", "price": 2500}]'),
  ('$EV_HOLD','$ORG2','Hold test',         now() + interval '1 hour',  'live', '[{"name": "Regular", "price": 10000}]'),
  ('$EV_RL', '$ORG',  'Rate limit test',   now() + interval '20 days', 'live', '[{"name": "Regular", "price": 3000}]'),
  ('$EV_BLK','$ORG',  'Blocked test',      now() + interval '20 days', 'live', '[{"name": "Regular", "price": 3000}]');
INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$B3', 5000000) ON CONFLICT (user_id) DO UPDATE SET balance_kobo = 5000000;
SQL
org_bal() { val "SELECT balance_kobo || '/' || on_hold_kobo FROM public.organizer_wallets WHERE organizer_id = '$1';"; }
request_and_approve() {  # request_and_approve <event> [organizer] -> request id
  local rq; rq=$(val "$(as "${2:-$ORG}" "SELECT public.request_event_cancellation('$1', 'The venue is closed for repairs')->>'id';")")
  "${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_decide_event_cancellation('$rq', true, NULL);")" >/dev/null
  echo "$rq"
}

echo "== R1. Refund accounting: attendee, organizer and VENTS, per price (v3_15_35, Paystack) =="
for spec in "$EVF1:1000" "$EVF2:5000" "$EVF3:20000"; do
  ev=${spec%%:*}; price=${spec##*:}; face=$((price*100))
  before=$(val "SELECT COALESCE((SELECT balance_kobo + on_hold_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG2'), 0);")
  ref=$(buy "$B4" "$ev" 1); t=$(tickets_of "$ref")
  charge=$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$ref';")
  after_sale=$(val "SELECT balance_kobo + on_hold_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG2';")
  credit=$((after_sale-before))
  fee=$(python3 -c "print(round($face*15/1000))"); ded=$(python3 -c "print(round($face*35/1000))")
  expect_value "N$price: attendee charged face + 1.5% service fee" "$charge" "$((face+fee))"
  expect_value "N$price: organizer credited face - 3.5% deduction" "$credit" "$((face-ded))"
  rq=$(request_and_approve "$ev" "$ORG2")
  process "$ADMIN_A" "$rq" ok >/dev/null
  amt=$(tail -1 "$PAYSTACK_LOG" | awk '{print $2}')
  expect_value "N$price: Paystack is asked to refund the full charge (fee included)" "$amt" "$charge"
  webhook_processed "$t" >/dev/null
  after_ref=$(val "SELECT balance_kobo + on_hold_kobo FROM public.organizer_wallets WHERE organizer_id = '$ORG2';")
  expect_value "N$price: organizer debited exactly what they were credited (net 0)" "$after_ref" "$before"
  # VENTS: kept charge - credit at the sale, returns charge, recovers credit -> 0 before Paystack's
  # non-refundable processing fee, i.e. VENTS loses that fee on every refunded Paystack ticket.
  echo "INFO: N$price face=$face charge=$charge organizer_credit=$credit refund=$amt organizer_debit=$credit vents_margin_returned=$((charge-credit))"
done

echo "== R2. Organizer earnings while a cancellation's refunds are outstanding (policy decision 2) =="
ref=$(buy "$B4" "$EV_HOLD" 1); t=$(tickets_of "$ref")
rq=$(request_and_approve "$EV_HOLD" "$ORG2")
# The event's end passes (+48h): what blocks the release of this sale's held earnings now?
"${PSQL[@]}" -q -c "UPDATE public.earnings_holds SET event_end_at_sale = now() - interval '3 days' WHERE source_key = '$ref';
                    UPDATE public.events SET event_date = now() - interval '3 days' WHERE id = '$EV_HOLD';"
blk=$(val "SELECT public.earnings_hold_state(id)->>'blockers' FROM public.earnings_holds WHERE source_key = '$ref';")
expect_value "CURRENT BEHAVIOUR: a cancelled event's unrefunded sale is NOT a release blocker" "$blk" "[]"
"${PSQL[@]}" -q -c "SELECT public.settle_earnings('$ORG2');" >/dev/null
expect_value "CURRENT BEHAVIOUR: the held earnings of a cancelled, unrefunded sale are released to withdrawable balance" \
  "$(val "SELECT (released_at IS NOT NULL)::text FROM public.earnings_holds WHERE source_key = '$ref';")" "true"
# The organizer withdraws everything, then the refund runs.
"${PSQL[@]}" -q -c "UPDATE public.organizer_wallets SET balance_kobo = 0 WHERE organizer_id = '$ORG2';"
process "$ADMIN_A" "$rq" ok >/dev/null; webhook_processed "$t" >/dev/null
expect_value "the organizer balance never goes negative" "$(val "SELECT (balance_kobo >= 0)::text FROM public.organizer_wallets WHERE organizer_id = '$ORG2';")" "true"
expect_value "the unrecovered amount becomes a recovery (receivable), not lost silently" \
  "$(val "SELECT amount_kobo FROM public.earnings_recoveries WHERE owner_id = '$ORG2' AND source_key = '$t';")" "965000"

echo "== R3. Check-in at a cancelled event (0219 fix 1) =="
ref=$(buy "$B4" "$EV_CHK" 1); t=$(tickets_of "$ref")
rq=$(request_and_approve "$EV_CHK")
expect_error "a ticket of a cancelled event cannot be checked in (any path: the trigger is on tickets)" "cannot be checked in" \
  "UPDATE public.tickets SET checked_in = true WHERE id = '$t';"
expect_value "... so its refund still runs" "$(process "$ADMIN_A" "$rq" ok >/dev/null; pstatus "$t")" "refund_pending"
ref2=$(buy "$B4" "$EV_OTHER" 1); t2=$(tickets_of "$ref2")
expect_ok "check-in at an event that is not cancelled is unchanged" "UPDATE public.tickets SET checked_in = true WHERE id = '$t2';"

echo "== R4. Only a Super Admin processes refunds; failed refunds can be re-queued (0219 fixes 3, 4) =="
ref=$(buy "$B4" "$EV_RQ" 1); t=$(tickets_of "$ref")
rq=$(request_and_approve "$EV_RQ")
expect_error "a sub-admin cannot claim refunds (their run would strand Paystack rejections)" "Super Admin access required" \
  "$(as "$SUB" "SELECT public.admin_claim_event_cancellation_refunds('$rq', 10);")"
expect_error "... and the release path it relies on is Super Admin only (why)" "Super Admin access required" \
  "$(as "$SUB" "SELECT public.admin_revert_stuck_refund('$t', 'x');")"
for i in 1 2 3 4 5; do process "$ADMIN_A" "$rq" reject >/dev/null; done
expect_value "five definitive Paystack rejections use up the attempts" "$(item "$t")" "failed/5"
expect_value "... after which the ticket is never claimed again automatically" "$(process "$ADMIN_A" "$rq" ok)" "0"
expect_error "re-queue needs a Super Admin" "Super Admin access required" "$(as "$SUB" "SELECT public.admin_requeue_event_cancellation_refund('$rq', '$t', 'Paystack balance topped up');")"
expect_error "re-queue needs a note" "note of at least 5" "$(as "$ADMIN_A" "SELECT public.admin_requeue_event_cancellation_refund('$rq', '$t', '');")"
expect_ok "a Super Admin re-queues it with a note" "$(as "$ADMIN_A" "SELECT public.admin_requeue_event_cancellation_refund('$rq', '$t', 'Paystack balance topped up');")"
expect_value "... it is queued with fresh attempts, and audited" \
  "$(item "$t")/$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'event_cancellation_refund_requeued' AND details->>'ticket_id' = '$t' AND (details->>'previous_attempts')::int = 5;")" "queued/0/1"
expect_value "... and the next run refunds it once" "$(process "$ADMIN_A" "$rq" ok >/dev/null; pstatus "$t")/$(grep -c "^$t " "$PAYSTACK_LOG")" "refund_pending/6"
expect_error "a ticket with a refund in flight cannot be re-queued" "Only a failed refund" \
  "$(as "$ADMIN_A" "SELECT public.admin_requeue_event_cancellation_refund('$rq', '$t', 'retry it please');")"
webhook_processed "$t" >/dev/null
# Rate-limit refusals (refund_ticket 30/h, Paystack 100/h) spend attempts too (simulated limit).
ref=$(buy "$B3" "$EV_RL" 1); tr=$(tickets_of "$ref"); rql=$(request_and_approve "$EV_RL")
RL_ORIG=$("${PSQL[@]}" -tA -c "SELECT pg_get_functiondef('public.check_rate_limit(text,integer,integer)'::regprocedure);")
"${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_attempts integer, p_window_seconds integer) RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN IF p_key LIKE 'refund_ticket:%' THEN RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0429'; END IF; END \$f\$;"
for i in 1 2 3 4 5; do process "$ADMIN_A" "$rql" ok >/dev/null; done
expect_value "rate-limited runs (no provider call made) also use up the attempts" "$(item "$tr")/$(grep -c "^$tr " "$PAYSTACK_LOG" || true)" "failed/5/0"
"${PSQL[@]}" -q -c "$RL_ORIG"   # the local stub again
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_requeue_event_cancellation_refund('$rql', '$tr', 'Rate limit window passed');")" >/dev/null
expect_value "... and re-queue recovers them once the limit clears" "$(process "$ADMIN_A" "$rql" ok >/dev/null; pstatus "$tr")" "refund_pending"

echo "== R5. A ticket checked in after it was queued is blocked, not retried (0219 fix 5) =="
ref=$(buy "$B3" "$EV_BLK" 1); tc=$(tickets_of "$ref"); rqc=$(request_and_approve "$EV_BLK")
# The scan that committed between queueing and the refund call (guard bypassed once to simulate that race).
"${PSQL[@]}" -q -c "ALTER TABLE public.tickets DISABLE TRIGGER tickets_cancelled_event_checkin_guard; UPDATE public.tickets SET checked_in = true WHERE id = '$tc'; ALTER TABLE public.tickets ENABLE TRIGGER tickets_cancelled_event_checkin_guard;"
process "$ADMIN_A" "$rqc" ok >/dev/null
expect_value "refund_ticket refuses it, and the row is 'blocked' (manual decision), not retried" "$(item "$tc" | cut -d/ -f1)/$(pstatus "$tc")/$(process "$ADMIN_A" "$rqc" ok)" "blocked/paid/0"

echo "== R6. Transferred wallet ticket (policy decision 8) =="
ref=$(buy_wallet "$B3" "$EV_TR"); tt=$(tickets_of "$ref")
b3_before=$(wallet "$B3"); b1_before=$(wallet "$B1")
# accept_ticket_transfer's ownership swap (0043): user_id and holder change; payment_ref/payment_method stay.
"${PSQL[@]}" -q -c "UPDATE public.tickets SET user_id = '$B1', holder_name = 'Buyer One' WHERE id = '$tt';"
rq=$(request_and_approve "$EV_TR"); process "$ADMIN_A" "$rq" ok >/dev/null
expect_value "CURRENT BEHAVIOUR: the refund of a transferred wallet ticket is credited to the CURRENT holder, not the payer" \
  "$(( $(wallet "$B1") - b1_before ))/$(( $(wallet "$B3") - b3_before ))" "406000/0"
expect_value "... the payer is identifiable from the wallet ledger (the debit for that payment)" \
  "$(val "SELECT string_agg(DISTINCT user_id::text, ',') FROM public.user_wallet_transactions WHERE reference_id = '$ref' AND type <> 'refund';")" "$B3"

echo "== R7. A payment confirmed while the approval commits (two real sessions) =="
# Session 1 (the payment webhook) confirms a ticket and is slow to commit;
# session 2 approves the cancellation meanwhile. The organizer credit's hold
# row (FK to events) makes the approval wait for the payment, so its refund is
# queued. Pinned here so a later change to either path cannot open that race.
ref=$(val "$(as "$B4" "SELECT public.create_pending_purchase('$EV_R19', 'Regular', '[{\"name\": \"R\"}]'::jsonb, NULL, NULL)->>'payment_ref';")")
"${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$ref');" >/dev/null 2>&1 || true
t=$(tickets_of "$ref"); amount=$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$ref';")
rq=$(val "$(as "$ORG" "SELECT public.request_event_cancellation('$EV_R19', 'The venue is closed for repairs')->>'id';")")
( "${PSQL[@]}" -q -c "BEGIN; SELECT public.confirm_ticket_payment('$ref', $amount); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
sleep 0.7
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_decide_event_cancellation('$rq', true, NULL);")" >/dev/null 2>&1
wait
expect_value "the overlapping payment's ticket is queued for a refund; the request is not 'completed'" \
  "$(pstatus "$t")/$(val "SELECT COALESCE((SELECT status FROM public.event_cancellation_refunds WHERE ticket_id = '$t'), 'none');")/$(req_status "$rq")" "paid/queued/processing"

echo "== R8. Purchases still in flight (policy decision 6) =="
ref=$(val "$(as "$B4" "SELECT public.create_pending_purchase('$EV_ABAND', 'Regular', '[{\"name\": \"A\"}]'::jsonb, NULL, NULL)->>'payment_ref';")")
expect_error "CURRENT BEHAVIOUR: an abandoned checkout blocks deleting an event with no tickets ('0 ticket holder(s)')" "has 0 ticket holder" \
  "$(as "$ORG" "SELECT public.soft_delete_event('$EV_ABAND', 'not happening');")"
ref=$(val "$(as "$B4" "SELECT public.create_pending_purchase('$EV_LATE', 'Regular', '[{\"name\": \"L\"}]'::jsonb, NULL, NULL)->>'payment_ref';")")
amount=$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$ref';")
rq=$(request_and_approve "$EV_LATE")
"${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$ref');" >/dev/null 2>&1 || true
expect_value "CURRENT BEHAVIOUR: Paystack succeeds after approval -> no ticket is created, nothing is queued (money held, unreconciled)" \
  "$(val "SELECT public.confirm_ticket_payment('$ref', $amount);")/$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$ref';")/$(val "SELECT status FROM public.pending_purchases WHERE payment_ref = '$ref';")/$(req_status "$rq")" \
  "not_found/0/pending/completed"
expect_value "a duplicate success callback changes nothing" "$(val "SELECT public.confirm_ticket_payment('$ref', $amount);")/$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$ref';")" "not_found/0"

echo "== R9. Unauthorized access (0219 functions) =="
expect_error "an organizer cannot claim refunds" "Super Admin access required" "$(as "$ORG" "SELECT public.admin_claim_event_cancellation_refunds('$rq', 10);")"
expect_error "a ticket holder cannot re-queue" "Super Admin access required" "$(as "$B4" "SELECT public.admin_requeue_event_cancellation_refund('$rq', '$t', 'please refund me');")"
expect_value "the check-in guard and sync trigger functions are not callable by clients" \
  "$(val "SELECT has_function_privilege('authenticated', 'public.tickets_cancelled_event_checkin_guard()', 'EXECUTE')::text || '/' || has_function_privilege('anon', 'public.admin_requeue_event_cancellation_refund(uuid,uuid,text)', 'EXECUTE')::text;")" "false/false"

echo "== R10. 0219 idempotency and undo =="
expect_ok "0219 is idempotent (second run)" "$(cat "$MIG/0219_event_cancellation_safety_fixes.sql")"
expect_error "undo_0219 refuses without the confirmation" "undo-0219" "$(cat "$REPO_ROOT/supabase/rollback/undo_0219.sql")"
expect_ok "undo_0219 runs" "SET vents.rollback_confirm = 'undo-0219'; $(cat "$REPO_ROOT/supabase/rollback/undo_0219.sql")"
expect_value "undo_0219 restores 0218's exact function bodies and removes the 0219 objects"   "$(val "$H_FUNCS")/$(val "SELECT (to_regprocedure('public.admin_requeue_event_cancellation_refund(uuid,uuid,text)') IS NULL AND to_regprocedure('public.tickets_cancelled_event_checkin_guard()') IS NULL)::text;")" "$H218/true"
expect_ok "0219 re-applies after the undo" "$(cat "$MIG/0219_event_cancellation_safety_fixes.sql")"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES EVENT CANCELLATION REVIEW (0219) CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
