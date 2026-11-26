#!/usr/bin/env bash
# Migration 0229 (rename a ticket tier after sales begin, decision D2a) against
# a real local PostgreSQL. Throwaway databases; nothing here can reach a hosted
# database.
#
# Base: the same stack the 0208 fee-model suite builds -- verbatim LIVE
# production copies of create_pending_purchase, finalize_pending_purchase,
# confirm_ticket_payment and get_event_analytics (live-money-functions.sql),
# then the real 0203, 0205-0208 applied on top (so the in-place fee patches
# 0229 must coexist with are really there). purchase_ticket (0124) and
# get_event_ticket_type_availability (0221) are extracted verbatim from their
# latest migrations.
#
# Every scenario runs twice: WITHOUT 0229 (reproduces the defects: a rename
# resets the sold count and oversells, an order in checkout under the old name
# fails after payment, availability/analytics split the tier) and WITH 0229.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_ticket_tier_rename"
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
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || die "connection is not a local, non-Supabase PostgreSQL server ($server_check)."

PSQL=(pg -d "$DB_NAME")
ERR=$(mktemp); OUT=$(mktemp)
cleanup() { rm -f "$ERR" "$OUT"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT
PASSES=0; FAILS=0; MODE=""
pass() { echo "PASS: [$MODE] $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: [$MODE] $1" >&2; FAILS=$((FAILS+1)); }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1 ($(grep -m1 ERROR "$ERR"))"; fi; }
expect_error() { if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an error, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error: $(grep -m1 ERROR "$ERR"))"; fi; }

ORG="00000000-0000-0000-0000-0000000029a1"
BUYER="00000000-0000-0000-0000-0000000029b1"
BUYER2="00000000-0000-0000-0000-0000000029b2"
BUYER3="00000000-0000-0000-0000-0000000029b3"
EVENT="00000000-0000-0000-0000-0000000029e1"
LEGACY="00000000-0000-0000-0000-0000000029e2"

pending() {  # pending <user> <event> <tier name> -> payment_ref
  val "$(as "$1" "SELECT public.create_pending_purchase('$2', '$3', '[{\"name\": \"A\"}]'::jsonb, NULL)->>'payment_ref';")"
}
finalize() { "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$1');" >"$OUT" 2>"$ERR"; }
confirm() { val "SELECT public.confirm_ticket_payment('$1', (SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$1'));"; }
buy() { local r; r=$(pending "$1" "$2" "$3"); finalize "$r" || return 1; confirm "$r" >/dev/null; echo "$r"; }
tiers() { val "SELECT ticket_types::text FROM public.events WHERE id = '$1'"; }
set_tiers() { "${PSQL[@]}" -q -c "UPDATE public.events SET ticket_types = '$2'::jsonb WHERE id = '$1';" >"$OUT" 2>"$ERR"; }

build() {
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" -c "CREATE DATABASE $DB_NAME;" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
  for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
    "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
  done
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
  "${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
  "${PSQL[@]}" -q -c "SET vents.migration_local_test = 'on';" -f "$MIG/0202_payout_engine_safety.sql" >/dev/null 2>&1
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null 2>&1
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
  for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment 0208_ticket_fee_1_5_3_5; do
    "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null 2>"$ERR" || die "$m failed to apply on the base: $(grep -m1 ERROR "$ERR")"
  done
  PYTHONDONTWRITEBYTECODE=1 python3 - "$REPO_ROOT" <<'PY' | "${PSQL[@]}" -q >/dev/null || die "could not load purchase_ticket / availability"
import glob, importlib.util, os, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location('cvf', os.path.join(root, 'scripts', 'local-pg-test', 'check-verbatim-functions.py'))
cvf = importlib.util.module_from_spec(spec); spec.loader.exec_module(cvf)
files = [f for f in sorted(glob.glob(os.path.join(root, 'supabase', 'migrations', '*.sql'))) if os.path.basename(f)[:4] < '0229']
d = None
for f in files:
    x = cvf.last_definition(open(f, encoding='utf-8').read(), 'purchase_ticket')
    if x: d = x
print("SET check_function_bodies = off;")
print("ALTER TABLE public.events ADD COLUMN IF NOT EXISTS show_attendance_count boolean NOT NULL DEFAULT true;")
print(d + ';')
m = open(os.path.join(root, 'supabase', 'migrations', '0221_event_attendance_visibility.sql'), encoding='utf-8').read()
i = m.index('CREATE FUNCTION public.get_event_ticket_type_availability(p_event_id uuid)')
print(m[i:m.index('$function$;', i) + len('$function$;')])
PY
  "${PSQL[@]}" -q >/dev/null <<SQL
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.get_event_analytics(uuid), public.get_event_ticket_type_availability(uuid) TO authenticated;
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test'), ('$BUYER', 'user', false, 'Buyer', 'b1@example.test'),
  ('$BUYER2', 'user', false, 'Buyer Two', 'b2@example.test'), ('$BUYER3', 'user', false, 'Buyer Three', 'b3@example.test');
-- A legacy event (created before 0229: its tiers have no key / previous_names).
INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
  ('$LEGACY', '$ORG', 'Legacy night', now() + interval '30 days', 'live', '[{"id": "t_0", "name": "Early Bird", "price": 5000, "quantity": 2}, {"id": "t_1", "name": "Late", "price": 8000, "quantity": 5}]');
SQL
}

scenario() {
  local with="$1"
  MODE=$([ "$with" = 1 ] && echo "with 0229" || echo "without 0229")
  echo "== $MODE"
  build
  local legacy_ref; legacy_ref=$(buy "$BUYER" "$LEGACY" "Early Bird")
  if [ "$with" = 1 ]; then
    if "${PSQL[@]}" -q -f "$MIG/0229_ticket_tier_rename.sql" >"$OUT" 2>"$ERR"; then pass "0229 applies on the 0203/0208-patched production function bodies"; else fail "0229 applies ($(grep -m1 ERROR "$ERR"))"; return; fi
    expect_value "the five functions carry the [0229] patch" "$(val "SELECT count(*) FROM pg_proc WHERE proname IN ('purchase_ticket','create_pending_purchase','finalize_pending_purchase','get_event_ticket_type_availability','get_event_analytics') AND prosrc LIKE '%[0229]%'")" "5"
    expect_value "the 0208 fee patches are still in place" "$(val "SELECT count(*) FROM pg_proc WHERE proname IN ('create_pending_purchase','get_event_analytics') AND prosrc LIKE '%ticket_fee_buyer%'")" "2"
  fi

  "${PSQL[@]}" -q -c "INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES
    ('$EVENT', '$ORG', 'Rename night', now() + interval '30 days', 'live', '[{\"id\": \"t_0\", \"name\": \"Regular\", \"price\": 10000, \"quantity\": 3}, {\"id\": \"t_1\", \"name\": \"VIP\", \"price\": 50000, \"quantity\": 10}]');" >/dev/null
  if [ "$with" = 1 ]; then
    expect_value "a new event's tiers get key = name and an empty previous_names" \
      "$(val "SELECT string_agg((t->>'key') || ':' || (t->'previous_names')::text, ',') FROM public.events, jsonb_array_elements(ticket_types) t WHERE id='$EVENT'")" 'Regular:[],VIP:[]'
  fi

  # Two Regular sold; a third buyer is mid-checkout under the old name.
  local r1 r2 inflight; r1=$(buy "$BUYER" "$EVENT" "Regular"); r2=$(buy "$BUYER2" "$EVENT" "Regular")
  inflight=$(pending "$BUYER3" "$EVENT" "Regular")
  local amounts_before; amounts_before=$(val "SELECT string_agg(amount::text || '/' || payment_status, ',' ORDER BY id) FROM public.tickets WHERE event_id='$EVENT'")

  # The organizer renames Regular -> General Admission (the client sends the tier's key).
  if [ "$with" = 1 ]; then
    set_tiers "$EVENT" '[{"id": "t_0", "key": "Regular", "name": "General Admission", "price": 10000, "quantity": 3}, {"id": "t_1", "key": "VIP", "name": "VIP", "price": 50000, "quantity": 10}]'
  else
    set_tiers "$EVENT" '[{"id": "t_0", "name": "General Admission", "price": 10000, "quantity": 3}, {"id": "t_1", "name": "VIP", "price": 50000, "quantity": 10}]'
  fi
  expect_value "the rename is accepted (D2a)" "$(val "SELECT ticket_types->0->>'name' FROM public.events WHERE id='$EVENT'")" "General Admission"
  expect_value "existing tickets keep their purchase-time name" "$(val "SELECT string_agg(DISTINCT ticket_type, ',') FROM public.tickets WHERE event_id='$EVENT'")" "Regular"
  expect_value "existing tickets' amounts and payment status are untouched" "$(val "SELECT string_agg(amount::text || '/' || payment_status, ',' ORDER BY id) FROM public.tickets WHERE event_id='$EVENT'")" "$amounts_before"

  # The order that was in checkout under the old name completes.
  if finalize "$inflight"; then
    [ "$with" = 1 ] && pass "an order in checkout under the old name finalizes after the rename" || fail "BEFORE 0229 this should fail (it did not)"
    expect_value "...and is confirmed against the amount the buyer agreed to" "$(confirm "$inflight")" "confirmed"
    expect_value "...its ticket records the name it was bought under" "$(val "SELECT ticket_type FROM public.tickets WHERE payment_ref='$inflight'")" "Regular"
  else
    [ "$with" = 1 ] && fail "an order in checkout under the old name finalizes ($(grep -m1 ERROR "$ERR"))" \
      || { grep -q "Ticket type not found" "$ERR" && pass "DEFECT REPRODUCED: the buyer already paid, but finalize fails (Ticket type not found)" || fail "unexpected finalize error: $(grep -m1 ERROR "$ERR")"; }
  fi

  # Capacity: the tier allows 3. Try two more sales under the new name.
  local made=0 refused="" i ref
  for i in 1 2; do
    ref=$(pending "$BUYER" "$EVENT" "General Admission")
    if finalize "$ref"; then confirm "$ref" >/dev/null; made=$((made+1)); else refused=$(grep -m1 -oE "Only [0-9]+ [^']*remaining" "$ERR"); break; fi
  done
  local total; total=$(val "SELECT count(*) FROM public.tickets WHERE event_id='$EVENT' AND status='active' AND ticket_type IN ('Regular','General Admission')")
  if [ "$with" = 1 ]; then
    expect_value "selling past the tier's quantity is refused: sales under the old name count" "$made/$total/$refused" "0/3/Only 0 General Admission ticket(s) remaining"
  else
    if [ "$total" -gt 3 ]; then pass "DEFECT REPRODUCED: the renamed tier's sold count restarts at 0, so it oversells ($total sold, quantity 3)"; else fail "without 0229 expected an oversell (total $total)"; fi
  fi

  local avail; avail=$(val "$(as "$ORG" "SELECT string_agg(ticket_type || '=' || sold_count || '/' || sold_out, ',' ORDER BY ticket_type) FROM public.get_event_ticket_type_availability('$EVENT')")")
  local analytics; analytics=$(val "$(as "$ORG" "SELECT string_agg((b->>'name') || '=' || (b->>'soldCount') || '/' || coalesce(b->>'remaining','-'), ',' ORDER BY b->>'name') FROM jsonb_array_elements(public.get_event_analytics('$EVENT')->'byTicketType') b")")
  if [ "$with" = 1 ]; then
    expect_value "availability reports the tier under its new name, with old-name sales, and sold out" "$avail" "General Admission=3/true,VIP=0/false"
    expect_value "organizer analytics report one row per current tier (no split)" "$analytics" "General Admission=3/0,VIP=0/10"
  else
    case "$avail" in *"General Admission="*"/false"*"Regular="*) pass "DEFECT REPRODUCED: availability splits the tier in two and never shows it sold out ($avail)";; *) fail "unexpected availability without 0229: $avail";; esac
    case "$analytics" in *"Regular="*) pass "DEFECT REPRODUCED: analytics split the tier ($analytics)";; *) fail "unexpected analytics without 0229: $analytics";; esac
    return
  fi

  echo "-- [$MODE] further renames, safety rules"
  set_tiers "$EVENT" '[{"id": "t_0", "key": "Regular", "name": "GA", "price": 10000, "quantity": 3}, {"id": "t_1", "key": "VIP", "name": "VIP", "price": 50000, "quantity": 10}]'
  expect_value "a second rename keeps every earlier name" "$(val "SELECT (SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(ticket_types->0->'previous_names') x) FROM public.events WHERE id='$EVENT'")" "General Admission,Regular"
  expect_value "...and sales under both earlier names still count" "$(val "$(as "$ORG" "SELECT sold_count || '/' || sold_out FROM public.get_event_ticket_type_availability('$EVENT') WHERE ticket_type='GA'")")" "3/true"
  set_tiers "$EVENT" '[{"id": "t_0", "key": "Regular", "name": "GA", "price": 10000, "quantity": 3, "previous_names": ["VIP"]}, {"id": "t_1", "key": "VIP", "name": "VIP", "price": 50000, "quantity": 10}]'
  expect_value "previous_names sent by a client are ignored (server-maintained)" "$(val "SELECT (SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(ticket_types->0->'previous_names') x) FROM public.events WHERE id='$EVENT'")" "General Admission,Regular"
  expect_error "renaming another tier to a name this tier used before is refused" "already used, or was used before" \
    "UPDATE public.events SET ticket_types = '[{\"key\": \"Regular\", \"name\": \"GA\", \"price\": 10000, \"quantity\": 3}, {\"key\": \"VIP\", \"name\": \"Regular\", \"price\": 50000, \"quantity\": 10}]' WHERE id = '$EVENT';"
  expect_error "adding a new tier under a retired name is refused" "already used, or was used before" \
    "UPDATE public.events SET ticket_types = '[{\"key\": \"Regular\", \"name\": \"GA\", \"price\": 10000, \"quantity\": 3}, {\"key\": \"VIP\", \"name\": \"VIP\", \"price\": 50000, \"quantity\": 10}, {\"name\": \"General Admission\", \"price\": 1, \"quantity\": 1}]' WHERE id = '$EVENT';"
  expect_error "two tiers with the same key are refused" "same identity" \
    "UPDATE public.events SET ticket_types = '[{\"key\": \"Regular\", \"name\": \"GA\", \"price\": 10000, \"quantity\": 3}, {\"key\": \"Regular\", \"name\": \"Other\", \"price\": 1, \"quantity\": 1}]' WHERE id = '$EVENT';"
  expect_ok "a price change after sales is allowed (D2)" "UPDATE public.events SET ticket_types = '[{\"key\": \"Regular\", \"name\": \"GA\", \"price\": 12000, \"quantity\": 3}, {\"key\": \"VIP\", \"name\": \"VIP\", \"price\": 50000, \"quantity\": 10}]' WHERE id = '$EVENT';"
  expect_value "...and no existing ticket's amount changes" "$(val "SELECT string_agg(DISTINCT amount::text, ',') FROM public.tickets WHERE event_id='$EVENT'")" "10000"

  echo "-- [$MODE] legacy events (tiers saved before 0229)"
  set_tiers "$LEGACY" '[{"id": "t_0", "key": "Early Bird", "name": "Early Access", "price": 5000, "quantity": 2}, {"id": "t_1", "key": "Late", "name": "Late", "price": 8000, "quantity": 5}]'
  expect_value "a legacy tier renamed by the current app (key = loaded name) keeps its sales" \
    "$(val "$(as "$ORG" "SELECT sold_count FROM public.get_event_ticket_type_availability('$LEGACY') WHERE ticket_type='Early Access'")")" "1"
  set_tiers "$LEGACY" '[{"id": "t_0", "name": "Early Access", "price": 5000, "quantity": 2}, {"id": "t_1", "name": "Last Call", "price": 8000, "quantity": 5}]'
  expect_value "an older app build (no key) renaming a tier: matched by its per-save id" \
    "$(val "SELECT (ticket_types->1->>'key') || '|' || (ticket_types->1->'previous_names')::text FROM public.events WHERE id='$LEGACY'")" 'Late|["Late"]'
  expect_value "...the unchanged tier keeps its identity and history" \
    "$(val "SELECT (ticket_types->0->>'key') || '|' || (ticket_types->0->'previous_names')::text FROM public.events WHERE id='$LEGACY'")" 'Early Bird|["Early Bird"]'
  expect_value "a legacy ticket keeps its purchase-time name" "$(val "SELECT ticket_type FROM public.tickets WHERE payment_ref='$legacy_ref'")" "Early Bird"

  echo "-- [$MODE] undo and drift"
  local SRC; SRC=$(val "SELECT md5(string_agg(proname || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE proname IN ('purchase_ticket','create_pending_purchase','finalize_pending_purchase','get_event_ticket_type_availability','get_event_analytics')")
  local TICKETS_BEFORE_UNDO; TICKETS_BEFORE_UNDO=$(val "SELECT md5(string_agg(id || ticket_type || amount || payment_status || status, '|' ORDER BY id)) FROM public.tickets")
  expect_error "undo refuses without the confirmation setting" "Refusing" "$(cat "$REPO_ROOT/supabase/rollback/undo_0229.sql")"
  expect_ok "undo runs with the confirmation setting" "SET vents.rollback_confirm = 'undo-0229'; $(cat "$REPO_ROOT/supabase/rollback/undo_0229.sql")"
  expect_value "undo restores every patched function byte-for-byte (same as before 0229)" \
    "$(val "SELECT md5(string_agg(proname || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE proname IN ('purchase_ticket','create_pending_purchase','finalize_pending_purchase','get_event_ticket_type_availability','get_event_analytics')")" "$PRE_0229_SRC"
  expect_value "undo drops the trigger and helpers" "$(val "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='trg_events_ticket_tier_identity') + (SELECT count(*) FROM pg_proc WHERE proname LIKE 'ticket_tier_%' OR proname='events_ticket_tier_identity')")" "0"
  expect_value "undo leaves every ticket untouched" "$(val "SELECT md5(string_agg(id || ticket_type || amount || payment_status || status, '|' ORDER BY id)) FROM public.tickets")" "$TICKETS_BEFORE_UNDO"
  if "${PSQL[@]}" -q -f "$MIG/0229_ticket_tier_rename.sql" >"$OUT" 2>"$ERR"; then pass "0229 re-applies after undo"; else fail "0229 re-applies after undo ($(grep -m1 ERROR "$ERR"))"; fi
  expect_error "0229 refuses to run twice" "already exists" "$(cat "$MIG/0229_ticket_tier_rename.sql")"
  expect_ok "undo again" "SET vents.rollback_confirm = 'undo-0229'; $(cat "$REPO_ROOT/supabase/rollback/undo_0229.sql")"
  "${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.get_event_ticket_type_availability(p_event_id uuid) RETURNS TABLE(ticket_type text, sold_count integer, sold_out boolean) LANGUAGE sql STABLE AS \$f\$ SELECT NULL::text, 0, false \$f\$;" >/dev/null
  if "${PSQL[@]}" -q -f "$MIG/0229_ticket_tier_rename.sql" >"$OUT" 2>"$ERR"; then fail "0229 refuses a drifted function"
  else grep -q "not the expected version" "$ERR" && pass "0229 refuses a drifted function (nothing applied)" || fail "drift refusal wording ($(grep -m1 ERROR "$ERR"))"; fi
  expect_value "...and created nothing" "$(val "SELECT count(*) FROM pg_proc WHERE proname LIKE 'ticket_tier_%'")" "0"
}

# Pre-0229 function sources, captured on a fresh base, for the undo check.
MODE="baseline"; build
PRE_0229_SRC=$(val "SELECT md5(string_agg(proname || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE proname IN ('purchase_ticket','create_pending_purchase','finalize_pending_purchase','get_event_ticket_type_availability','get_event_analytics')")

scenario 0
scenario 1

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES TICKET TIER RENAME (0229) CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
