#!/usr/bin/env bash
# Ticket payment integrity (OEL-01, migration 0220): no ticket for a paid tier
# can be used for entry without a confirmed payment. Runs on the same local
# money stack as run-event-cancellation-verification.sh (0201 -> 0217 plus the
# production ticket/refund functions), with 0218 + 0219 applied and the
# ticket purchase / QR / check-in functions loaded verbatim from the repo
# (schema-ticket-integrity.sql). It first REPRODUCES the hole (before 0220),
# then proves the fix and that free, Paystack, wallet and transferred tickets,
# capacity, duplicates, refunds and cancellations still behave.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files. No network, no Paystack.
#
# Usage: scripts/local-pg-test/run-ticket-integrity-verification.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_ticket_integrity"
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


echo "== Migrations 0218 + 0219, and the ticket purchase / QR / check-in functions (verbatim repo copies) =="
expect_ok "0218 applies" "$(cat "$MIG/0218_event_cancellation_workflow.sql")"
expect_ok "0219 applies" "$(cat "$MIG/0219_event_cancellation_safety_fixes.sql")"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-ticket-integrity.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
GRANT EXECUTE ON FUNCTION public.purchase_ticket(uuid,text,jsonb,text,text), public.purchase_ticket_with_tokens(uuid,text,jsonb,text,text),
  public.generate_ticket_token(uuid), public.verify_entry_pass(text,uuid,text,text), public.manual_check_in(uuid,uuid,text,text),
  public.request_event_cancellation(uuid,text), public.admin_decide_event_cancellation(uuid,boolean,text) TO authenticated;
GRANT SELECT ON public.scan_log TO authenticated;
-- An event with a free tier and a paid tier, capacity 6; and a small free event for the inventory race.
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types, ticket_goal) VALUES
  ('00000000-0000-0000-0000-0000000c1e01', '$ORG', 'Integrity night', now() + interval '20 days', 'live',
   '[{"name": "Free", "price": 0}, {"name": "VIP", "price": 25000}, {"name": "Regular", "price": 10000}]', 50),
  ('00000000-0000-0000-0000-0000000c1e02', '$ORG', 'Last seat', now() + interval '20 days', 'live',
   '[{"name": "Free", "price": 0}]', 3);
INSERT INTO public.promo_codes (code, discount_percentage) VALUES ('ALLFREE', 100), ('HALF', 50);
SQL
EVI="00000000-0000-0000-0000-0000000c1e01"; EVS="00000000-0000-0000-0000-0000000c1e02"
tok() { val "$(as "$1" "SELECT public.generate_ticket_token('$2');")"; }          # tok <owner> <ticket>
scan() { val "$(as "$ORG" "SELECT (r->>'ok') || '/' || COALESCE(r->>'reason', '') FROM (SELECT public.verify_entry_pass('$1', '$ORG') AS r) q;")"; }
manual() { val "$(as "$ORG" "SELECT (r->>'ok') || '/' || COALESCE(r->>'reason', '') FROM (SELECT public.manual_check_in('$1', '$ORG') AS r) q;")"; }
direct_buy() {  # direct_buy <user> <event> <tier> <ref> [promo] -> ticket ids, or the error
  local out; out=$(val "$(as "$1" "SELECT array_to_string(public.purchase_ticket('$2', '$3', '[{\"name\": \"Direct\"}]'::jsonb, '$4', ${5:-NULL}), ' ');")")
  # On an error psql still prints the SET lines, so only a uuid list counts as success.
  if [[ "$out" =~ ^[0-9a-f-]{36}( [0-9a-f-]{36})*$ ]]; then echo "$out"; else echo "error:$(grep -m1 'ERROR' "$ERR")"; fi
}

echo "== Reproduction: before 0220 (the vulnerability) =="
P1=$(direct_buy "$B4" "$EVI" VIP REPRO-1)
expect_value "a direct purchase_ticket call on a paid tier creates a ticket without any payment" \
  "$(val "SELECT status || '/' || payment_status FROM public.tickets WHERE id = '$P1';")" "active/pending"
P1_TOK=$(tok "$B4" "$P1")
expect_value "... its holder gets a signed entry pass" "$([ -n "$P1_TOK" ] && echo signed)" "signed"
expect_value "... and the pass checks in at the door (QR scan)" "$(scan "$P1_TOK")" "true/"
P2=$(direct_buy "$B3" "$EVI" Regular REPRO-2)
P2_TOK=$(tok "$B3" "$P2")             # minted before the fix; used after it
P3=$(direct_buy "$B1" "$EVI" Regular REPRO-3)
expect_value "... and an unpaid ticket also passes manual check-in" "$(manual "$P3")" "true/"
"${PSQL[@]}" -q -c "UPDATE public.tickets SET checked_in = false, checked_in_at = NULL, scanner_id = NULL WHERE id IN ('$P1', '$P3'); DELETE FROM public.checkins WHERE ticket_id IN ('$P1', '$P3');"

