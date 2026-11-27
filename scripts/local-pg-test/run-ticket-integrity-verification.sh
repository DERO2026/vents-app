#!/usr/bin/env bash
# Ticket payment integrity (OEL-01, migration 0220): no ticket for a paid tier
# can be used for entry without a confirmed payment. Runs on the same local
# money stack as run-event-cancellation-verification.sh (0201 -> 0217 plus the
# production ticket/refund functions), with 0218 + 0219 applied and the
# ticket purchase / QR / check-in / transfer functions loaded verbatim from the
# repository (schema-ticket-integrity.sql; every copy is re-checked against its
# migration on each run). It first REPRODUCES the hole (before 0220), then
# proves the fix and that free, Paystack, wallet, Someone Else Pays and
# transferred tickets, capacity, concurrent check-in, duplicates, refunds,
# refund reversal, cancellations and QR HMAC/expiry still behave.
#
# Every scenario calls the real database functions. The few places where a
# state is set directly (test data: users, events, a wallet top-up, one
# deliberately inconsistent ticket) are labelled as such in the check name.
# Not under test here: rate limits (check_rate_limit is a local no-op stub)
# and VENTS Cents accounting (award_vc_reward is a local no-op stub).
#
# Checks whose name starts with "[0220]" are the ones migration 0220 is
# responsible for. With WITHOUT_0220=1 the script runs every behavioural check
# WITHOUT applying 0220 (the migration-mechanics checks are skipped): exactly
# the [0220] checks must then fail and every other check must still pass.
# run-ticket-integrity-mutation-test.sh asserts both runs.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files. No network, no Paystack.
#
# Usage: scripts/local-pg-test/run-ticket-integrity-verification.sh
#        WITHOUT_0220=1 scripts/local-pg-test/run-ticket-integrity-verification.sh
set -euo pipefail
WITHOUT_0220="${WITHOUT_0220:-0}"
[[ "$WITHOUT_0220" =~ ^[01]$ ]] || { echo "WITHOUT_0220 must be 0 or 1" >&2; exit 2; }

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
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-ticket-integrity.sql" >/dev/null
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
# A server-side signature over a payload of our choosing (the local test
# secret): used only to build an EXPIRED pass and a wrong-secret pass.
forge() {  # forge <ticket> <expiresAt> [secret]
  val "SELECT seg || '.' || encode(extensions.hmac(seg, COALESCE(${3:-NULL}, (SELECT value FROM private.app_secrets WHERE key = 'ticket_hmac_v2')), 'sha256'), 'hex')
         FROM (SELECT rtrim(translate(replace(encode(convert_to(jsonb_build_object('ticketId', id::text, 'eventId', event_id::text,
                'purchaserId', user_id::text, 'issuedAt', '2020-01-01T00:00:00Z', 'expiresAt', '$2', 'nonce', 'aa', 'version', '2')::text,
                'UTF8'), 'base64'), chr(10), ''), '+/', '-_'), '=') AS seg FROM public.tickets WHERE id = '$1') s;"
}
FUNCS="'public.purchase_ticket(uuid,text,jsonb,text,text)'::regprocedure, 'public.purchase_ticket_with_tokens(uuid,text,jsonb,text,text)'::regprocedure,
       'public.generate_ticket_token(uuid)'::regprocedure, 'public.verify_entry_pass(text,uuid,text,text)'::regprocedure,
       'public.manual_check_in(uuid,uuid,text,text)'::regprocedure"
PATCHED="('purchase_ticket', 'generate_ticket_token', 'verify_entry_pass', 'manual_check_in')"
body_hash() { val "SELECT md5(string_agg(proname || ':' || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN $PATCHED;"; }
marked() { val "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN $PATCHED AND prosrc LIKE '%[0220]%';"; }
# Owner, SECURITY DEFINER, proconfig (search_path), volatility and the full
# ACL (grantee:privilege, PUBLIC spelled out) of the five functions, from pg_proc.
attrs() {
  val "SELECT string_agg(sig || ' owner=' || owner || ' secdef=' || secdef || ' config=' || cfg || ' acl=' || acl, ' ; ' ORDER BY sig) FROM (
         SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef::text AS secdef,
                COALESCE(array_to_string(p.proconfig, ','), '') || ' vol=' || p.provolatile::text AS cfg,
                COALESCE((SELECT string_agg(g, ',' ORDER BY g) FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                          || ':' || a.privilege_type AS g FROM aclexplode(p.proacl) a) x), 'DEFAULT') AS acl
           FROM pg_proc p WHERE p.oid IN ($FUNCS)) s;"
}
can_exec() { val "SELECT string_agg(r || '=' || has_function_privilege(r, '$1', 'EXECUTE')::text, ' ' ORDER BY r) FROM unnest(ARRAY['anon', 'authenticated', 'project_admin']) r;"; }
public_exec() { val "SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '$1'::regprocedure AND a.grantee = 0)::text;"; }
section_mechanics() { [ "$WITHOUT_0220" = 0 ]; }

