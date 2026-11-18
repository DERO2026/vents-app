#!/usr/bin/env bash
# Real-execution verification of migration 0218 (Batch 2: event cancellation,
# refunds and attendee protection) on the full local money stack (0201 ->
# 0217 plus the production ticket/refund functions).
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
# Usage: scripts/local-pg-test/run-event-cancellation-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_event_cancellation"
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

echo "== Migration 0218: order, idempotency, undo =="
STATE="SELECT md5(string_agg(p.proname || ':' || p.prosrc, '|' ORDER BY p.oid::regprocedure::text)) || '/' || (SELECT count(*) FROM information_schema.columns WHERE table_name = 'events' AND column_name IN ('cancelled_at', 'cancellation_request_id')) || '/' || COALESCE(to_regclass('public.event_cancellation_requests')::text, '-') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
PRE=$(val "$STATE")
expect_ok "0218 applies on top of 0201-0217" "$(cat "$MIG/0218_event_cancellation_workflow.sql")"
expect_ok "0218 is idempotent (second run)" "$(cat "$MIG/0218_event_cancellation_workflow.sql")"
expect_error "undo_0218 refuses without the confirmation" "undo-0218" "$(cat "$REPO_ROOT/supabase/rollback/undo_0218.sql")"
expect_ok "undo_0218 runs while no cancellation exists" "SET vents.rollback_confirm = 'undo-0218'; $(cat "$REPO_ROOT/supabase/rollback/undo_0218.sql")"
expect_value "undo_0218 restores every function and column exactly" "$(val "$STATE")" "$PRE"
expect_ok "0218 re-applies after the undo" "$(cat "$MIG/0218_event_cancellation_workflow.sql")"
"${PSQL[@]}" -q -c "GRANT EXECUTE ON FUNCTION public.event_ticket_obligations(uuid) TO postgres;"

echo "== Purchases (production money functions) =="
REF_B1=$(buy "$B1" "$EV" 2)             # two tickets in ONE Paystack payment
REF_B1B=$(buy "$B1" "$EV" 1)            # refunded individually before the cancellation (history)
REF_B3=$(buy "$B3" "$EV" 1)             # checked in at the door
REF_B4=$(buy "$B4" "$EV" 1)
REF_W=$(buy_wallet "$B2" "$EV")         # paid from the VENTS Wallet
read -r T1 T2 <<<"$(tickets_of "$REF_B1")"; T_PRE=$(tickets_of "$REF_B1B"); T_CHK=$(tickets_of "$REF_B3"); T4=$(tickets_of "$REF_B4"); T_W=$(tickets_of "$REF_W")
"${PSQL[@]}" -q -c "UPDATE public.tickets SET checked_in = true WHERE id = '$T_CHK';"
# A free RSVP, exactly as purchase_ticket writes one (payment_status 'paid' at N0).
T_FREE=$(val "WITH x AS (INSERT INTO public.tickets (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status, holder_name, discount_percentage)
              VALUES ('$EV', '$B3', 1, 'Regular', 0, 'VNT-FREE-CANCEL', 'paid', 'active', 'RSVP', 0) RETURNING id) SELECT id FROM x;")
REF_REJ=$(buy "$B1" "$EV_REJ" 1); T_REJ=$(tickets_of "$REF_REJ")
REF_RACE=$(buy "$B1" "$EV_RACE" 1)
expect_value "the Paystack charge for two N10,000 tickets is N20,300 (1.5% fee), split N10,150 per ticket" \
  "$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$REF_B1';")/$(val "SELECT public.ticket_fee_buyer_charge_kobo(amount, 1, discount_percentage, fee_model) FROM public.tickets WHERE id = '$T1';")" "2030000/1015000"
expect_value "the wallet ticket was paid from the VENTS Wallet (N50,000 - N10,150)" "$(wallet "$B2")/$(val "SELECT payment_method FROM public.tickets WHERE id = '$T_W';")" "3985000/wallet"
# A partial refund before any cancellation: one ticket refunded on its own (existing flow).
expect_value "an individual refund before the cancellation goes through the existing flow" "$(api_refund "$ORG" "$T_PRE" "Changed plans" ok)/$(webhook_processed "$T_PRE")" "refund_pending/finalized"

