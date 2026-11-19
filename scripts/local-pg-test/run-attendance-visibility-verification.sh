#!/usr/bin/env bash
# Event attendance visibility (migration 0221): an organizer can hide the
# public attendance count of their event. Builds the same local money stack
# as the other money harnesses (0201 -> 0217, 0218, 0219, and the production
# ticket purchase / QR / check-in / refund functions, verbatim, from
# schema-attendance-visibility-base.sql), loads the three public count RPCs exactly as the repository
# defines them before 0221 (schema-attendance-visibility.sql, re-checked
# against the migrations on every run), REPRODUCES that every count is public,
# then applies 0221 and proves, through the real functions and RLS:
#   * the public (anon, signed-in strangers, other organizers, ticket holders)
#     gets no count from get_event_ticket_stats, get_event_ticket_type_availability
#     or get_event_trending_scores when the organizer hides it;
#   * the organizer, admins and sub-admins keep their figures;
#   * only the organizer/admin can change the setting; changing it touches
#     nothing else; purchases, QR passes, check-in and refunds still work;
#   * sold-out state still reaches buyers; ON restores counts at once;
#   * owner / SECURITY DEFINER / search_path / grants are preserved; undo and
#     re-apply are exact; a drifted function makes 0221 refuse and change nothing.
# Not under test: rate limits (check_rate_limit is a local no-op stub).
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files. No network, no Paystack.
#
# Usage: scripts/local-pg-test/run-attendance-visibility-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_attendance_visibility"
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
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1 || { echo "VALERR: $(cat "$ERR")" >&2; return 1; }; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
expect_error() {
  if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an exception, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error)"; cat "$ERR" >&2; fi
}
# Paystack checkout as production runs it: create_pending_purchase as the
# buyer, then the webhook/verify server connection runs finalize_pending_purchase
# and confirm_ticket_payment with the amount Paystack charged. A failure in
# either server call is reported (never swallowed): the ref comes back prefixed.
buy() {  # buy <buyer> <event> <attendees> [payer email] -> payment_ref
  local att; att=$(python3 -c "import json,sys; print(json.dumps([{'name': 'A%d' % i} for i in range(int(sys.argv[1]))]))" "$3")
  local payer="NULL"; [ -n "${4:-}" ] && payer="'$4'"
  local ref; ref=$(val "$(as "$1" "SELECT public.create_pending_purchase('$2', 'Regular', '$att'::jsonb, NULL, $payer)->>'payment_ref';")")
  local amount; amount=$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$ref';")
  if ! "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$ref');" >/dev/null 2>>"$TMP/server.err"; then echo "finalize-failed:$ref"; return; fi
  if ! "${PSQL[@]}" -q -c "SELECT public.confirm_ticket_payment('$ref', $amount);" >/dev/null 2>>"$TMP/server.err"; then echo "confirm-failed:$ref"; return; fi
  echo "$ref"
}
# VENTS Wallet checkout as the app runs it (CheckoutScreen -> userWallet.ts):
# create_pending_purchase, then ONE call to confirm_ticket_payment_via_wallet
# as the buyer. No server-side pre-finalize: the wallet function's own first
# call creates the tickets.
wallet_start() {  # wallet_start <buyer> <event> <attendees> -> payment_ref
  local att; att=$(python3 -c "import json,sys; print(json.dumps([{'name': 'W%d' % i} for i in range(int(sys.argv[1]))]))" "$3")
  val "$(as "$1" "SELECT public.create_pending_purchase('$2', 'Regular', '$att'::jsonb, NULL, NULL)->>'payment_ref';")"
}
wallet_pay() {  # wallet_pay <buyer> <ref> -> the function's result, or error:<message>
  if "${PSQL[@]}" -tA -c "$(as "$1" "SELECT 'R=' || public.confirm_ticket_payment_via_wallet('$2');")" >"$OUT" 2>"$ERR"; then
    grep -m1 '^R=' "$OUT" | cut -c3-
  else
    echo "error:$(grep -m1 'ERROR' "$ERR" | sed 's/^ERROR: *//')"
  fi
}
buy_wallet() { local r; r=$(wallet_start "$1" "$2" 1); wallet_pay "$1" "$r" >/dev/null; echo "$r"; }  # buy_wallet <buyer> <event>
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