echo "== Fidelity: every function the harness runs is the repository's latest definition =="
# The two transfer-fee payment functions are this harness's pre-0233 copies:
# 0233 (transfer-fee payment attempts) replaced them later and has its own
# suite (run-transfer-fee-attempts-verification.sh), so they are compared,
# byte for byte, with their latest definition before 0233.
if python3 -I "$SCRIPT_DIR/check-verbatim-functions.py" --before 0233 "$REPO_ROOT" "$SCRIPT_DIR/schema-ticket-integrity.sql" \
     initiate_transfer_fee_payment confirm_transfer_fee_payment >"$OUT" 2>&1; then
  pass "schema-ticket-integrity.sql: the two transfer-fee payment functions are byte-identical to their latest pre-0233 definition"
else
  fail "schema-ticket-integrity.sql: a transfer-fee payment function differs from its pre-0233 migration"; cat "$OUT" >&2
fi
for pair in "schema-ticket-integrity.sql:log_scan_attempt door_stats scan_reason_to_result is_event_door_manager generate_ticket_token purchase_ticket purchase_ticket_with_tokens verify_entry_pass manual_check_in protect_ticket_ownership_column compute_transfer_fee_kobo initiate_ticket_transfer accept_ticket_transfer" \
            "live-money-functions.sql:create_pending_purchase finalize_pending_purchase confirm_ticket_payment confirm_ticket_payment_via_wallet refund_ticket finalize_ticket_refund" \
            "schema-event-cancellation.sql:admin_revert_stuck_refund fail_ticket_refund attach_ticket_refund_id"; do
  file="${pair%%:*}"; names="${pair#*:}"
  # shellcheck disable=SC2086
  if python3 -I "$SCRIPT_DIR/check-verbatim-functions.py" "$REPO_ROOT" "$SCRIPT_DIR/$file" $names >"$OUT" 2>&1; then
    pass "$file: $(wc -l <"$OUT" | tr -d ' ') functions are byte-identical to their latest migration"
  else
    fail "$file: a function differs from its migration"; cat "$OUT" >&2
  fi
done

echo "== Function security attributes and grants (before 0220) =="
ATTRS_BEFORE=$(attrs)
expect_value "all five are owned by postgres, SECURITY DEFINER, search_path ''" \
  "$(val "SELECT count(*) FROM pg_proc p WHERE p.oid IN ($FUNCS) AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef AND p.proconfig = ARRAY['search_path=\"\"'];")" "5"
for f in 'public.purchase_ticket(uuid,text,jsonb,text,text)' 'public.purchase_ticket_with_tokens(uuid,text,jsonb,text,text)'; do
  expect_value "$f: executable by anon, authenticated, project_admin (0011), not PUBLIC" "$(can_exec "$f")/$(public_exec "$f")" "anon=true authenticated=true project_admin=true/false"
done
for f in 'public.generate_ticket_token(uuid)' 'public.verify_entry_pass(text,uuid,text,text)' 'public.manual_check_in(uuid,uuid,text,text)'; do
  expect_value "$f: executable by authenticated and project_admin only (0104/0133), not anon, not PUBLIC" "$(can_exec "$f")/$(public_exec "$f")" "anon=false authenticated=true project_admin=true/false"
done

echo "== Reproduction: before 0220 (the vulnerability) =="
P1=$(direct_buy "$B4" "$EVI" VIP REPRO-1)
expect_value "a direct purchase_ticket call on a paid tier creates a ticket without any payment" "$(state "$P1")" "active/pending"
P1_TOK=$(tok "$B4" "$P1")
expect_value "... its holder gets a signed entry pass" "$([ -n "$P1_TOK" ] && echo signed)" "signed"
expect_value "... and the pass checks in at the door (QR scan)" "$(scan "$P1_TOK")" "true/"
P2=$(direct_buy "$B3" "$EVI" Regular REPRO-2)
P2_TOK=$(tok "$B3" "$P2")             # minted before the fix; used after it
P3=$(direct_buy "$B1" "$EVI" Regular REPRO-3)
expect_value "... and an unpaid ticket also passes manual check-in" "$(manual "$P3")" "true/"
# Test setup: undo the reproduction check-ins so the same tickets can be retried after 0220.
"${PSQL[@]}" -q -c "UPDATE public.tickets SET checked_in = false, checked_in_at = NULL, scanner_id = NULL WHERE id IN ('$P1', '$P3'); DELETE FROM public.checkins WHERE ticket_id IN ('$P1', '$P3');"

if section_mechanics; then
  echo "== Applying 0220 =="
  H_BEFORE=$(body_hash)
  expect_ok "0220 applies" "$(cat "$MIG/0220_ticket_payment_integrity.sql")"
  H_AFTER=$(body_hash)
  expect_ok "0220 is idempotent (second run)" "$(cat "$MIG/0220_ticket_payment_integrity.sql")"
  expect_value "... the second run changes no function body" "$(body_hash)" "$H_AFTER"
  expect_value "all four functions carry the [0220] marker" "$(marked)" "4"
  expect_value "0220 changes no owner, SECURITY DEFINER, search_path, volatility or grant (pg_proc before = after)" "$(attrs)" "$ATTRS_BEFORE"
  expect_value "purchase_ticket_with_tokens is not modified by 0220" \
    "$(val "SELECT (prosrc LIKE '%[0220]%')::text FROM pg_proc WHERE oid = 'public.purchase_ticket_with_tokens(uuid,text,jsonb,text,text)'::regprocedure;")" "false"