echo "== 1-2. Deleting an event with ticket holders is refused; empty events and hiding still work =="
expect_error "the organizer cannot delete an event with paid tickets (soft_delete_event)" "request a cancellation instead" \
  "$(as "$ORG" "SELECT public.soft_delete_event('$EV', 'no longer happening');")"
expect_error "... nor by writing deleted_at directly (the RLS policy allows the owner to update)" "request a cancellation instead" \
  "$(as "$ORG" "UPDATE public.events SET deleted_at = now() WHERE id = '$EV';")"
expect_error "... nor can an admin delete it" "request a cancellation instead" "$(as "$ADMIN_A" "SELECT public.soft_delete_event('$EV', 'x');")"
expect_error "... and a pending purchase (money may still arrive) also blocks deletion" "request a cancellation instead" \
  "$(as "$B2" "SELECT public.create_pending_purchase('$EV_EMPTY', 'Regular', '[{\"name\": \"P\"}]'::jsonb, NULL, NULL);"); $(as "$ORG" "SELECT public.soft_delete_event('$EV_EMPTY', 'x');")"
"${PSQL[@]}" -q -c "UPDATE public.pending_purchases SET status = 'expired' WHERE event_id = '$EV_EMPTY';" 2>/dev/null || "${PSQL[@]}" -q -c "DELETE FROM public.pending_purchases WHERE event_id = '$EV_EMPTY';"
expect_ok "an event with no ticket holders can still be deleted" "$(as "$ORG" "SELECT public.soft_delete_event('$EV_EMPTY', 'duplicate listing');")"
expect_value "... and is deleted" "$(val "SELECT deleted_at IS NOT NULL FROM public.events WHERE id = '$EV_EMPTY';")" "t"
expect_ok "hiding an event with tickets (draft) still works and is not a cancellation" "$(as "$ORG" "UPDATE public.events SET status = 'draft' WHERE id = '$EV_REJ';")"
expect_value "... no cancellation was created and its tickets are untouched" \
  "$(val "SELECT count(*) FROM public.event_cancellation_requests;")/$(pstatus "$T_REJ")/$(val "SELECT cancelled_at IS NULL FROM public.events WHERE id = '$EV_REJ';")" "0/paid/t"
"${PSQL[@]}" -q -c "$(as "$ORG" "UPDATE public.events SET status = 'live' WHERE id = '$EV_REJ';")"
expect_error "nobody can stamp an event cancelled directly" "only through an approved cancellation request" \
  "$(as "$ORG" "UPDATE public.events SET cancelled_at = now() WHERE id = '$EV';")"

echo "== 3-4. Organizer request =="
expect_error "another organizer cannot request a cancellation of this event" "Only the organizer of this event" \
  "$(as "$ORG2" "SELECT public.request_event_cancellation('$EV', 'The venue is unavailable that night');")"
expect_error "an ordinary user cannot either" "Only the organizer of this event" \
  "$(as "$OTHER" "SELECT public.request_event_cancellation('$EV', 'The venue is unavailable that night');")"
expect_error "a reason is required (10+ characters)" "at least 10 characters" "$(as "$ORG" "SELECT public.request_event_cancellation('$EV', 'no');")"
RQ=$(val "$(as "$ORG" "SELECT public.request_event_cancellation('$EV', 'The venue flooded and is closed for repairs')->>'id';")")
expect_value "the organizer's request is recorded as requested, with the paid ticket count" \
  "$(req_status "$RQ")/$(val "SELECT snapshot->'at_request'->>'paid_tickets' FROM public.event_cancellation_requests WHERE id = '$RQ';")" "requested/6"
expect_error "a second request for the same event is refused" "already open" \
  "$(as "$ORG" "SELECT public.request_event_cancellation('$EV', 'The venue flooded and is closed for repairs');")"