echo "== Applying 0220 =="
H_BEFORE=$(val "SELECT md5(string_agg(proname || ':' || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('purchase_ticket', 'generate_ticket_token', 'verify_entry_pass', 'manual_check_in');")
expect_ok "0220 applies" "$(cat "$MIG/0220_ticket_payment_integrity.sql")"
expect_ok "0220 is idempotent (second run)" "$(cat "$MIG/0220_ticket_payment_integrity.sql")"
expect_value "all four functions carry the [0220] marker" \
  "$(val "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('purchase_ticket', 'generate_ticket_token', 'verify_entry_pass', 'manual_check_in') AND prosrc LIKE '%[0220]%';")" "4"
expect_value "grants are unchanged (purchase/check-in still callable as before; no new grant to anon on QR signing)" \
  "$(val "SELECT has_function_privilege('authenticated', 'public.purchase_ticket(uuid,text,jsonb,text,text)', 'EXECUTE')::text || '/' || has_function_privilege('authenticated', 'public.manual_check_in(uuid,uuid,text,text)', 'EXECUTE')::text;")" "true/true"

echo "== 1. A paid tier cannot be bought through a direct, unpaid call =="
N0=$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EVI';")
expect_value "purchase_ticket refuses a paid tier" "$(direct_buy "$B4" "$EVI" VIP AFTER-1 | grep -o 'bought through checkout')" "bought through checkout"
expect_value "purchase_ticket refuses a partly discounted paid tier (50% promo)" "$(direct_buy "$B4" "$EVI" VIP AFTER-2 "'HALF'" | grep -o 'bought through checkout')" "bought through checkout"
expect_error "purchase_ticket_with_tokens refuses a paid tier too" "bought through checkout" \
  "$(as "$B4" "SELECT public.purchase_ticket_with_tokens('$EVI', 'Regular', '[{\"name\": \"X\"}]'::jsonb, 'AFTER-3', NULL);")"
expect_value "... and no ticket row was created" "$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EVI';")" "$N0"

echo "== 2-4. An unpaid ticket gets no pass and never checks in =="
expect_value "a pending ticket gets no entry pass (NULL)" "$(val "$(as "$B3" "SELECT COALESCE(public.generate_ticket_token('$P2'), 'none');")")" "none"
expect_value "a pass minted for it BEFORE the fix is refused at the QR scan" "$(scan "$P2_TOK")" "false/not_paid"
expect_value "... logged as an invalid scan with reason not_paid" \
  "$(val "SELECT result || '/' || reason FROM public.scan_log WHERE ticket_id = '$P2' ORDER BY created_at DESC LIMIT 1;")" "invalid/not_paid"
expect_value "the earlier repro pass (P1) is now refused too" "$(scan "$P1_TOK")" "false/not_paid"
expect_value "manual check-in refuses an unpaid ticket" "$(manual "$P3")" "false/not_paid"
expect_value "... and none of them is marked checked in" "$(val "SELECT count(*) FILTER (WHERE checked_in) FROM public.tickets WHERE id IN ('$P1', '$P2', '$P3');")" "0"
"${PSQL[@]}" -q -c "UPDATE public.tickets SET payment_status = 'failed' WHERE id = '$P3';"
expect_value "a failed-payment ticket is refused at manual check-in" "$(manual "$P3")" "false/not_paid"

echo "== 5. Free tickets still work (free tier, and a 100% promo) =="
FREE=$(val "$(as "$B2" "SELECT string_agg(x->>'ticket_id', ' ') FROM jsonb_array_elements(public.purchase_ticket_with_tokens('$EVI', 'Free', '[{\"name\": \"F1\"}, {\"name\": \"F2\"}]'::jsonb, 'FREE-1', NULL)) x;")")
read -r F1 F2 <<<"$FREE"
expect_value "a free RSVP is issued, paid at N0, with a pass" "$(val "SELECT count(*) FROM public.tickets WHERE id IN ('$F1', '$F2') AND status = 'active' AND payment_status = 'paid' AND amount = 0;")" "2"
FTOK=$(val "$(as "$B2" "SELECT x->>'token' FROM jsonb_array_elements(public.purchase_ticket_with_tokens('$EVI', 'Free', '[{\"name\": \"F1\"}, {\"name\": \"F2\"}]'::jsonb, 'FREE-1', NULL)) x LIMIT 1;")")
expect_value "the same free request again returns the same tickets (idempotent), with a pass" \
  "$([ -n "$FTOK" ] && echo yes)/$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = 'FREE-1';")" "yes/2"