else
  echo "== WITHOUT_0220=1: 0220 is NOT applied; migration-mechanics checks skipped =="
fi
expect_error "anon cannot call generate_ticket_token (permission denied, not just an empty result)" "permission denied for function generate_ticket_token" \
  "SET ROLE anon; SELECT public.generate_ticket_token('$P2');"
expect_error "... nor verify_entry_pass" "permission denied for function verify_entry_pass" "SET ROLE anon; SELECT public.verify_entry_pass('x', '$ORG');"
expect_error "an authenticated user cannot sign someone else's ticket" "Not authorized to sign this ticket" "$(as "$OTHER" "SELECT public.generate_ticket_token('$P2');")"

echo "== 1. A paid tier cannot be bought through a direct, unpaid call =="
N0=$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EVI';")
expect_value "[0220] purchase_ticket refuses a paid tier" "$(direct_buy "$B4" "$EVI" VIP AFTER-1 | grep -o 'bought through checkout' || true)" "bought through checkout"
expect_value "[0220] purchase_ticket refuses a partly discounted paid tier (50% promo)" "$(direct_buy "$B4" "$EVI" VIP AFTER-2 "'HALF'" | grep -o 'bought through checkout' || true)" "bought through checkout"
expect_error "[0220] purchase_ticket_with_tokens refuses a paid tier too" "bought through checkout" \
  "$(as "$B4" "SELECT public.purchase_ticket_with_tokens('$EVI', 'Regular', '[{\"name\": \"X\"}]'::jsonb, 'AFTER-3', NULL);")"
expect_value "[0220] ... and no ticket row was created" "$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EVI';")" "$N0"

echo "== 2-4. An unpaid ticket gets no pass and never checks in =="
expect_value "[0220] a pending ticket gets no entry pass (NULL)" "$(tok_or_none "$B3" "$P2")" "none"
expect_value "[0220] a pass minted for it BEFORE the fix is refused at the QR scan" "$(scan "$P2_TOK")" "false/not_paid"
expect_value "[0220] ... logged as an invalid scan with reason not_paid" \
  "$(val "SELECT result || '/' || reason FROM public.scan_log WHERE ticket_id = '$P2' ORDER BY created_at DESC LIMIT 1;")" "invalid/not_paid"
expect_value "[0220] the earlier repro pass (P1) is now refused too" "$(scan "$P1_TOK")" "false/not_paid"
expect_value "[0220] manual check-in refuses an unpaid ticket" "$(manual "$P3")" "false/not_paid"
expect_value "[0220] ... and none of them is marked checked in" "$(val "SELECT count(*) FILTER (WHERE checked_in) FROM public.tickets WHERE id IN ('$P1', '$P2', '$P3');")" "0"
"${PSQL[@]}" -q -c "UPDATE public.tickets SET payment_status = 'failed' WHERE id = '$P3';"   # state set directly: a failed payment
expect_value "[0220] a failed-payment ticket (state set directly) is refused at manual check-in" "$(manual "$P3")" "false/not_paid"

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

echo "== 6. Paystack-confirmed tickets (create_pending_purchase -> finalize -> confirm, real functions) =="
REF_P=$(buy "$B4" "$EVI" 1); TP=$(tickets_of "$REF_P")
expect_value "a Paystack purchase is paid" "$(state "$TP")" "active/paid"
TP_TOK=$(tok "$B4" "$TP")
expect_value "... gets a pass and checks in by QR" "$(scan "$TP_TOK")" "true/"

echo "== 6b. Someone Else Pays (payer settles through Paystack, real functions) =="
REF_SEP=$(buy "$B1" "$EVI" 1 "b4@example.test"); TSEP=$(tickets_of "$REF_SEP")
expect_value "the ticket belongs to the requester, the payer is recorded, and it is paid" \
  "$(val "SELECT (user_id = '$B1')::text || '/' || (payer_id = '$B4')::text || '/' || payment_status FROM public.tickets WHERE id = '$TSEP';")" "true/true/paid"
expect_error "the payer cannot sign the requester's ticket" "Not authorized to sign this ticket" "$(as "$B4" "SELECT public.generate_ticket_token('$TSEP');")"
expect_value "the requester gets a pass that checks in" "$(scan "$(tok "$B1" "$TSEP")")" "true/"

echo "== 7. VENTS Wallet: the wallet function's FIRST call creates, debits and confirms =="
BAL0=$(wallet "$B2"); REF_W=$(wallet_start "$B2" "$EVI" 2)
expect_value "before paying, the checkout created no ticket" "$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$REF_W';")" "0"
expect_value "one call to confirm_ticket_payment_via_wallet (no pre-finalize) confirms" "$(wallet_pay "$B2" "$REF_W")" "confirmed"
read -r TW TW2 <<<"$(tickets_of "$REF_W")"
expect_value "... it created both tickets, paid by wallet" \
  "$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$REF_W' AND status = 'active' AND payment_status = 'paid' AND payment_method = 'wallet';")" "2"