expect_value "ticket sales stay open until a decision (the event is still live)" "$(val "SELECT status || '/' || (cancelled_at IS NULL) FROM public.events WHERE id = '$EV';")" "live/true"
expect_value "the organizer is told, and every super admin gets the review notice" \
  "$(val "SELECT count(*) FROM public.notifications WHERE push_data->>'cancellationId' = '$RQ' AND push_data->>'stage' = 'requested' AND user_id = '$ORG';")/$(val "SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.notifications WHERE push_data->>'cancellationId' = '$RQ' AND push_data->>'stage' = 'review';")" \
  "1/$ADMIN_A,$ADMIN_B"
expect_error "clients cannot write cancellation requests directly" "permission denied" \
  "$(as "$ORG" "UPDATE public.event_cancellation_requests SET status = 'processing' WHERE id = '$RQ';")"
expect_error "clients cannot write refund rows directly" "permission denied" \
  "$(as "$ORG" "INSERT INTO public.event_cancellation_refunds (request_id, ticket_id, user_id, amount_kobo, payment_method) VALUES ('$RQ', '$T1', '$B1', 1, 'wallet');")"

echo "== 5-8. Admin decision =="
expect_error "an ordinary user cannot approve" "Super Admin access required" "$(as "$OTHER" "SELECT public.admin_decide_event_cancellation('$RQ', true, NULL);")"
expect_error "the organizer cannot approve" "Super Admin access required" "$(as "$ORG" "SELECT public.admin_decide_event_cancellation('$RQ', true, NULL);")"
expect_error "a sub-admin cannot approve" "Super Admin access required" "$(as "$SUB" "SELECT public.admin_decide_event_cancellation('$RQ', true, NULL);")"
expect_error "admins can read the review, others cannot" "Admin access required" "$(as "$OTHER" "SELECT public.admin_get_event_cancellation('$RQ');")"
expect_value "the review shows paid tickets by payment method with the server-side amounts, and the checked-in ticket" \
  "$(val "$(as "$ADMIN_A" "SELECT (d->'payments'->'paystack'->>'tickets') || '/' || (d->'payments'->'paystack'->>'kobo') || '/' || (d->'payments'->'wallet'->>'kobo') || '/' || (d->'payments'->'free'->>'tickets') || '/' || (d->>'checked_in') FROM (SELECT public.admin_get_event_cancellation('$RQ') AS d) q;")")" \
  "4/4060000/1015000/1/1"

# A request that is rejected: nothing refunded, event stays on sale.
RQ_REJ=$(val "$(as "$ORG" "SELECT public.request_event_cancellation('$EV_REJ', 'Thinking about moving the date')->>'id';")")
expect_error "a rejection needs a reason" "A reason is required to reject" "$(as "$ADMIN_A" "SELECT public.admin_decide_event_cancellation('$RQ_REJ', false, '');")"
expect_ok "an admin rejects a request" "$(as "$ADMIN_A" "SELECT public.admin_decide_event_cancellation('$RQ_REJ', false, 'Move the date instead of cancelling');")"
expect_value "rejected: recorded with admin and time; no refund row; ticket still paid; event still on sale" \
  "$(val "SELECT status || '/' || (decided_by = '$ADMIN_A') || '/' || (decided_at IS NOT NULL) FROM public.event_cancellation_requests WHERE id = '$RQ_REJ';")/$(val "SELECT count(*) FROM public.event_cancellation_refunds WHERE request_id = '$RQ_REJ';")/$(pstatus "$T_REJ")/$(val "SELECT status FROM public.events WHERE id = '$EV_REJ';")" \
  "rejected/true/true/0/paid/live"
expect_value "the organizer is told why" "$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND push_data->>'cancellationId' = '$RQ_REJ' AND push_data->>'stage' = 'rejected';")" "1"
expect_error "a decided request cannot be decided again" "already decided" "$(as "$ADMIN_B" "SELECT public.admin_decide_event_cancellation('$RQ_REJ', true, NULL);")"