expect_value "the free ticket checks in by QR" "$(scan "$(tok "$B2" "$F1")")" "true/"
PROMO=$(direct_buy "$B1" "$EVI" VIP PROMO-1 "'ALLFREE'")
expect_value "a 100% promo on a paid tier is still issued (free), paid at N0" "$(val "SELECT payment_status || '/' || discount_percentage FROM public.tickets WHERE id = '$PROMO';")" "paid/100"
expect_value "... and checks in" "$(manual "$PROMO")" "true/"

echo "== 6. Paystack-confirmed tickets =="
REF_P=$(buy "$B4" "$EVI" 1); TP=$(tickets_of "$REF_P")
expect_value "a Paystack purchase is paid (checkout -> finalize -> confirm)" "$(pstatus "$TP")" "paid"
TP_TOK=$(tok "$B4" "$TP")
expect_value "... gets a pass and checks in by QR" "$(scan "$TP_TOK")" "true/"

echo "== 7. VENTS Wallet tickets =="
REF_W2=$(buy_wallet "$B2" "$EVI"); TW=$(tickets_of "$REF_W2")
expect_value "a wallet purchase is paid" "$(pstatus "$TW")/$(val "SELECT payment_method FROM public.tickets WHERE id = '$TW';")" "paid/wallet"
expect_value "... and passes manual check-in" "$(manual "$TW")" "true/"
expect_value "the wallet checkout's in-transaction signing of a still-pending ticket did not abort it (no warning path)" \
  "$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$REF_W2' AND payment_status = 'paid';")" "1"

echo "== 8-9. Transfers =="
REF_T=$(buy "$B1" "$EVI" 1); TT=$(tickets_of "$REF_T")
OLD_TOK=$(tok "$B1" "$TT")
# accept_ticket_transfer's ownership swap (0043): user_id and holder change; payment fields stay.
"${PSQL[@]}" -q -c "UPDATE public.tickets SET user_id = '$B3', holder_name = 'Buyer Three' WHERE id = '$TT' AND user_id = '$B1' AND checked_in = false;"
expect_value "the transfer keeps the payment (still paid)" "$(pstatus "$TT")" "paid"
expect_error "the previous holder can no longer get a pass" "Not authorized to sign this ticket" "$(as "$B1" "SELECT public.generate_ticket_token('$TT');")"
expect_value "the previous holder's old pass is refused" "$(scan "$OLD_TOK")" "false/payload_mismatch"
expect_value "the new holder gets a pass that checks in" "$(scan "$(tok "$B3" "$TT")")" "true/"
"${PSQL[@]}" -q -c "UPDATE public.tickets SET user_id = '$B1' WHERE id = '$P2';"   # an UNPAID ticket handed to someone else
expect_value "a transfer never makes an unpaid ticket valid: the new holder gets no pass" "$(val "$(as "$B1" "SELECT COALESCE(public.generate_ticket_token('$P2'), 'none');")")" "none"

echo "== 10-11. Cancelled and refunded tickets =="
REF_C=$(buy "$B4" "$EVI" 1); TC=$(tickets_of "$REF_C"); TC_TOK=$(tok "$B4" "$TC")
"${PSQL[@]}" -q -c "UPDATE public.tickets SET status = 'cancelled' WHERE id = '$TC';"
expect_value "a cancelled ticket gets no pass" "$(val "$(as "$B4" "SELECT COALESCE(public.generate_ticket_token('$TC'), 'none');")")" "none"
expect_value "a cancelled ticket's earlier pass is refused" "$(scan "$TC_TOK")" "false/not_active"
REF_R=$(buy_wallet "$B2" "$EVI"); TR=$(tickets_of "$REF_R"); TR_TOK=$(tok "$B2" "$TR")
"${PSQL[@]}" -q -c "$(as "$ORG" "SELECT public.refund_ticket('$TR', 'Organizer refund');")" >/dev/null
expect_value "a refunded ticket (wallet refund) is refunded and cancelled" "$(val "SELECT status || '/' || payment_status FROM public.tickets WHERE id = '$TR';")" "cancelled/refunded"
expect_value "a refunded ticket gets no pass" "$(val "$(as "$B2" "SELECT COALESCE(public.generate_ticket_token('$TR'), 'none');")")" "none"
expect_value "a refunded ticket's earlier pass is refused" "$(scan "$TR_TOK")" "false/not_active"
expect_value "manual check-in refuses a refunded ticket" "$(manual "$TR")" "false/not_active"

