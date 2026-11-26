#!/usr/bin/env bash
# Migration 0231 (safe ticket-tier identity for older app builds, finding N3)
# against a real local PostgreSQL. Throwaway databases only.
#
# Base: the same production-copy stack as the 0229 suite (verbatim live
# copies of the purchase/finalize/confirm/analytics functions with 0203 and
# 0205-0208 applied, purchase_ticket and 0221 availability extracted
# verbatim), then the real 0229. Event saves are made AS THE ORGANIZER
# (role authenticated) with row-level security on tickets and
# pending_purchases hiding every row from them, so the sales checks are
# proven not to depend on what the caller can see.
#
# "Older app" saves send tiers exactly as builds before 0229 did:
# {id: t_<index>, name, price, quantity} -- no key, no previous_names.
#
# Every scenario runs WITHOUT 0231 (reproduces each audit failure) and WITH
# 0231. MUTATE=<name> applies a weakened 0231 (mutation test).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_ticket_tier_identity_safe"
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
ERR=$(mktemp); OUT=$(mktemp); M231=$(mktemp --suffix=.sql)
cleanup() { rm -f "$ERR" "$OUT" "$M231"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
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

cp "$MIG/0231_ticket_tier_identity_safe.sql" "$M231"; chmod 644 "$M231"
mutate() { python3 - "$M231" "$1" "$2" <<'PY'
import sys; p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]; s = open(p).read()
assert s.count(a) == 1, a; open(p, 'w').write(s.replace(a, b))
PY
}
case "${MUTATE:-}" in
  "") ;;
  no_ambiguity_refusal) mutate "  IF v_any_keyless AND v_unmatched_keyless THEN" "  IF false THEN" ;;
  no_name_ownership) mutate "  IF TG_OP = 'UPDATE' THEN
    FOR i IN 0" "  IF false THEN
    FOR i IN 0" ;;
  no_duplicate_tolerance) mutate "      v_ident := v_base; v_occ := 1;
      WHILE EXISTS" "      v_ident := v_base; v_occ := 1;
      WHILE false AND EXISTS" ;;
  match_keyless_by_key) mutate "       WHERE o->>'name' = v_tier->>'name' ORDER BY ord OFFSET v_occ - 1 LIMIT 1;" "       WHERE o->>'ident' = v_tier->>'name' ORDER BY ord OFFSET v_occ - 1 LIMIT 1;" ;;
  *) die "unknown MUTATE=$MUTATE" ;;
esac

ORG="00000000-0000-0000-0000-0000000231a1"
B1="00000000-0000-0000-0000-0000000231b1"; B2="00000000-0000-0000-0000-0000000231b2"; B3="00000000-0000-0000-0000-0000000231b3"
ev() { printf "00000000-0000-0000-0000-00000231e%03d" "$1"; }

pending() { val "$(as "$1" "SELECT public.create_pending_purchase('$2', '$3', '[{\"name\": \"A\"}]'::jsonb, NULL)->>'payment_ref';")"; }
finalize() { "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$1');" >"$OUT" 2>"$ERR"; }
confirm() { val "SELECT public.confirm_ticket_payment('$1', (SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$1'));"; }
buy() { local r; r=$(pending "$1" "$2" "$3"); finalize "$r" || return 1; confirm "$r" >/dev/null; echo "$r"; }
# save <event> <json>: the organizer saves the event's tiers (as the app does, through RLS).
save() { "${PSQL[@]}" -q -c "$(as "$ORG" "UPDATE public.events SET ticket_types = '$2'::jsonb WHERE id = '$1';")" >"$OUT" 2>"$ERR"; }
tiers() { val "SELECT string_agg(concat_ws('|', t->>'name', t->>'key', COALESCE((SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(t->'previous_names') x), ''), t->>'price'), ' ; ' ORDER BY o) FROM public.events, jsonb_array_elements(ticket_types) WITH ORDINALITY AS a(t, o) WHERE id = '$1'"; }
sold() { val "$(as "$ORG" "SELECT string_agg(ticket_type || '=' || sold_count, ',' ORDER BY ticket_type) FROM public.get_event_ticket_type_availability('$1')")"; }
mk_event() {  # mk_event <n> <tiers json>  (created by the current app: every tier has a key)
  "${PSQL[@]}" -q -c "INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES ('$(ev "$1")', '$ORG', 'Event $1', now() + interval '30 days', 'live', '$2');" >/dev/null 2>"$ERR" || die "fixture event $1: $(grep -m1 ERROR "$ERR")"
}
mk_legacy() {  # mk_legacy <n> <tiers json>  (saved before 0229: trigger bypassed, as for rows that predate it)
  "${PSQL[@]}" -q -c "ALTER TABLE public.events DISABLE TRIGGER trg_events_ticket_tier_identity; INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES ('$(ev "$1")', '$ORG', 'Legacy $1', now() + interval '30 days', 'live', '$2'); ALTER TABLE public.events ENABLE TRIGGER trg_events_ticket_tier_identity;" >/dev/null 2>"$ERR" || die "legacy fixture $1: $(grep -m1 ERROR "$ERR")"
}

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
  "${PSQL[@]}" -q -f "$MIG/0229_ticket_tier_rename.sql" >/dev/null 2>"$ERR" || die "0229 failed on the base: $(grep -m1 ERROR "$ERR")"
  "${PSQL[@]}" -q >/dev/null <<SQL
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.get_event_analytics(uuid), public.get_event_ticket_type_availability(uuid) TO authenticated;
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test'), ('$B1', 'user', false, 'B1', 'b1@example.test'),
  ('$B2', 'user', false, 'B2', 'b2@example.test'), ('$B3', 'user', false, 'B3', 'b3@example.test');