SPEND=$(val "SELECT amount_kobo FROM public.user_wallet_transactions WHERE reference_id = '$REF_W' AND type = 'spend';")
expect_value "... debited the wallet once, by exactly the recorded spend" "$((BAL0 - $(wallet "$B2")))/$(val "SELECT count(*) FROM public.user_wallet_transactions WHERE reference_id = '$REF_W' AND type = 'spend';")" "$SPEND/1"
expect_value "... the spend is the ticket total plus the attendee fee the checkout quoted" "$SPEND" "$(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$REF_W';")"
TW_TOK=$(tok "$B2" "$TW")
expect_value "after payment the holder gets a pass, and it checks in by QR" "$([ -n "$TW_TOK" ] && echo signed)/$(scan "$TW_TOK")" "signed/true/"
expect_value "the second wallet ticket passes manual check-in" "$(manual "$TW2")" "true/"
BAL1=$(wallet "$B2")
expect_value "a retry of the same wallet payment is a no-op: already_paid" "$(wallet_pay "$B2" "$REF_W")" "already_paid"
expect_value "... no second debit, no duplicate ticket, no second spend row" \
  "$(wallet "$B2")/$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$REF_W';")/$(val "SELECT count(*) FROM public.user_wallet_transactions WHERE reference_id = '$REF_W';")" "$BAL1/2/1"

echo "== 7b. Wallet: a purchase that fails rolls back completely =="
REF_1=$(wallet_start "$B2" "$EV1" 1)
REF_SEAT=$(buy "$B4" "$EV1" 1)       # someone else takes the only seat through Paystack first
BAL2=$(wallet "$B2")
expect_value "the wallet payment for the now sold-out event is refused" "$(wallet_pay "$B2" "$REF_1" | grep -o 'remaining' || true)" "remaining"
expect_value "... nothing remains: no ticket, no debit, no spend row, the checkout still open" \
  "$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$REF_1';")/$(wallet "$B2")/$(val "SELECT count(*) FROM public.user_wallet_transactions WHERE reference_id = '$REF_1';")/$(val "SELECT status FROM public.pending_purchases WHERE payment_ref = '$REF_1';")" \
  "0/$BAL2/0/pending"

echo "== 7c. Wallet: insufficient balance (actual behaviour, unchanged by 0220) =="
REF_LOW=$(wallet_start "$B3" "$EVI" 1)
expect_value "a wallet payment with too little balance is refused, not charged" "$(wallet_pay "$B3" "$REF_LOW" | cut -d: -f1)/$(wallet "$B3")" "insufficient_balance/0"
TLOW=$(tickets_of "$REF_LOW")
expect_value "EXISTING BEHAVIOUR (not changed here): its ticket was created and left unpaid" "$(state "$TLOW")" "active/pending"
expect_value "[0220] that unpaid ticket gets no pass" "$(tok_or_none "$B3" "$TLOW")" "none"
expect_value "[0220] ... and is refused at the door" "$(manual "$TLOW")" "false/not_paid"
"${PSQL[@]}" -q -c "INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$B3', 5000000) ON CONFLICT (user_id) DO UPDATE SET balance_kobo = 5000000;"  # test data: top-up
expect_value "after a top-up the same payment confirms" "$(wallet_pay "$B3" "$REF_LOW")" "confirmed"
expect_value "... paying the SAME ticket (no duplicate) with one debit" \
  "$(tickets_of "$REF_LOW")/$(state "$TLOW")/$((5000000 - $(wallet "$B3")))" "$TLOW/active/paid/$(val "SELECT amount_kobo FROM public.user_wallet_transactions WHERE reference_id = '$REF_LOW' AND type = 'spend';")"
expect_value "[0220] ... and its holder now gets a pass that checks in for the first time (it was never admitted while unpaid)" "$(scan "$(tok "$B3" "$TLOW")")" "true/"

echo "== 7d. Wallet: two simultaneous first calls for one checkout =="
REF_WC=$(wallet_start "$B2" "$EVI" 1); BAL3=$(wallet "$B2")
( "${PSQL[@]}" -tA -c "$(as "$B2" "SELECT 'R=' || public.confirm_ticket_payment_via_wallet('$REF_WC');")" >"$TMP/wa" 2>&1 ) &
( "${PSQL[@]}" -tA -c "$(as "$B2" "SELECT 'R=' || public.confirm_ticket_payment_via_wallet('$REF_WC');")" >"$TMP/wb" 2>&1 ) &
wait
expect_value "exactly one confirms and the other sees it already paid" \
  "$(printf '%s\n%s\n' "$(grep -m1 '^R=' "$TMP/wa" | cut -c3-)" "$(grep -m1 '^R=' "$TMP/wb" | cut -c3-)" | sort | paste -sd/)" "already_paid/confirmed"
expect_value "... one ticket, one spend row, one debit" \
  "$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$REF_WC';")/$(val "SELECT count(*) FROM public.user_wallet_transactions WHERE reference_id = '$REF_WC';")/$((BAL3 - $(wallet "$B2")))" \
  "1/1/$(val "SELECT amount_kobo FROM public.user_wallet_transactions WHERE reference_id = '$REF_WC' AND type = 'spend';")"