echo "== Migrations 0218 + 0219, and the ticket purchase / QR / check-in / transfer functions (verbatim repo copies) =="
expect_ok "0218 applies" "$(cat "$MIG/0218_event_cancellation_workflow.sql")"
expect_ok "0219 applies" "$(cat "$MIG/0219_event_cancellation_safety_fixes.sql")"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-attendance-visibility-base.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
DO \$r\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'project_admin') THEN CREATE ROLE project_admin; END IF; END \$r\$;
GRANT USAGE ON SCHEMA public TO project_admin;
-- The repository's grants on these functions, exactly: 0011_grants.sql, then
-- 0104 (no anon check-in) and 0133 (no anon QR signing).
REVOKE ALL ON FUNCTION public.purchase_ticket(uuid,text,jsonb,text,text), public.purchase_ticket_with_tokens(uuid,text,jsonb,text,text),
  public.generate_ticket_token(uuid), public.verify_entry_pass(text,uuid,text,text), public.manual_check_in(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.purchase_ticket(uuid,text,jsonb,text,text), public.purchase_ticket_with_tokens(uuid,text,jsonb,text,text)
  TO anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.generate_ticket_token(uuid), public.verify_entry_pass(text,uuid,text,text), public.manual_check_in(uuid,uuid,text,text)
  TO authenticated, project_admin;
-- Transfer grants, exactly as 0040 / 0043.
REVOKE ALL ON FUNCTION public.initiate_ticket_transfer(uuid,text), public.accept_ticket_transfer(uuid), public.initiate_transfer_fee_payment(uuid),
  public.confirm_transfer_fee_payment(text,bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.initiate_ticket_transfer(uuid,text), public.accept_ticket_transfer(uuid), public.initiate_transfer_fee_payment(uuid)
  TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_transfer_fee_payment(text,bigint) TO project_admin;
REVOKE ALL ON FUNCTION public.compute_transfer_fee_kobo(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_transfer_fee_kobo(numeric) TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.request_event_cancellation(uuid,text), public.admin_decide_event_cancellation(uuid,boolean,text) TO authenticated;
GRANT SELECT ON public.scan_log TO authenticated;
-- Test data: an event with a free tier and two paid tiers; a small free event
-- for the inventory race; a one-seat paid event for the wallet rollback.
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types, ticket_goal) VALUES
  ('00000000-0000-0000-0000-0000000c1e01', '$ORG', 'Integrity night', now() + interval '20 days', 'live',
   '[{"name": "Free", "price": 0}, {"name": "VIP", "price": 25000}, {"name": "Regular", "price": 10000}]', 200),
  ('00000000-0000-0000-0000-0000000c1e02', '$ORG', 'Last seat', now() + interval '20 days', 'live',
   '[{"name": "Free", "price": 0}]', 3),
  ('00000000-0000-0000-0000-0000000c1e03', '$ORG', 'One seat', now() + interval '20 days', 'live',
   '[{"name": "Regular", "price": 10000}]', 1);
INSERT INTO public.promo_codes (code, discount_percentage) VALUES ('ALLFREE', 100), ('HALF', 50);
SQL
EVI="00000000-0000-0000-0000-0000000c1e01"; EVS="00000000-0000-0000-0000-0000000c1e02"; EV1="00000000-0000-0000-0000-0000000c1e03"
tok() { val "$(as "$1" "SELECT public.generate_ticket_token('$2');")"; }                       # tok <owner> <ticket>
tok_or_none() { val "$(as "$1" "SELECT COALESCE(public.generate_ticket_token('$2'), 'none');")"; }
scan_by() { val "$(as "$1" "SELECT (r->>'ok') || '/' || COALESCE(r->>'reason', '') FROM (SELECT public.verify_entry_pass('$2', '$1') AS r) q;")"; }
manual_by() { val "$(as "$1" "SELECT (r->>'ok') || '/' || COALESCE(r->>'reason', '') FROM (SELECT public.manual_check_in('$2', '$1') AS r) q;")"; }
scan() { scan_by "$ORG" "$1"; }
manual() { manual_by "$ORG" "$1"; }
state() { val "SELECT status || '/' || payment_status FROM public.tickets WHERE id = '$1';"; }
direct_buy() {  # direct_buy <user> <event> <tier> <ref> [promo] -> ticket ids, or the error
  local out; out=$(val "$(as "$1" "SELECT array_to_string(public.purchase_ticket('$2', '$3', '[{\"name\": \"Direct\"}]'::jsonb, '$4', ${5:-NULL}), ' ');")")
  # On an error psql still prints the SET lines, so only a uuid list counts as success.
  if [[ "$out" =~ ^[0-9a-f-]{36}( [0-9a-f-]{36})*$ ]]; then echo "$out"; else echo "error:$(grep -m1 'ERROR' "$ERR")"; fi
}

echo "== The pre-0221 count RPCs (verbatim repo copies) =="
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-attendance-visibility.sql" >/dev/null
if python3 -I "$SCRIPT_DIR/check-verbatim-functions.py" --before 0221 "$REPO_ROOT" "$SCRIPT_DIR/schema-attendance-visibility.sql" \
     get_event_ticket_stats get_event_ticket_type_availability get_event_trending_scores >"$OUT" 2>&1; then
  pass "the three count RPCs are byte-identical to their latest pre-0221 definition (0004)"
else fail "a count RPC copy differs from its migration"; cat "$OUT" >&2; fi
for pair in "schema-attendance-visibility-base.sql:purchase_ticket generate_ticket_token verify_entry_pass manual_check_in" \
            "live-money-functions.sql:create_pending_purchase finalize_pending_purchase confirm_ticket_payment confirm_ticket_payment_via_wallet refund_ticket"; do
  # shellcheck disable=SC2086
  if python3 -I "$SCRIPT_DIR/check-verbatim-functions.py" "$REPO_ROOT" "$SCRIPT_DIR/${pair%%:*}" ${pair#*:} >"$OUT" 2>&1; then
    pass "${pair%%:*}: the purchase / QR / check-in functions are the repository's"
  else fail "${pair%%:*}: a function differs from its migration"; cat "$OUT" >&2; fi
done
# Test data: an event with tier quantities (EVQ), saves for the trending score.
EVQ="00000000-0000-0000-0000-0000000c1e04"
"${PSQL[@]}" -q <<SQL
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types, ticket_goal) VALUES
  ('$EVQ', '$ORG', 'Tiered night', now() + interval '20 days', 'live',
   '[{"name": "Early", "price": 5000, "quantity": 2}, {"name": "Late", "price": 8000, "quantity": 5}]', 100);
INSERT INTO public.saved_events (user_id, event_id) VALUES ('$B1', '$EVI'), ('$B2', '$EVI'), ('$B3', '$EVI');
-- Production table grants on events (0012_fix_default_table_grants.sql): anon
-- holds SELECT/INSERT/UPDATE/DELETE; only RLS (0008 policies) limits writes.
GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO anon;
SQL
buy_tier() {  # buy_tier <buyer> <event> <tier> -> payment_ref (Paystack: create_pending_purchase -> finalize -> confirm)
  local ref; ref=$(val "$(as "$1" "SELECT public.create_pending_purchase('$2', '$3', '[{\"name\": \"T\"}]'::jsonb, NULL, NULL)->>'payment_ref';")")
  local amount; amount=$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$ref';")
  "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$ref');" >/dev/null 2>>"$TMP/server.err" || { echo "finalize-failed:$ref"; return; }
  "${PSQL[@]}" -q -c "SELECT public.confirm_ticket_payment('$ref', $amount);" >/dev/null 2>>"$TMP/server.err" || { echo "confirm-failed:$ref"; return; }
  echo "$ref"
}
anon() { printf "SET ROLE anon; %s" "$1"; }
# get_event_ticket_stats as <who> for <event ids>: "sold/quantity/pending/cancelled/refunded/revenue" per row, or "none"
stats_as() {  # stats_as <sql-prefix-fn: anon|as> <uid or -> <event id>
  local q="SELECT COALESCE(string_agg(COALESCE(sold_count::text, 'null') || '/' || COALESCE(sold_quantity::text, 'null') || '/' || COALESCE(pending_count::text, 'null') || '/' || COALESCE(cancelled_count::text, 'null') || '/' || COALESCE(refunded_count::text, 'null') || '/' || COALESCE(revenue_kobo::text, 'null'), ';'), 'none') FROM public.get_event_ticket_stats(ARRAY['$3']::uuid[]);"
  if [ "$1" = anon ]; then val "$(anon "$q")"; else val "$(as "$2" "$q")"; fi
}
avail_as() {  # avail_as <anon|as> <uid or -> <event id>: "type=sold:sold_out" sorted
  local q="SELECT string_agg(COALESCE(ticket_type, '?') || '=' || COALESCE(sold_count::text, 'null') || ':' || sold_out::text, ' ' ORDER BY ticket_type) FROM public.get_event_ticket_type_availability('$3');"
  if [ "$1" = anon ]; then val "$(anon "$q")"; else val "$(as "$2" "$q")"; fi
}
trend_as() {  # trend_as <anon|as> <uid or -> <event id>: "score/recent/total/saves"
  local q="SELECT trending_score::numeric(10,1)::text || '/' || COALESCE(recent_sold::text, 'null') || '/' || COALESCE(total_sold::text, 'null') || '/' || save_count FROM public.get_event_trending_scores(ARRAY['$3']::uuid[]);"
  if [ "$1" = anon ]; then val "$(anon "$q")"; else val "$(as "$2" "$q")"; fi
}
set_visibility() {  # set_visibility <as uid> <event> <true|false> -> rows updated (the app's own UPDATE, through RLS)
  val "$(as "$1" "WITH u AS (UPDATE public.events SET show_attendance_count = $3 WHERE id = '$2' RETURNING 1) SELECT count(*) FROM u;")"
}
event_fingerprint() { val "SELECT md5((to_jsonb(e) - 'show_attendance_count')::text) FROM public.events e WHERE id = '$1';"; }  # every column but the setting
tickets_fingerprint() { val "SELECT md5(COALESCE(string_agg(row(id, user_id, status, payment_status, payment_method, amount, checked_in, ticket_type)::text, '|' ORDER BY id), '')) FROM public.tickets WHERE event_id = '$1';"; }
fn_attrs() {  # owner, SECURITY DEFINER, config, volatility and full ACL of one function
  val "SELECT pg_get_userbyid(p.proowner) || ' ' || p.prosecdef || ' ' || COALESCE(array_to_string(p.proconfig, ','), '') || ' ' || p.provolatile::text || ' '
         || COALESCE((SELECT string_agg(g, ',' ORDER BY g) FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS g FROM aclexplode(p.proacl) a) x), 'DEFAULT')
         FROM pg_proc p WHERE p.oid = '$1'::regprocedure;"
}
SIG_STATS='public.get_event_ticket_stats(uuid[])'; SIG_AVAIL='public.get_event_ticket_type_availability(uuid)'; SIG_TREND='public.get_event_trending_scores(uuid[])'
body_md5s() { val "SELECT string_agg(proname || '=' || md5(prosrc), ' ' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('get_event_ticket_stats', 'get_event_ticket_type_availability', 'get_event_trending_scores');"; }
has_column() { val "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'show_attendance_count';"; }

# Sales on EVI: two paid Paystack tickets, one paid wallet ticket, one left pending
# by an insufficient wallet balance (the real path that leaves a ticket unpaid).
REF_A=$(buy "$B1" "$EVI" 2); REF_W=$(buy_wallet "$B2" "$EVI")
REF_PEND=$(wallet_start "$B3" "$EVI" 1); PEND_RESULT=$(wallet_pay "$B3" "$REF_PEND")
expect_value "test data: 3 paid tickets and 1 unpaid (insufficient wallet balance) on the event" \
  "$(val "SELECT count(*) FILTER (WHERE payment_status = 'paid') || '/' || count(*) FILTER (WHERE payment_status = 'pending') FROM public.tickets WHERE event_id = '$EVI';")/${PEND_RESULT%%:*}" \
  "3/1/insufficient_balance"

echo "== Reproduction: before 0221 every count is public =="
expect_value "anon reads the sold count AND the pending/cancelled/refunded counts" "$(stats_as anon - "$EVI")" "3/3/1/0/0/null"
expect_value "anon reads per-tier counts (pending included) from get_event_ticket_type_availability" \
  "$(val "$(anon "SELECT string_agg(ticket_type || '=' || sold_count, ' ' ORDER BY ticket_type) FROM public.get_event_ticket_type_availability('$EVI');")")" "Regular=4"
expect_value "anon reads recent_sold / total_sold (pending included) from get_event_trending_scores" "$(trend_as anon - "$EVI")" "31.0/4/4/3"
ATTR_STATS=$(fn_attrs "$SIG_STATS"); ATTR_AVAIL=$(fn_attrs "$SIG_AVAIL"); ATTR_TREND=$(fn_attrs "$SIG_TREND")
expect_value "baseline: all three SECURITY DEFINER, search_path '', executable by anon/authenticated/project_admin, not PUBLIC" \
  "$(echo "$ATTR_STATS|$ATTR_AVAIL|$ATTR_TREND" | grep -o 'postgres true search_path="" s anon:EXECUTE,authenticated:EXECUTE,postgres:EXECUTE,project_admin:EXECUTE' | wc -l | tr -d ' ')" "3"
MD5_BEFORE=$(body_md5s)
ORG_STATS_BEFORE=$(stats_as as "$ORG" "$EVI")

echo "== Applying 0221 =="
expect_ok "0221 applies" "$(cat "$MIG/0221_event_attendance_visibility.sql")"
MD5_AFTER=$(body_md5s)
expect_ok "0221 is idempotent (second run)" "$(cat "$MIG/0221_event_attendance_visibility.sql")"
expect_value "... the second run changes no function body" "$(body_md5s)" "$MD5_AFTER"
expect_value "the column is boolean NOT NULL DEFAULT true" \
  "$(val "SELECT data_type || '/' || is_nullable || '/' || column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'show_attendance_count';")" "boolean/NO/true"
expect_value "every existing event keeps its count public (backfilled true)" "$(val "SELECT count(*) FILTER (WHERE NOT show_attendance_count) || '/' || count(*) FROM public.events;")" "0/$(val "SELECT count(*) FROM public.events;")"
expect_value "owner, SECURITY DEFINER, search_path, volatility and grants unchanged: get_event_ticket_stats" "$(fn_attrs "$SIG_STATS")" "$ATTR_STATS"
expect_value "... get_event_ticket_type_availability (dropped and re-created)" "$(fn_attrs "$SIG_AVAIL")" "$ATTR_AVAIL"
expect_value "... get_event_trending_scores" "$(fn_attrs "$SIG_TREND")" "$ATTR_TREND"
expect_value "the organizer's own figures are unchanged by the migration" "$(stats_as as "$ORG" "$EVI")" "$ORG_STATS_BEFORE"
NEW_EV=$(val "WITH i AS (INSERT INTO public.events (organizer_id, title, event_date, status, ticket_types) VALUES ('$ORG', 'Default check', now() + interval '9 days', 'live', '[]') RETURNING id) SELECT id FROM i;")
expect_value "a new event defaults to showing its count" "$(val "SELECT show_attendance_count::text FROM public.events WHERE id = '$NEW_EV';")" "true"

echo "== Visibility ON (default) =="
expect_value "public viewer (anon) sees the sold count (paid tickets only), not pending/cancelled/refunded/revenue" "$(stats_as anon - "$EVI")" "3/3/null/null/null/null"
expect_value "a signed-in non-organizer sees the same" "$(stats_as as "$OTHER" "$EVI")" "3/3/null/null/null/null"
expect_value "the organizer sees the full analytics" "$(stats_as as "$ORG" "$EVI")" "$ORG_STATS_BEFORE"
expect_value "availability: one row per tier, live counts, nothing sold out" "$(avail_as anon - "$EVI")" "Free=0:false Regular=4:false VIP=0:false"
expect_value "trending: same score as before 0221; raw sales figures withheld from the public" "$(trend_as anon - "$EVI")" "31.0/null/null/3"
expect_value "... and given to the organizer" "$(trend_as as "$ORG" "$EVI")" "31.0/4/4/3"

echo "== The organizer turns the count OFF =="
FP_EVENT=$(event_fingerprint "$EVI"); FP_TICKETS=$(tickets_fingerprint "$EVI")
expect_value "the organizer's own UPDATE (through RLS) changes the setting" "$(set_visibility "$ORG" "$EVI" false)/$(val "SELECT show_attendance_count::text FROM public.events WHERE id = '$EVI';")" "1/false"
expect_value "... without touching any other column of the event (status, tiers, capacity, price, visibility, promotion, ...)" "$(event_fingerprint "$EVI")" "$FP_EVENT"
expect_value "... or any ticket (ownership, payment, check-in)" "$(tickets_fingerprint "$EVI")" "$FP_TICKETS"
expect_value "public viewer (anon) gets no count at all (no row)" "$(stats_as anon - "$EVI")" "none"
expect_value "a signed-in non-organizer gets no row" "$(stats_as as "$OTHER" "$EVI")" "none"
expect_value "another organizer gets no row" "$(stats_as as "$ORG2" "$EVI")" "none"
expect_value "a ticket holder of the event gets no row" "$(stats_as as "$B1" "$EVI")" "none"
expect_value "the organizer still gets the full analytics" "$(stats_as as "$ORG" "$EVI")" "$ORG_STATS_BEFORE"
expect_value "an admin still gets them" "$(stats_as as "$ADMIN_A" "$EVI")" "$ORG_STATS_BEFORE"
expect_value "a sub-admin still gets them" "$(stats_as as "$SUB" "$EVI")" "$ORG_STATS_BEFORE"
buy "$B1" "$EV_OTHER" 1 >/dev/null   # a sale on another organizer's (visible) event
expect_value "a mixed request returns only the events that show their count" \
  "$(val "$(anon "SELECT string_agg(event_id::text || ':' || sold_count, ',') FROM public.get_event_ticket_stats(ARRAY['$EVI', '$EV_OTHER']::uuid[]);")")" "$EV_OTHER:1"
expect_value "alternate endpoint: availability gives the public no counts, only sold-out state" "$(avail_as anon - "$EVI")" "Free=null:false Regular=null:false VIP=null:false"
expect_value "... the organizer still sees the live counts" "$(avail_as as "$ORG" "$EVI")" "Free=0:false Regular=4:false VIP=0:false"
expect_value "alternate endpoint: trending scores the hidden event on saves only, for everyone, and gives no raw figures" "$(trend_as anon - "$EVI")" "3.0/null/null/3"
expect_value "... the organizer gets the raw figures (score is the same for everyone)" "$(trend_as as "$ORG" "$EVI")" "3.0/4/4/3"
expect_value "anon cannot change the setting (it holds UPDATE, as in production; RLS matches no row)" \
  "$(val "$(anon "WITH u AS (UPDATE public.events SET show_attendance_count = true WHERE id = '$EVI' RETURNING 1) SELECT count(*) FROM u;")")/$(val "SELECT show_attendance_count::text FROM public.events WHERE id = '$EVI';")" "0/false"
expect_value "another organizer cannot change it (RLS: 0 rows)" "$(set_visibility "$ORG2" "$EVI" true)/$(val "SELECT show_attendance_count::text FROM public.events WHERE id = '$EVI';")" "0/false"
expect_value "a ticket holder cannot change it (RLS: 0 rows)" "$(set_visibility "$B1" "$EVI" true)/$(val "SELECT show_attendance_count::text FROM public.events WHERE id = '$EVI';")" "0/false"
expect_value "an admin can change it (existing admin update rights)" "$(set_visibility "$ADMIN_A" "$EVI" false)" "1"

echo "== Hidden count: the event stays visible and works normally =="
expect_value "the event is still live and readable by the public" "$(val "$(anon "SELECT status FROM public.events WHERE id = '$EVI';")")" "live"
REF_H=$(buy "$B4" "$EVI" 1); TH=$(tickets_of "$REF_H")
expect_value "a Paystack purchase still completes" "$(state "$TH")" "active/paid"
TH_TOK=$(tok "$B4" "$TH")
expect_value "the buyer gets a QR pass and checks in by QR" "$([ -n "$TH_TOK" ] && echo signed)/$(scan "$TH_TOK")" "signed/true/"
REF_HW=$(buy_wallet "$B2" "$EVI"); THW=$(tickets_of "$REF_HW")
expect_value "a wallet purchase still completes and checks in manually" "$(state "$THW")/$(manual "$THW")" "active/paid/true/"
FREE_T=$(val "$(as "$B1" "SELECT array_to_string(public.purchase_ticket('$EVI', 'Free', '[{\"name\": \"F\"}]'::jsonb, 'AV-FREE-1', NULL), ' ');")")
expect_value "a free RSVP still works" "$(state "$FREE_T")" "active/paid"
expect_value "the public still gets no count after the new sales" "$(stats_as anon - "$EVI")" "none"
expect_value "the organizer's analytics include the new sales" "$(stats_as as "$ORG" "$EVI" | cut -d/ -f1,3)" "6/1"
REF_HR=$(buy_wallet "$B2" "$EVI"); THR=$(tickets_of "$REF_HR")   # an unused ticket (a checked-in one cannot be refunded)
"${PSQL[@]}" -q -c "$(as "$ORG" "SELECT public.refund_ticket('$THR', 'Organizer refund');")" >/dev/null
expect_value "a refund still works; the refunded ticket leaves the organizer's sold count" "$(state "$THR")/$(stats_as as "$ORG" "$EVI" | cut -d/ -f1,5)" "cancelled/refunded/6/1"

echo "== Sold-out state is still shown while counts are hidden =="
buy_tier "$B1" "$EVQ" Early >/dev/null; buy_tier "$B2" "$EVQ" Early >/dev/null
expect_value "visible event: Early (quantity 2) sold out, Late not" "$(avail_as anon - "$EVQ")" "Early=2:true Late=0:false"
expect_value "hidden event: the same sold-out state, no counts" "$(set_visibility "$ORG" "$EVQ" false)/$(avail_as anon - "$EVQ")" "1/Early=null:true Late=null:false"
# Capacity is enforced at finalize_pending_purchase (create_pending_purchase does not check it; existing behaviour).
expect_value "... and the purchase path still enforces the tier limit (finalize refuses)" "$(buy_tier "$B3" "$EVQ" Early | cut -d: -f1)/$(grep -c 'Only 0 Early ticket(s) remaining' "$TMP/server.err")" "finalize-failed/1"
buy "$B3" "$EV1" 1 >/dev/null
expect_value "an event at its ticket_goal shows every tier sold out" "$(set_visibility "$ORG" "$EV1" false)/$(avail_as anon - "$EV1")" "1/Regular=null:true"

echo "== The organizer turns the count back ON =="
expect_value "the public sees the current count again, with no new sale needed" "$(set_visibility "$ORG" "$EVI" true)/$(stats_as anon - "$EVI" | cut -d/ -f1)" "1/6"
expect_value "availability counts are back" "$(avail_as anon - "$EVI" | grep -o 'Regular=[0-9]*')" "Regular=6"
expect_value "trending uses sales again" "$(trend_as anon - "$EVI" | cut -d/ -f2-)" "null/null/3"

echo "== Undo 0221 =="
expect_error "undo_0221 refuses without the confirmation" "undo-0221" "$(cat "$REPO_ROOT/supabase/rollback/undo_0221.sql")"
expect_error "undo_0221 refuses while organizers hide their counts (it would re-expose them)" "rollback_reexpose_hidden_counts" \
  "SET vents.rollback_confirm = 'undo-0221'; $(cat "$REPO_ROOT/supabase/rollback/undo_0221.sql")"
expect_ok "undo_0221 runs with both confirmations" "SET vents.rollback_confirm = 'undo-0221'; SET vents.rollback_reexpose_hidden_counts = 'yes'; $(cat "$REPO_ROOT/supabase/rollback/undo_0221.sql")"
expect_value "the exact pre-0221 bodies are back" "$(body_md5s)" "$MD5_BEFORE"
expect_value "... with the same owner, SECURITY DEFINER, search_path and grants" "$(fn_attrs "$SIG_STATS")|$(fn_attrs "$SIG_AVAIL")|$(fn_attrs "$SIG_TREND")" "$ATTR_STATS|$ATTR_AVAIL|$ATTR_TREND"
expect_value "... and the column is gone" "$(has_column)" "0"

echo "== Drift: 0221 refuses a function that is not the expected version, and changes nothing =="
"${PSQL[@]}" -q -c "DO \$d\$ DECLARE v text := pg_get_functiondef('$SIG_TREND'::regprocedure); BEGIN EXECUTE replace(v, 'momentum matters more', 'momentum  matters more'); END \$d\$;" >/dev/null
MD5_DRIFT=$(body_md5s)
if pg -d "$DB_NAME" -1 -f "$MIG/0221_event_attendance_visibility.sql" >"$OUT" 2>"$ERR"; then
  fail "0221 refuses over a drifted get_event_trending_scores (it applied)"
else
  expect_value "0221 refuses and names the drifted function" "$(grep -m1 -o 'public.get_event_trending_scores(uuid\[\]) is not the expected version' "$ERR" || cat "$ERR")" "public.get_event_trending_scores(uuid[]) is not the expected version"
fi
expect_value "... no column was added and no function changed" "$(has_column)/$(body_md5s)" "0/$MD5_DRIFT"
"${PSQL[@]}" -q -c "DO \$d\$ DECLARE v text := pg_get_functiondef('$SIG_TREND'::regprocedure); BEGIN EXECUTE replace(v, 'momentum  matters more', 'momentum matters more'); END \$d\$;" >/dev/null
expect_ok "with the drift removed, 0221 re-applies" "$(cat "$MIG/0221_event_attendance_visibility.sql")"
expect_value "... to the same bodies as the first apply, with the same attributes" "$(body_md5s)|$(fn_attrs "$SIG_AVAIL")" "$MD5_AFTER|$ATTR_AVAIL"
expect_value "... and every event is public again by default" "$(val "SELECT count(*) FILTER (WHERE NOT show_attendance_count) FROM public.events;")" "0"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES ATTENDANCE VISIBILITY (0221) CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