echo "== 12. Duplicate check-ins stay blocked =="
expect_value "the same pass scanned again is a duplicate" "$(scan "$TP_TOK")" "false/already_scanned"
expect_value "manual check-in of an already scanned ticket is a duplicate" "$(manual "$TP")" "false/already_scanned"
expect_value "one check-in row per ticket" "$(val "SELECT count(*) FROM public.checkins WHERE ticket_id = '$TP';")" "1"

echo "== 13. Inventory and concurrency =="
expect_value "capacity still counts: 3 free seats, 2 taken" \
  "$(val "$(as "$B1" "SELECT array_length(public.purchase_ticket('$EVS', 'Free', '[{\"name\": \"a\"}, {\"name\": \"b\"}]'::jsonb, 'SEAT-1', NULL), 1);")")" "2"
for u in "$B2" "$B3" "$B4"; do
  ( "${PSQL[@]}" -q -c "$(as "$u" "SELECT public.purchase_ticket('$EVS', 'Free', '[{\"name\": \"c\"}]'::jsonb, 'SEAT-$u', NULL);")" >/dev/null 2>&1 ) &
done; wait
expect_value "three buyers racing for the last seat: exactly one gets it" "$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EVS' AND status = 'active';")" "3"
expect_error "the event is then sold out" "Only 0 ticket" "$(as "$OTHER" "SELECT public.purchase_ticket('$EVS', 'Free', '[{\"name\": \"d\"}]'::jsonb, 'SEAT-LATE', NULL);")"
expect_value "OPEN DECISION (documented, not changed): unpaid pending tickets created before the fix still count toward capacity" \
  "$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EVI' AND status = 'active' AND payment_status = 'pending';")" "2"

echo "== 14. Cancellation and refund protections intact =="
REF_K=$(buy "$B3" "$EV_OTHER" 1); TK=$(tickets_of "$REF_K"); TK_TOK=$(tok "$B3" "$TK")
expect_error "deleting an event with ticket holders is still refused (0218)" "request a cancellation instead" "$(as "$ORG2" "SELECT public.soft_delete_event('$EV_OTHER', 'gone');")"
RQ=$(val "$(as "$ORG2" "SELECT public.request_event_cancellation('$EV_OTHER', 'Venue closed for repairs')->>'id';")")
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_decide_event_cancellation('$RQ', true, NULL);")" >/dev/null
expect_value "the paid ticket of a cancelled event is queued for its refund" "$(val "SELECT status FROM public.event_cancellation_refunds WHERE ticket_id = '$TK';")" "queued"
expect_error "a paid ticket of a cancelled event cannot be checked in (0219), by QR" "cannot be checked in" \
  "$(as "$ORG2" "SELECT public.verify_entry_pass('$TK_TOK', '$ORG2');")"
expect_error "... nor manually" "cannot be checked in" "$(as "$ORG2" "SELECT public.manual_check_in('$TK', '$ORG2');")"
expect_value "... and it stays not checked in" "$(val "SELECT checked_in::text FROM public.tickets WHERE id = '$TK';")" "false"

echo "== Undo 0220 =="
H_AFTER=$(val "SELECT md5(string_agg(proname || ':' || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('purchase_ticket', 'generate_ticket_token', 'verify_entry_pass', 'manual_check_in');")
expect_error "undo_0220 refuses without the confirmation" "undo-0220" "$(cat "$REPO_ROOT/supabase/rollback/undo_0220.sql")"
expect_ok "undo_0220 runs" "SET vents.rollback_confirm = 'undo-0220'; $(cat "$REPO_ROOT/supabase/rollback/undo_0220.sql")"
expect_value "undo_0220 restores the exact pre-0220 function bodies" \
  "$(val "SELECT md5(string_agg(proname || ':' || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('purchase_ticket', 'generate_ticket_token', 'verify_entry_pass', 'manual_check_in');")" "$H_BEFORE"
expect_ok "0220 re-applies after the undo" "$(cat "$MIG/0220_ticket_payment_integrity.sql")"
expect_value "... to the same bodies as the first apply" \
  "$(val "SELECT md5(string_agg(proname || ':' || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('purchase_ticket', 'generate_ticket_token', 'verify_entry_pass', 'manual_check_in');")" "$H_AFTER"
"${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.generate_ticket_token(p_ticket_id uuid) RETURNS text LANGUAGE sql AS \$f\$ SELECT 'drifted'::text \$f\$;" >/dev/null
expect_error "on a drifted function body, 0220 refuses (nothing is half-applied)" "is not the expected version" \
  "$(cat "$MIG/0220_ticket_payment_integrity.sql" | sed 's/\[0220\]/[0220-drift-test]/g')"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES TICKET INTEGRITY (0220) CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