echo "== 8. Transfers through the real functions (initiate -> fee payment -> confirm) =="
REF_T=$(buy "$B1" "$EVI" 1); TT=$(tickets_of "$REF_T")
OLD_TOK=$(tok "$B1" "$TT")
XFER=$(val "$(as "$B1" "SELECT public.initiate_ticket_transfer('$TT', 'b3@example.test');")")
expect_value "the holder starts a transfer of a paid ticket" "$(val "SELECT status || '/' || (to_user_id = '$B3')::text || '/' || (fee_kobo > 0)::text FROM public.ticket_transfers WHERE id = '$XFER';")" "pending/true/true"
expect_error "accept_ticket_transfer refuses until the transfer fee is paid (the real gate)" "A transfer fee must be paid" "$(as "$B3" "SELECT public.accept_ticket_transfer('$XFER');")"
expect_value "... and ownership has not moved" "$(val "SELECT (user_id = '$B1')::text FROM public.tickets WHERE id = '$TT';")" "true"
FEE=$(val "$(as "$B3" "SELECT public.initiate_transfer_fee_payment('$XFER')::text;")")
FEE_REF=$(echo "$FEE" | jq -r '.reference'); FEE_KOBO=$(echo "$FEE" | jq -r '.feeKobo')
expect_value "the webhook (project_admin) confirms the fee and the transfer completes" \
  "$(val "SET ROLE project_admin; SELECT public.confirm_transfer_fee_payment('$FEE_REF', $FEE_KOBO);")" "confirmed"
expect_value "... the new holder owns it, the payment is kept, the transfer is accepted" \
  "$(val "SELECT (t.user_id = '$B3')::text || '/' || t.holder_name || '/' || t.payment_status || '/' || x.status FROM public.tickets t JOIN public.ticket_transfers x ON x.ticket_id = t.id WHERE x.id = '$XFER';")" \
  "true/Buyer Three/paid/accepted"
expect_error "the previous holder can no longer get a pass" "Not authorized to sign this ticket" "$(as "$B1" "SELECT public.generate_ticket_token('$TT');")"
expect_value "the previous holder's old pass is refused" "$(scan "$OLD_TOK")" "false/payload_mismatch"
expect_value "the new holder gets a pass that checks in" "$(scan "$(tok "$B3" "$TT")")" "true/"
expect_error "accepting again is refused (already accepted)" "no longer pending" "$(as "$B3" "SELECT public.accept_ticket_transfer('$XFER');")"
expect_error "an unpaid (pending) ticket cannot be transferred" "Only paid tickets can be transferred" "$(as "$B3" "SELECT public.initiate_ticket_transfer('$P2', 'b1@example.test');")"
expect_error "nor can a checked-in one" "already checked in cannot be transferred" "$(as "$B3" "SELECT public.initiate_ticket_transfer('$TT', 'b1@example.test');")"

echo "== 9. A ticket refunded while its transfer is pending never changes hands =="
REF_X2=$(buy "$B4" "$EVI" 1); TX2=$(tickets_of "$REF_X2")
XFER2=$(val "$(as "$B4" "SELECT public.initiate_ticket_transfer('$TX2', 'b1@example.test');")")
expect_value "the organizer refunds it while the transfer is pending (Paystack refund in flight)" \
  "$(api_refund "$ORG" "$TX2" "Duplicate order" ok)/$(state "$TX2")" "refund_pending/cancelled/refund_pending"
FEE2=$(val "$(as "$B1" "SELECT public.initiate_transfer_fee_payment('$XFER2')::text;")")
expect_value "the recipient's fee payment is not applied: the ticket is ineligible and the fee is flagged for refund" \
  "$(val "SET ROLE project_admin; SELECT public.confirm_transfer_fee_payment('$(echo "$FEE2" | jq -r '.reference')', $(echo "$FEE2" | jq -r '.feeKobo'));")" "ticket_ineligible:refund_claimed"
expect_value "... ownership is unchanged and the transfer is cancelled" \
  "$(val "SELECT (t.user_id = '$B4')::text || '/' || x.status FROM public.tickets t JOIN public.ticket_transfers x ON x.ticket_id = t.id WHERE x.id = '$XFER2';")" "true/cancelled"
expect_error "a ticket with a refund in flight cannot start a new transfer" "Only paid tickets can be transferred" "$(as "$B4" "SELECT public.initiate_ticket_transfer('$TX2', 'b1@example.test');")"

echo "== 10-11. Cancelled and refunded tickets =="
REF_C=$(buy "$B4" "$EVI" 1); TC=$(tickets_of "$REF_C"); TC_TOK=$(tok "$B4" "$TC")
"${PSQL[@]}" -q -c "UPDATE public.tickets SET status = 'cancelled' WHERE id = '$TC';"   # state set directly: inconsistent cancelled-but-paid
expect_value "[0220] an inconsistent cancelled-but-paid ticket (state set directly) gets no pass" "$(tok_or_none "$B4" "$TC")" "none"
expect_value "... its earlier pass is refused" "$(scan "$TC_TOK")" "false/not_active"
expect_error "... and it cannot be transferred" "This ticket is not active" "$(as "$B4" "SELECT public.initiate_ticket_transfer('$TC', 'b1@example.test');")"
REF_R=$(buy_wallet "$B2" "$EVI"); TR=$(tickets_of "$REF_R"); TR_TOK=$(tok "$B2" "$TR")
"${PSQL[@]}" -q -c "$(as "$ORG" "SELECT public.refund_ticket('$TR', 'Organizer refund');")" >/dev/null
expect_value "a wallet refund (refund_ticket) leaves the ticket cancelled and refunded" "$(state "$TR")" "cancelled/refunded"
expect_value "[0220] a refunded ticket gets no pass" "$(tok_or_none "$B2" "$TR")" "none"
expect_value "a refunded ticket's earlier pass is refused" "$(scan "$TR_TOK")" "false/not_active"
expect_value "manual check-in refuses a refunded ticket" "$(manual "$TR")" "false/not_active"
expect_error "a refunded ticket cannot be transferred" "Only paid tickets can be transferred" "$(as "$B2" "SELECT public.initiate_ticket_transfer('$TR', 'b1@example.test');")"