# Two admins approving at once: exactly one decision.
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_A" "SELECT public.admin_decide_event_cancellation('$RQ', true, 'Venue confirmed closed')->>'status';")" >"$TMP/d1" 2>&1; echo "rc=$?" >>"$TMP/d1" ) &
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_B" "SELECT public.admin_decide_event_cancellation('$RQ', true, 'Venue confirmed closed')->>'status';")" >"$TMP/d2" 2>&1; echo "rc=$?" >>"$TMP/d2" ) &
wait
expect_value "two admins approving at the same time: one approval, the other refused" \
  "$(cat "$TMP/d1" "$TMP/d2" | grep -c '^rc=0$')/$(cat "$TMP/d1" "$TMP/d2" | grep -c 'already decided')" "1/1"
expect_value "approved: decided by an admin, event cancelled and off sale; 'attention' at once because one ticket was checked in" \
  "$(req_status "$RQ")/$(val "SELECT decided_by IN ('$ADMIN_A', '$ADMIN_B') FROM public.event_cancellation_requests WHERE id = '$RQ';")/$(val "SELECT (cancelled_at IS NOT NULL) || '/' || status || '/' || (cancellation_request_id = '$RQ') FROM public.events WHERE id = '$EV';")" \
  "attention/t/true/draft/true"
expect_value "one approval in the audit log" "$(val "SELECT count(*) FROM public.admin_logs WHERE action = 'event_cancellation_approved' AND details->>'cancellation_id' = '$RQ';")" "1"

echo "== 9. Sales are closed and the cancellation cannot be undone =="
expect_error "no new purchase of a cancelled event" "not currently open for ticket purchases" \
  "$(as "$OTHER" "SELECT public.create_pending_purchase('$EV', 'Regular', '[{\"name\": \"X\"}]'::jsonb, NULL, NULL);")"
expect_error "the organizer cannot put it back on sale" "cannot be put back on sale" "$(as "$ORG" "UPDATE public.events SET status = 'live' WHERE id = '$EV';")"
expect_error "nor can an admin" "cannot be put back on sale" "$(as "$ADMIN_A" "UPDATE public.events SET status = 'live' WHERE id = '$EV';")"
expect_error "the cancellation stamp cannot be cleared" "only through an approved cancellation request" "$(as "$ADMIN_A" "UPDATE public.events SET cancelled_at = NULL WHERE id = '$EV';")"
expect_error "a cancelled event cannot be deleted" "cannot be deleted" "$(as "$ADMIN_A" "UPDATE public.events SET deleted_at = now() WHERE id = '$EV';")"
expect_ok "the organizer can still edit other details (e.g. the description shown to holders)" "$(as "$ORG" "UPDATE public.events SET title = 'Lagos Jazz Night (cancelled)' WHERE id = '$EV';")"

echo "== 10-11, 21. Affected tickets and notifications =="
expect_value "refund rows: every paid ticket, by method; the earlier refund and other events excluded" \
  "$(val "SELECT string_agg(payment_method || ':' || status || ':' || amount_kobo, ',' ORDER BY payment_method, status, ticket_id) FROM public.event_cancellation_refunds WHERE request_id = '$RQ';")" \
  "free:queued:0,paystack:blocked:1015000,paystack:queued:1015000,paystack:queued:1015000,paystack:queued:1015000,wallet:queued:1015000"
expect_value "... the individually refunded ticket is not refunded again" "$(val "SELECT count(*) FROM public.event_cancellation_refunds WHERE ticket_id = '$T_PRE';")" "0"
expect_value "every ticket holder is told once (4 people, 6 tickets), and the organizer" \
  "$(val "SELECT count(*) || '/' || count(DISTINCT user_id) FROM public.notifications WHERE push_data->>'cancellationId' = '$RQ' AND push_data->>'stage' = 'cancelled';")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND push_data->>'cancellationId' = '$RQ' AND push_data->>'stage' = 'approved';")" "4/4/1"