-- The organizer edits their own events through RLS and cannot read tickets
-- or orders directly (the sales checks must not depend on that).
GRANT SELECT, UPDATE ON public.events TO authenticated;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_select ON public.events FOR SELECT TO authenticated USING (true);
CREATE POLICY org_update ON public.events FOR UPDATE TO authenticated USING (organizer_id = auth.uid()) WITH CHECK (organizer_id = auth.uid());
GRANT SELECT ON public.tickets, public.pending_purchases TO authenticated;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_purchases ENABLE ROW LEVEL SECURITY;
SQL
}

TIER() { printf '{"id": "t_%s", %s"name": "%s", "price": %s, "quantity": %s}' "$1" "${5:+\"key\": \"$5\", }" "$2" "$3" "$4"; }

scenario() {
  local with="$1"
  MODE=$([ "$with" = 1 ] && echo "with 0231" || echo "without 0231")
  echo "== $MODE"
  build
  if [ "$with" = 1 ]; then
    if "${PSQL[@]}" -q -f "$M231" >"$OUT" 2>"$ERR"; then pass "0231 applies on 0229's trigger"; else fail "0231 applies ($(grep -m1 ERROR "$ERR"))"; return; fi
    expect_value "the organizer cannot see tickets directly (RLS), as in production" "$(val "$(as "$ORG" "SELECT count(*) FROM public.tickets")")" "0"
  fi

  echo "-- [$MODE] N3-a: older app deletes a sold tier and adds another in the same save"
  mk_event 1 "[$(TIER 0 Regular 10000 10 Regular), $(TIER 1 VIP 9000 5 VIP)]"
  buy "$B1" "$(ev 1)" VIP >/dev/null
  local inflight; inflight=$(pending "$B2" "$(ev 1)" VIP)
  local before; before=$(tiers "$(ev 1)")
  save "$(ev 1)" "[$(TIER 0 Regular 10000 10), $(TIER 1 Promo 50 100)]"; local rc=$?
  if [ "$with" = 1 ]; then
    [ $rc -ne 0 ] && grep -q 'Ticket type "VIP" already has sales, so this version of the VENTS app' "$ERR" \
      && pass "the ambiguous older-app save is refused with an actionable message" || fail "older-app delete+add should be refused (rc=$rc $(grep -m1 ERROR "$ERR"))"
    expect_value "...the event's tiers are unchanged" "$(tiers "$(ev 1)")" "$before"
    finalize "$inflight"
    expect_value "...the order in checkout for the ₦9,000 VIP tier is issued as VIP at ₦9,000" "$(confirm "$inflight")/$(val "SELECT ticket_type || '/' || amount FROM public.tickets WHERE payment_ref = '$inflight'")" "confirmed/VIP/9000"
  else
    finalize "$inflight"
    expect_value "DEFECT REPRODUCED: the new ₦50 'Promo' tier inherits VIP's identity and history" "$(tiers "$(ev 1)" | sed 's/.* ; //')" "Promo|VIP|VIP|50"
    expect_value "DEFECT REPRODUCED: the order in checkout for the ₦9,000 VIP tier is issued at ₦50 and confirmed" "$(val "SELECT amount FROM public.tickets WHERE payment_ref = '$inflight'")/$(confirm "$inflight")" "50/confirmed"
  fi

  echo "-- [$MODE] N3-b: older app deletes one sold tier and renames another"
  mk_event 2 "[$(TIER 0 Early 5000 10 Early), $(TIER 1 Late 8000 10 Late)]"
  buy "$B1" "$(ev 2)" Early >/dev/null; buy "$B2" "$(ev 2)" Late >/dev/null; buy "$B3" "$(ev 2)" Late >/dev/null
  save "$(ev 2)" "[$(TIER 0 Final 8000 10)]"; rc=$?
  if [ "$with" = 1 ]; then
    [ $rc -ne 0 ] && grep -q "already has sales" "$ERR" && pass "delete + rename from an older app is refused" || fail "delete+rename should be refused (rc=$rc $(grep -m1 ERROR "$ERR"))"
    expect_value "...sales stay with the right tiers" "$(sold "$(ev 2)")" "Early=1,Late=2"
  else
    expect_value "DEFECT REPRODUCED: 'Final' (really Late, 2 sold) is linked to Early's sales instead" "$(sold "$(ev 2)" | tr ',' '\n' | grep '^Final=')" "Final=1"
  fi

  echo "-- [$MODE] N3-c: legacy event with duplicate tier names"
  mk_legacy 3 '[{"id": "t_0", "name": "VIP", "price": 5000, "quantity": 2}, {"id": "t_1", "name": "VIP", "price": 8000, "quantity": 5}, {"id": "t_2", "name": "Gate", "price": 1000, "quantity": 9}]'
  buy "$B1" "$(ev 3)" VIP >/dev/null
  # The current app loads legacy tiers with key = name, so it sends key "VIP" twice.
  save "$(ev 3)" "[$(TIER 0 VIP 5000 2 VIP), $(TIER 1 VIP 9000 5 VIP), $(TIER 2 Gate 1000 9 Gate)]"; rc=$?
  if [ "$with" = 1 ]; then
    [ $rc -eq 0 ] && pass "a legacy duplicate-name event can be edited by the current app" || fail "legacy duplicate edit ($(grep -m1 ERROR "$ERR"))"
    expect_value "...each duplicate gets its own identity and the price edit lands on the second" "$(tiers "$(ev 3)")" "VIP|VIP||5000 ; VIP|VIP#2||9000 ; Gate|Gate||1000"
    save "$(ev 3)" "[$(TIER 0 VIP 5000 2 VIP), $(TIER 1 VIP 9500 5 VIP), $(TIER 2 Gate 1000 9 Gate)]"
    expect_value "...a stale editor sending key 'VIP' twice again still saves" "$?/$(tiers "$(ev 3)" | cut -d';' -f2)" "0/ VIP|VIP#2||9500 "
    save "$(ev 3)" '[{"id": "t_0", "name": "VIP", "price": 5000, "quantity": 2}, {"id": "t_1", "name": "VIP", "price": 9900, "quantity": 5}, {"id": "t_2", "name": "Gate", "price": 1200, "quantity": 9}]'
    expect_value "...an older app (no keys) can edit it too, identities kept" "$?/$(tiers "$(ev 3)")" "0/VIP|VIP||5000 ; VIP|VIP#2||9900 ; Gate|Gate||1200"
    save "$(ev 3)" "[$(TIER 0 VIP 5000 2 VIP), $(TIER 1 VIP 9900 5 'VIP#2'), $(TIER 2 Gate 1200 9 Gate), $(TIER 3 VIP 1 1 k-new)]"
    [ $? -ne 0 ] && grep -q "can't both be called" "$ERR" && pass "adding ANOTHER tier with the duplicated name is refused" || fail "new duplicate should be refused ($(grep -m1 ERROR "$ERR"))"
    expect_value "...existing VIP sales still count and are not split" "$(sold "$(ev 3)")" "Gate=0,VIP=1"
  else
    [ $rc -ne 0 ] && grep -q "same identity" "$ERR" && pass "DEFECT REPRODUCED: a legacy duplicate-name event cannot be edited at all" || fail "expected the 0229 identity error (rc=$rc $(grep -m1 ERROR "$ERR"))"
  fi

  echo "-- [$MODE] older app re-saves a tier the current app renamed"
  mk_event 4 "[$(TIER 0 Other 500 10 Other), $(TIER 1 Regular 10000 10 Regular)]"
  buy "$B1" "$(ev 4)" Regular >/dev/null
  save "$(ev 4)" "[$(TIER 0 Other 500 10 Other), $(TIER 1 GA 10000 10 Regular)]"
  # The older app reorders and edits the price (it sends current names, no keys).
  save "$(ev 4)" "[$(TIER 0 GA 12000 10), $(TIER 1 Other 500 10)]"; rc=$?
  if [ "$with" = 1 ]; then
    expect_value "the older app's reorder + price edit keeps the renamed tier's key and earlier names" "$rc/$(tiers "$(ev 4)" | cut -d';' -f1)" "0/GA|Regular|Regular|12000 "
    expect_value "...and its sales still count" "$(sold "$(ev 4)")" "GA=1,Other=0"
  else
    expect_value "DEFECT REPRODUCED: the older app's edit silently drops the renamed tier's earlier names, so its sale stops counting" "$(tiers "$(ev 4)" | cut -d';' -f1)/$(sold "$(ev 4)" | tr ',' '\n' | grep '^GA=')" "GA|GA||12000 /GA=0"
  fi

  echo "-- [$MODE] current app deletes a sold tier and adds a new one with the same name"
  mk_event 5 "[$(TIER 0 Regular 10000 1 Regular)]"
  buy "$B1" "$(ev 5)" Regular >/dev/null
  save "$(ev 5)" "[$(TIER 0 Regular 50 100 k-new)]"; rc=$?
  if [ "$with" = 1 ]; then
    [ $rc -ne 0 ] && grep -q 'already sold under the name "Regular"' "$ERR" && pass "a new tier cannot take a sold tier's name (sales would move)" || fail "name takeover should be refused (rc=$rc $(grep -m1 ERROR "$ERR"))"
  else
    expect_value "DEFECT REPRODUCED: the new ₦50 tier silently takes over the old tier's sale (and capacity)" "$(sold "$(ev 5)")/$(tiers "$(ev 5)")" "Regular=1/Regular|k-new||50"
  fi

  [ "$with" = 1 ] || return 0

  echo "-- [$MODE] older app: safe edits still work"
  mk_event 6 "[$(TIER 0 Sold 10000 10 Sold), $(TIER 1 Spare 2000 10 Spare)]"
  buy "$B1" "$(ev 6)" Sold >/dev/null
  save "$(ev 6)" "[$(TIER 0 Spare 2500 10), $(TIER 1 Sold 11000 12)]"
  expect_value "reorder + price + quantity edit from an older app" "$?/$(tiers "$(ev 6)")" "0/Spare|Spare||2500 ; Sold|Sold||11000"
  save "$(ev 6)" "[$(TIER 0 Spare 2500 10), $(TIER 1 Sold 11000 12), $(TIER 2 Door 3000 5)]"
  expect_value "adding a tier from an older app" "$?/$(tiers "$(ev 6)" | sed 's/.* ; //')" "0/Door|Door||3000"
  save "$(ev 6)" "[$(TIER 0 Extra 2500 10), $(TIER 1 Sold 11000 12), $(TIER 2 Door 3000 5)]"
  expect_value "renaming an UNSOLD tier from an older app" "$?/$(tiers "$(ev 6)" | cut -d';' -f1)" "0/Extra|Extra||2500 "
  save "$(ev 6)" "[$(TIER 0 Sold 11000 12), $(TIER 1 Door 3000 5)]"
  expect_value "removing an unsold tier from an older app" "$?/$(tiers "$(ev 6)")" "0/Sold|Sold||11000 ; Door|Door||3000"
  expect_value "sales stayed with their tier through every older-app edit" "$(sold "$(ev 6)")" "Door=0,Sold=1"
  save "$(ev 6)" "[$(TIER 0 Door 3000 5)]"
  expect_value "removing a sold tier outright (no replacement) is allowed; its ticket is untouched" "$?/$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$(ev 6)' AND ticket_type = 'Sold' AND status = 'active'")" "0/1"
  save "$(ev 6)" "[$(TIER 0 Door 3000 5), $(TIER 1 Sold 1 1)]"
  [ $? -ne 0 ] && grep -q "a ticket type that was removed" "$ERR" && pass "...and a new tier can't later reuse the removed tier's sold name" || fail "removed-name reuse should be refused ($(grep -m1 ERROR "$ERR"))"

  echo "-- [$MODE] older app: an open order alone blocks an ambiguous replace"
  mk_event 7 "[$(TIER 0 Solo 4000 10 Solo)]"
  local open7; open7=$(pending "$B1" "$(ev 7)" Solo)
  save "$(ev 7)" "[$(TIER 0 Duo 4000 10)]"
  [ $? -ne 0 ] && grep -q 'Ticket type "Solo" already has sales' "$ERR" && pass "a tier with only an open order cannot be replaced by an older app" || fail "open-order protection ($(grep -m1 ERROR "$ERR"))"
  finalize "$open7"; expect_value "...the open order still completes as Solo" "$(confirm "$open7")" "confirmed"

  echo "-- [$MODE] current app: normal edits unchanged (D2a)"
  mk_event 8 "[$(TIER 0 Regular 10000 3 Regular), $(TIER 1 Unsold 100 3 Unsold)]"
  buy "$B1" "$(ev 8)" Regular >/dev/null
  save "$(ev 8)" "[$(TIER 0 'General Admission' 12000 3 Regular), $(TIER 1 New 500 5 k-1)]"
  expect_value "rename a sold tier + remove an unsold one + add a new one (keys sent)" "$?/$(tiers "$(ev 8)")" "0/General Admission|Regular|Regular|12000 ; New|k-1||500"
  expect_value "...sales follow the renamed tier" "$(sold "$(ev 8)")" "General Admission=1,New=0"
  expect_error "renaming back onto another tier's earlier name is still refused (0229 rule)" "already used, or was used before" \
    "$(as "$ORG" "UPDATE public.events SET ticket_types = '[$(TIER 0 'General Admission' 12000 3 Regular), $(TIER 1 Regular 500 5 k-1)]' WHERE id = '$(ev 8)';")"
  expect_error "a brand-new event cannot be created with two tiers of the same name" "can't both be called" \
    "INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES ('$(ev 9)', '$ORG', 'Dup', now() + interval '30 days', 'live', '[$(TIER 0 A 1 1 k1), $(TIER 1 A 2 2 k2)]');"
  expect_value "previous_names sent by a client are still ignored" \
    "$(save "$(ev 8)" "[{\"key\": \"Regular\", \"name\": \"General Admission\", \"price\": 12000, \"quantity\": 3, \"previous_names\": [\"X\"]}, $(TIER 1 New 500 5 k-1)]"; tiers "$(ev 8)" | cut -d';' -f1)" "General Admission|Regular|Regular|12000 "
  expect_value "the trigger function is not callable directly by clients" "$(val "SELECT has_function_privilege('authenticated', 'public.events_ticket_tier_identity()', 'EXECUTE')")" "f"

  echo "-- [$MODE] undo, re-apply, drift"
  expect_error "0231 refuses to run twice" "already patched" "$(cat "$M231")"
  expect_error "undo refuses without the confirmation setting" "Refusing" "$(cat "$REPO_ROOT/supabase/rollback/undo_0231.sql")"
  local EVROWS; EVROWS=$(val "SELECT md5(string_agg(id || ticket_types::text, '|' ORDER BY id)) FROM public.events")
  expect_ok "undo runs with the confirmation setting" "SET vents.rollback_confirm = 'undo-0231'; $(cat "$REPO_ROOT/supabase/rollback/undo_0231.sql")"
  expect_value "undo restores 0229's trigger function byte-for-byte (definition and effective grant)" "$(val "SELECT md5(pg_get_functiondef(oid)) || has_function_privilege('authenticated', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'events_ticket_tier_identity'")" "$PRE_0231_DEF"
  expect_value "undo rewrites no event" "$(val "SELECT md5(string_agg(id || ticket_types::text, '|' ORDER BY id)) FROM public.events")" "$EVROWS"
  if "${PSQL[@]}" -q -f "$M231" >"$OUT" 2>"$ERR"; then pass "0231 re-applies after undo"; else fail "0231 re-applies ($(grep -m1 ERROR "$ERR"))"; fi
  expect_ok "undo again" "SET vents.rollback_confirm = 'undo-0231'; $(cat "$REPO_ROOT/supabase/rollback/undo_0231.sql")"
  "${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.events_ticket_tier_identity() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$;" >/dev/null
  if "${PSQL[@]}" -q -f "$M231" >"$OUT" 2>"$ERR"; then fail "0231 refuses a drifted trigger function"
  else grep -q "not the expected (0229) version" "$ERR" && pass "0231 refuses a drifted trigger function" || fail "drift refusal wording ($(grep -m1 ERROR "$ERR"))"; fi
  pg -d "$DB_NAME" -q -c "DROP TRIGGER trg_events_ticket_tier_identity ON public.events; DROP FUNCTION public.events_ticket_tier_identity();" >/dev/null
  if "${PSQL[@]}" -q -f "$M231" >"$OUT" 2>"$ERR"; then fail "0231 should refuse without 0229"
  else grep -q "requires 0229" "$ERR" && pass "0231 refuses to apply without 0229" || fail "0229 dependency refusal ($(grep -m1 ERROR "$ERR"))"; fi
}

MODE="baseline"; build
PRE_0231_DEF=$(val "SELECT md5(pg_get_functiondef(oid)) || has_function_privilege('authenticated', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'events_ticket_tier_identity'")
scenario 0
scenario 1

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES TICKET TIER IDENTITY (0231) CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