echo "== 11b. Refund reversal restores a legitimate paid ticket (real functions) =="
REF_RV=$(buy "$B4" "$EVI" 1); TRV=$(tickets_of "$REF_RV"); TRV_TOK=$(tok "$B4" "$TRV")
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.refund_ticket('$TRV', 'Customer request');")" >/dev/null
expect_value "a Paystack refund starts: the ticket is cancelled, refund pending" "$(state "$TRV")" "cancelled/refund_pending"
expect_value "[0220] while the refund is in flight the holder gets no pass" "$(tok_or_none "$B4" "$TRV")" "none"
expect_value "... the earlier pass is refused" "$(scan "$TRV_TOK")" "false/not_active"
expect_value "... and manual check-in is refused" "$(manual "$TRV")" "false/not_active"
expect_value "Paystack rejects the refund: admin_revert_stuck_refund releases it" \
  "$(val "$(as "$ADMIN_A" "SELECT public.admin_revert_stuck_refund('$TRV', 'Paystack refund creation failed: insufficient balance');")")" "reverted"
expect_value "... status and payment are restored" "$(state "$TRV")/$(val "SELECT COALESCE(refund_id, 'none') FROM public.tickets WHERE id = '$TRV';")" "active/paid/none"
TRV_TOK2=$(tok "$B4" "$TRV")
expect_value "... the holder can get a pass again, and it checks in" "$([ -n "$TRV_TOK2" ] && echo signed)/$(scan "$TRV_TOK2")" "signed/true/"
REF_WF=$(buy "$B1" "$EVI" 1); TWF=$(tickets_of "$REF_WF")
expect_value "a second Paystack refund is accepted by Paystack (refund id recorded)" "$(api_refund "$ORG" "$TWF" "Customer request" ok)/$(state "$TWF")" "refund_pending/cancelled/refund_pending"
expect_value "... blocked at the door meanwhile" "$(manual "$TWF")" "false/not_active"
expect_value "the bank rejects it: the refund.failed webhook (fail_ticket_refund) reverts it" "$(webhook_failed "$TWF")" "reverted"
expect_value "... restored to active and paid, it checks in" "$(state "$TWF")/$(manual "$TWF")" "active/paid/true/"
REF_FD=$(buy "$B3" "$EVI" 1); TFD=$(tickets_of "$REF_FD")
expect_value "a refund that completes (refund.processed webhook)" "$(api_refund "$ORG" "$TFD" "Customer request" ok)/$(webhook_processed "$TFD")/$(state "$TFD")" "refund_pending/finalized/cancelled/refunded"
expect_error "... cannot be reverted" "Only tickets awaiting refund can be reverted" "$(as "$ADMIN_A" "SELECT public.admin_revert_stuck_refund('$TFD', 'try');")"
expect_value "[0220] ... and stays without a pass" "$(tok_or_none "$B3" "$TFD")" "none"
expect_value "... and refused at the door" "$(manual "$TFD")" "false/not_active"

echo "== 12. QR HMAC and expiry =="
REF_H=$(buy "$B4" "$EVI" 1); TH=$(tickets_of "$REF_H"); TH_TOK=$(tok "$B4" "$TH")
expect_value "a pass with an altered signature is refused" "$(scan "${TH_TOK%?}$( [ "${TH_TOK: -1}" = 0 ] && echo 1 || echo 0)")" "false/invalid_signature"
expect_value "a pass signed with the wrong secret is refused" "$(scan "$(forge "$TH" '2099-01-01T00:00:00Z' "'not-the-secret'")")" "false/invalid_signature"
expect_value "a correctly signed but expired pass is refused" "$(scan "$(forge "$TH" '2020-01-03T00:00:00Z')")" "false/expired"
expect_value "... none of those checked it in; the real pass still does" "$(val "SELECT checked_in::text FROM public.tickets WHERE id = '$TH';")/$(scan "$TH_TOK")" "false/true/"

echo "== 13. Duplicate check-ins stay blocked =="
expect_value "the same pass scanned again is a duplicate" "$(scan "$TP_TOK")" "false/already_scanned"
expect_value "manual check-in of an already scanned ticket is a duplicate" "$(manual "$TP")" "false/already_scanned"
expect_value "one check-in row per ticket" "$(val "SELECT count(*) FROM public.checkins WHERE ticket_id = '$TP';")" "1"