echo "== 12-15, 24. Processing refunds =="
expect_error "an ordinary user cannot process refunds" "Admin access required" "$(as "$OTHER" "SELECT public.admin_claim_event_cancellation_refunds('$RQ', 10);")"
# Two admins pressing "Process refunds" at the same moment get disjoint tickets.
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_A" "SELECT public.admin_claim_event_cancellation_refunds('$RQ', 2)::text;")" >"$TMP/c1" 2>&1 ) &
( "${PSQL[@]}" -tA -c "$(as "$ADMIN_B" "SELECT public.admin_claim_event_cancellation_refunds('$RQ', 2)::text;")" >"$TMP/c2" 2>&1 ) &
wait
C1=$(tail -1 "$TMP/c1" | jq -r '[.tickets[].ticket_id] | join(" ")'); C2=$(tail -1 "$TMP/c2" | jq -r '[.tickets[].ticket_id] | join(" ")')
expect_value "concurrent claims never hand out the same ticket twice" \
  "$(echo "$C1 $C2" | tr ' ' '\n' | grep -c .)/$(echo "$C1 $C2" | tr ' ' '\n' | grep . | sort -u | wc -l | tr -d ' ')" "4/4"
expect_value "a claim never includes a ticket already being processed" "$(val "$(as "$ADMIN_A" "SELECT jsonb_array_length(public.admin_claim_event_cancellation_refunds('$RQ', 10)->'tickets');")")" "1"
expect_value "the checked-in ticket is never claimed automatically" "$(item "$T_CHK")" "blocked/0"
# Release the test claims so the real run below processes them (a stale claim is reclaimed after 15 minutes).
"${PSQL[@]}" -q -c "UPDATE public.event_cancellation_refunds SET status = 'queued', attempts = 0, claimed_at = NULL WHERE request_id = '$RQ' AND status = 'processing';"

# Mixed outcomes: wallet and free complete at once; Paystack goes pending.
expect_value "one processing run refunds 5 claimable tickets" "$(process "$ADMIN_A" "$RQ" ok 10)" "5"
expect_value "wallet ticket: refunded at once through the wallet ledger, exactly the N10,150 paid" \
  "$(item "$T_W")/$(pstatus "$T_W")/$(wallet "$B2")/$(val "SELECT count(*) || ':' || sum(amount_kobo) FROM public.user_wallet_transactions WHERE type = 'refund' AND reference_id = '$T_W';")" \
  "refunded/1/refunded/5000000/1:1015000"
expect_value "free RSVP: cancelled with no money moved" \
  "$(item "$T_FREE")/$(pstatus "$T_FREE")/$(val "SELECT count(*) FROM public.user_wallet_transactions WHERE reference_id = '$T_FREE';")/$(grep -c "^$T_FREE " "$PAYSTACK_LOG" || true)" "refunded/1/refunded/0/0"
expect_value "Paystack tickets: refund requested from Paystack for each ticket's own amount, pending confirmation" \
  "$(item "$T1")/$(pstatus "$T1")/$(grep "^$T1 " "$PAYSTACK_LOG" | awk '{print $2}')" "processing/1/refund_pending/1015000"
expect_value "the two tickets of one payment are refunded separately, never more than the N20,300 charged" \
  "$(awk -v a="$T1" -v b="$T2" '$1==a||$1==b {s+=$2} END {print s}' "$PAYSTACK_LOG")" "2030000"
expect_value "nothing is marked refunded before Paystack confirms" "$(req_status "$RQ")/$(val "SELECT count(*) FROM public.event_cancellation_refunds WHERE request_id = '$RQ' AND status = 'refunded';")" "attention/2"
expect_value "a second processing run while Paystack is pending starts no new refund" "$(process "$ADMIN_A" "$RQ" ok 10)/$(wc -l <"$PAYSTACK_LOG" | tr -d ' ')" "0/4"
expect_value "refund_ticket called again on a pending ticket returns no amount (the API then makes no Paystack call)" \
  "$(val "$(as "$ADMIN_A" "SELECT (public.refund_ticket('$T1', 'again') ? 'amount_kobo')::text;")")" "false"