echo "== 14. Concurrent check-in (separate PostgreSQL sessions) =="
REF_CC=$(buy "$B2" "$EVI" 1); TCC=$(tickets_of "$REF_CC"); TCC_TOK=$(tok "$B2" "$TCC")
# Session A scans and HOLDS its transaction open for 2 s; session B (a manual
# check-in at another gate) starts 0.5 s later and must wait for A's row lock.
( "${PSQL[@]}" -tA -c "$(as "$ORG" "BEGIN; SELECT 'R=' || (r->>'ok') || '/' || COALESCE(r->>'reason', '') FROM (SELECT public.verify_entry_pass('$TCC_TOK', '$ORG') AS r) q; SELECT pg_sleep(2); COMMIT;")" >"$TMP/ca" 2>&1 ) &
sleep 0.5
T0=$(date +%s%N)
"${PSQL[@]}" -tA -c "$(as "$ADMIN_A" "SELECT 'R=' || (r->>'ok') || '/' || COALESCE(r->>'reason', '') FROM (SELECT public.manual_check_in('$TCC', '$ADMIN_A') AS r) q;")" >"$TMP/cb" 2>&1
T1=$(date +%s%N); wait
expect_value "the first session checks in; the overlapping one is refused as a duplicate" \
  "$(grep -m1 '^R=' "$TMP/ca" | cut -c3-)|$(grep -m1 '^R=' "$TMP/cb" | cut -c3-)" "true/|false/already_scanned"
expect_value "... the second session really waited on the row lock (>= 1 s)" "$([ $(( (T1 - T0) / 1000000 )) -ge 1000 ] && echo waited || echo "did-not-wait:$(( (T1 - T0) / 1000000 ))ms")" "waited"
expect_value "... one checked-in state, one check-in row, one valid and one duplicate scan record" \
  "$(val "SELECT checked_in::text FROM public.tickets WHERE id = '$TCC';")/$(val "SELECT count(*) FROM public.checkins WHERE ticket_id = '$TCC';")/$(val "SELECT count(*) FILTER (WHERE result = 'valid') || ',' || count(*) FILTER (WHERE result = 'duplicate') FROM public.scan_log WHERE ticket_id = '$TCC';")" \
  "true/1/1,1"
# Five tickets, each scanned by two sessions started at the same instant.
RACE_T=""
for i in 1 2 3 4 5; do
  r=$(buy "$B1" "$EVI" 1); t=$(tickets_of "$r"); k=$(tok "$B1" "$t"); RACE_T="$RACE_T '$t'"
  ( "${PSQL[@]}" -tA -c "$(as "$ORG" "SELECT 'R=' || (public.verify_entry_pass('$k', '$ORG')->>'ok');")" >"$TMP/r${i}a" 2>&1 ) &
  ( "${PSQL[@]}" -tA -c "$(as "$ADMIN_A" "SELECT 'R=' || (public.verify_entry_pass('$k', '$ADMIN_A')->>'ok');")" >"$TMP/r${i}b" 2>&1 ) &
  wait
done
RACE_IN=$(echo "$RACE_T" | sed "s/^ //; s/' '/', '/g")
expect_value "five simultaneous double scans: exactly one success per ticket" "$(cat "$TMP"/r?a "$TMP"/r?b | grep -c '^R=true')/$(cat "$TMP"/r?a "$TMP"/r?b | grep -c '^R=false')" "5/5"
expect_value "... every ticket checked in once, one check-in row and one valid scan each" \
  "$(val "SELECT count(*) FILTER (WHERE checked_in) FROM public.tickets WHERE id IN ($RACE_IN);")/$(val "SELECT count(*) FROM public.checkins WHERE ticket_id IN ($RACE_IN);")/$(val "SELECT count(*) FROM public.scan_log WHERE result = 'valid' AND ticket_id IN ($RACE_IN);")" \
  "5/5/5"

echo "== 15. Inventory and capacity concurrency =="
expect_value "capacity still counts: 3 free seats, 2 taken" \
  "$(val "$(as "$B1" "SELECT array_length(public.purchase_ticket('$EVS', 'Free', '[{\"name\": \"a\"}, {\"name\": \"b\"}]'::jsonb, 'SEAT-1', NULL), 1);")")" "2"
for u in "$B2" "$B3" "$B4"; do
  ( "${PSQL[@]}" -q -c "$(as "$u" "SELECT public.purchase_ticket('$EVS', 'Free', '[{\"name\": \"c\"}]'::jsonb, 'SEAT-$u', NULL);")" >/dev/null 2>&1 ) &
done; wait
expect_value "three buyers racing for the last seat: exactly one gets it" "$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EVS' AND status = 'active';")" "3"
expect_error "the event is then sold out" "Only 0 ticket" "$(as "$OTHER" "SELECT public.purchase_ticket('$EVS', 'Free', '[{\"name\": \"d\"}]'::jsonb, 'SEAT-LATE', NULL);")"
expect_value "OPEN DECISION (documented, not changed): unpaid pending tickets created before the fix still count toward capacity" \
  "$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EVI' AND status = 'active' AND payment_status = 'pending' AND payment_ref LIKE 'REPRO-%';")" "2"