expect_value "the wallet ticket cannot be refunded twice" "$(val "$(as "$ADMIN_A" "SELECT public.refund_ticket('$T_W', 'again')->>'status';")")/$(wallet "$B2")" "already_refunded/5000000"

echo "== 16, 19. Provider confirmation, repeated callbacks =="
EARN_BEFORE=$(val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'refund' OR description LIKE 'Refund%';")
expect_value "the webhook confirms the first Paystack refund" "$(webhook_processed "$T1")/$(item "$T1")/$(pstatus "$T1")" "finalized/refunded/1/refunded"
expect_value "the same webhook delivered again changes nothing" "$(webhook_processed "$T1")/$(item "$T1")" "already_refunded/refunded/1"
expect_value "one organizer earnings debit and one attendee notice for that ticket" \
  "$(( $(val "SELECT count(*) FROM public.organizer_transactions WHERE type = 'refund' OR description LIKE 'Refund%';") - EARN_BEFORE ))/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$B1' AND title = 'Ticket refunded';")" "1/2"

echo "== 18. A failed provider refund stays visible and is retried =="
expect_value "Paystack reports T2's refund failed: the ticket returns to paid and the row shows failed" "$(webhook_failed "$T2")/$(item "$T2")/$(pstatus "$T2")" "reverted/failed/1/paid"
expect_value "the request needs attention; the attendee is told once" \
  "$(req_status "$RQ")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$B1' AND push_data->>'stage' = 'refund_attention' AND push_data->>'ticketId' = '$T2';")" "attention/1"
expect_value "Paystack rejects the retry outright: the API reverts, the error is recorded" "$(process "$ADMIN_A" "$RQ" reject 10)/$(item "$T2")/$(pstatus "$T2")" "1/failed/2/paid"
expect_value "... with the provider's message, and no second attention notice" \
  "$(val "SELECT last_error LIKE 'rejected%' FROM public.event_cancellation_refunds WHERE ticket_id = '$T2';")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$B1' AND push_data->>'stage' = 'refund_attention' AND push_data->>'ticketId' = '$T2';")" "t/1"
expect_value "a timeout leaves the refund pending without an id; it is not retried automatically" \
  "$(process "$ADMIN_A" "$RQ" timeout 10)/$(pstatus "$T2")/$(process "$ADMIN_A" "$RQ" ok 10)" "1/refund_pending/0"
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_revert_stuck_refund('$T2', 'Checked in Paystack: no refund exists for this ticket');")"
expect_value "after an admin confirms in Paystack and reverts it, a retry succeeds and the webhook confirms it" \
  "$(process "$ADMIN_A" "$RQ" ok 10)/$(webhook_processed "$T2")/$(item "$T2")" "1/finalized/refunded/4"
expect_value "the remaining pending Paystack refund (T4) is confirmed by its webhook" "$(webhook_processed "$T4")/$(item "$T4")" "finalized/refunded/1"
expect_value "attention remains only for the checked-in ticket, which needs a manual decision" \
  "$(req_status "$RQ")/$(val "SELECT string_agg(status, ',' ORDER BY status) FROM public.event_cancellation_refunds WHERE request_id = '$RQ' AND status <> 'refunded';")" "attention/blocked"
expect_value "N refunded to the original payment sources match what was charged (no excess)" \
  "$(val "SELECT sum(amount_kobo) FROM public.event_cancellation_refunds WHERE request_id = '$RQ' AND status = 'refunded';")" "4060000"

echo "== 20, 23. History and progress =="
expect_value "the attendee still sees the event and all their tickets (nothing deleted)" \
  "$(val "$(as "$B1" "SELECT count(*) FROM public.events WHERE id = '$EV';")")/$(val "$(as "$B1" "SELECT string_agg(payment_status, ',' ORDER BY payment_status) FROM public.tickets WHERE event_id = '$EV' AND user_id = '$B1';")")" "1/refunded,refunded,refunded"
expect_value "the attendee sees their own refund statuses only" \
  "$(val "$(as "$B1" "SELECT jsonb_array_length(public.get_my_cancellation_refunds());")")/$(val "$(as "$B1" "SELECT count(*) FROM public.event_cancellation_refunds;")")/$(val "$(as "$OTHER" "SELECT count(*) FROM public.event_cancellation_refunds;")")" "2/2/0"
expect_value "the organizer sees the request and refund progress" \
  "$(val "$(as "$ORG" "SELECT (c->>'status') || '/' || (c->'refunds'->>'total') || '/' || (c->'refunds'->>'refunded') || '/' || (c->'refunds'->>'needs_attention') FROM jsonb_array_elements(public.get_my_event_cancellations()) c WHERE c->>'id' = '$RQ';")")" "attention/6/5/1"
expect_value "another organizer sees nothing of it" "$(val "$(as "$ORG2" "SELECT jsonb_array_length(public.get_my_event_cancellations());")")/$(val "$(as "$ORG2" "SELECT count(*) FROM public.event_cancellation_requests;")")" "0/0"
expect_value "the original purchase records are intact" "$(val "SELECT count(*) FROM public.pending_purchases WHERE payment_ref IN ('$REF_B1', '$REF_W');")" "2"

echo "== Completion: the last refund done manually, the request completes =="
"${PSQL[@]}" -q -c "UPDATE public.tickets SET checked_in = false WHERE id = '$T_CHK';"
"${PSQL[@]}" -q -c "UPDATE public.event_cancellation_refunds SET status = 'queued', last_error = NULL WHERE ticket_id = '$T_CHK';"
expect_value "after an admin decides to refund it, the last ticket is processed and confirmed" "$(process "$ADMIN_A" "$RQ" ok 10)/$(webhook_processed "$T_CHK")" "1/finalized"
expect_value "the request completes and the organizer is told once" \
  "$(req_status "$RQ")/$(val "SELECT completed_at IS NOT NULL FROM public.event_cancellation_requests WHERE id = '$RQ';")/$(val "SELECT count(*) FROM public.notifications WHERE user_id = '$ORG' AND push_data->>'cancellationId' = '$RQ' AND push_data->>'stage' = 'completed';")" "completed/t/1"
expect_value "no ticket was ever confirmed refunded twice" \
  "$(val "SELECT count(*) FROM (SELECT details->>'ticket_id' FROM public.admin_logs WHERE action = 'refund_ticket_finalized' GROUP BY 1 HAVING count(*) > 1) d;")" "0"
expect_value "a second Paystack refund was only ever requested after the provider failed the first (T2 only)" \
  "$(awk '$3=="ok"{print $1}' "$PAYSTACK_LOG" | sort | uniq -d | tr '\n' ' ')" "$T2 "
expect_error "undo_0218 is refused once a cancellation exists" "requests exist" "SET vents.rollback_confirm = 'undo-0218'; $(cat "$REPO_ROOT/supabase/rollback/undo_0218.sql")"

echo "== A payment that completes after the cancellation is refunded too =="
RQ_RACE=$(val "$(as "$ORG" "SELECT public.request_event_cancellation('$EV_RACE', 'Headliner withdrew from the show')->>'id';")")
REF_LATE=$(val "$(as "$B4" "SELECT public.create_pending_purchase('$EV_RACE', 'Regular', '[{\"name\": \"Late\"}]'::jsonb, NULL, NULL)->>'payment_ref';")")
"${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$REF_LATE');" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ADMIN_B" "SELECT public.admin_decide_event_cancellation('$RQ_RACE', true, NULL);")" >/dev/null
"${PSQL[@]}" -q -c "SELECT public.confirm_ticket_payment('$REF_LATE', $(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$REF_LATE';"));" >/dev/null
T_LATE=$(tickets_of "$REF_LATE")
expect_value "the late-paid ticket is queued for a refund automatically" "$(item "$T_LATE")" "queued/0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES EVENT CANCELLATION (0218) CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