echo "== 16. Cancellation and refund protections intact (0218 / 0219) =="
REF_K=$(buy "$B3" "$EV_OTHER" 1); TK=$(tickets_of "$REF_K"); TK_TOK=$(tok "$B3" "$TK")
expect_error "deleting an event with ticket holders is still refused (0218)" "request a cancellation instead" "$(as "$ORG2" "SELECT public.soft_delete_event('$EV_OTHER', 'gone');")"
RQ=$(val "$(as "$ORG2" "SELECT public.request_event_cancellation('$EV_OTHER', 'Venue closed for repairs')->>'id';")")
"${PSQL[@]}" -q -c "$(as "$ADMIN_A" "SELECT public.admin_decide_event_cancellation('$RQ', true, NULL);")" >/dev/null
expect_value "the paid ticket of a cancelled event is queued for its refund" "$(val "SELECT status FROM public.event_cancellation_refunds WHERE ticket_id = '$TK';")" "queued"
expect_error "a paid ticket of a cancelled event cannot be checked in (0219), by QR" "cannot be checked in" \
  "$(as "$ORG2" "SELECT public.verify_entry_pass('$TK_TOK', '$ORG2');")"
expect_error "... nor manually" "cannot be checked in" "$(as "$ORG2" "SELECT public.manual_check_in('$TK', '$ORG2');")"
expect_value "... and it stays not checked in" "$(val "SELECT checked_in::text FROM public.tickets WHERE id = '$TK';")" "false"

if section_mechanics; then
  echo "== 17. Undo 0220 =="
  expect_error "undo_0220 refuses without the confirmation" "undo-0220" "$(cat "$REPO_ROOT/supabase/rollback/undo_0220.sql")"
  expect_ok "undo_0220 runs" "SET vents.rollback_confirm = 'undo-0220'; $(cat "$REPO_ROOT/supabase/rollback/undo_0220.sql")"
  expect_value "undo_0220 restores the exact pre-0220 function bodies" "$(body_hash)" "$H_BEFORE"
  expect_value "... and leaves owner, SECURITY DEFINER, search_path and grants as they were" "$(attrs)" "$ATTRS_BEFORE"

  echo "== 18. Drift: 0220 refuses a function that is not the expected version, and changes nothing =="
  ANCHOR="E'  v_sig        text;\nBEGIN'"
  drift_gen() {  # drift_gen <from> <to>: edit generate_ticket_token's live text in place (keeps it working)
    "${PSQL[@]}" -q -c "DO \$d\$ DECLARE v text := pg_get_functiondef('public.generate_ticket_token(uuid)'::regprocedure); BEGIN
      IF (length(v) - length(replace(v, $1, ''))) / length($1) <> 1 THEN RAISE EXCEPTION 'drift setup: text not found exactly once'; END IF;
      EXECUTE replace(v, $1, $2); END \$d\$;" >/dev/null
  }
  drift_gen "$ANCHOR" "E'  v_sig        text;  -- locally drifted\nBEGIN'"
  H_DRIFT=$(body_hash); ATTRS_DRIFT=$(attrs)
  expect_value "the drifted generate_ticket_token still works (only its anchor text differs)" "$([ -n "$(tok "$B4" "$TH")" ] && echo signed)" "signed"
  if pg -d "$DB_NAME" -1 -f "$MIG/0220_ticket_payment_integrity.sql" >"$OUT" 2>"$ERR"; then
    fail "0220 refuses to apply in one transaction over the drifted function (it applied)"
  else
    expect_value "0220, applied in one transaction, refuses and names the drifted function" \
      "$(grep -m1 -o 'public.generate_ticket_token(uuid) is not the expected version (anchor 1 not found exactly once)' "$ERR" || cat "$ERR")" \
      "public.generate_ticket_token(uuid) is not the expected version (anchor 1 not found exactly once)"
  fi
  expect_value "... no function carries [0220]: purchase_ticket, patched earlier in that transaction, was rolled back" "$(marked)" "0"
  expect_value "... every function body is exactly as before the attempt" "$(body_hash)" "$H_DRIFT"
  expect_value "... and owner, SECURITY DEFINER, search_path and grants are unchanged" "$(attrs)" "$ATTRS_DRIFT"
  expect_value "... the database is in its pre-0220 state: a paid tier can still be bought directly" "$(direct_buy "$B4" "$EVI" VIP DRIFT-1 | grep -c '^error' || true)" "0"
  # Applied WITHOUT a transaction (psql -f, autocommit), the same refusal leaves earlier functions patched.
  pg -d "$DB_NAME" -f "$MIG/0220_ticket_payment_integrity.sql" >/dev/null 2>&1 || true
  expect_value "DOCUMENTED RISK: outside a transaction the refusal leaves purchase_ticket alone patched (apply 0220 in one transaction)" "$(marked)" "1"
  expect_ok "undo_0220 cleans up that partial state" "SET vents.rollback_confirm = 'undo-0220'; $(cat "$REPO_ROOT/supabase/rollback/undo_0220.sql")"
  expect_value "... back to the drifted pre-0220 bodies" "$(body_hash)" "$H_DRIFT"
  drift_gen "E'  v_sig        text;  -- locally drifted\nBEGIN'" "$ANCHOR"
  expect_value "with the drift removed the bodies are the original ones again" "$(body_hash)" "$H_BEFORE"
  expect_ok "0220 re-applies" "$(cat "$MIG/0220_ticket_payment_integrity.sql")"
  expect_value "... to the same bodies as the first apply" "$(body_hash)" "$H_AFTER"
  expect_value "... with the same attributes and grants" "$(attrs)" "$ATTRS_BEFORE"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES TICKET INTEGRITY (0220) CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
