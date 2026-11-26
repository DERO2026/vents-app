#!/usr/bin/env bash
# Migration 0230 (checkout price snapshot, finding N1) against a real local
# PostgreSQL. Throwaway databases; nothing here can reach a hosted database.
#
# Base: the same production-copy stack as the 0229 suite -- verbatim LIVE
# copies of create_pending_purchase, finalize_pending_purchase,
# confirm_ticket_payment, confirm_ticket_payment_via_wallet, refund_ticket
# and get_event_analytics (live-money-functions.sql), the real 0203 and
# 0205-0208 applied on top, purchase_ticket and the 0221 availability
# function extracted verbatim, initiate_ticket_payment_attempt and its table
# extracted verbatim from 0060, then the real 0229.
#
# Every scenario runs twice: WITHOUT 0230 (reproduces each defect) and WITH
# 0230. MUTATE=<name> applies a deliberately weakened 0230 (used by
# run-checkout-price-snapshot-mutation-test.sh to prove the checks bite).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_checkout_price_snapshot"
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
ERR=$(mktemp); OUT=$(mktemp); M230=$(mktemp --suffix=.sql)
cleanup() { rm -f "$ERR" "$OUT" "$M230"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
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

# The migration under test, optionally weakened (mutation testing).
cp "$MIG/0230_checkout_price_snapshot.sql" "$M230"; chmod 644 "$M230"
case "${MUTATE:-}" in
  "") ;;
  finalize_ignores_snapshot) python3 - "$M230" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
a="      v_unit_price := v_row.quote_unit_price;\n      v_discount_pct := v_row.quote_discount_pct;\n"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"      NULL;\n"))
PY
  ;;
  no_stale_guard) python3 - "$M230" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
a="  IF NOT FOUND OR v_row.status <> 'pending' THEN\n    RETURN NULL;"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"  IF true THEN\n    RETURN NULL;"))
PY
  ;;
  stale_reuse) python3 - "$M230" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
a="     AND amount_kobo = v_amount_kobo\n     AND quote_unit_price = v_unit_price\n     AND quote_discount_pct = v_discount_pct"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"     AND true"))
PY
  ;;
  no_tier_key_check) python3 - "$M230" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
a="      IF v_row.quote_tier_key IS NOT NULL AND v_ticket_obj IS NOT NULL"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"      IF false AND v_ticket_obj IS NOT NULL"))
PY
  ;;
  mutable_snapshot) python3 - "$M230" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
a="    RAISE EXCEPTION 'An order''s agreed price cannot be changed after it is created';"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"    NULL;"))
PY
  ;;
  *) die "unknown MUTATE=$MUTATE" ;;
esac

ORG="00000000-0000-0000-0000-0000000230a1"
B=(); for i in 1 2 3 4 5 6 7 8 9; do B[$i]="00000000-0000-0000-0000-0000000230b$i"; done
PAYER="00000000-0000-0000-0000-0000000230c1"
ev() { printf "00000000-0000-0000-0000-00000230e%03d" "$1"; }

create() {  # create <user> <event> <tier> [promo] [payer] -> "ref amount"
  local promo="NULL" payer="NULL"
  [ -n "${4:-}" ] && promo="'$4'"; [ -n "${5:-}" ] && payer="'$5'"
  val "$(as "$1" "SELECT (r->>'payment_ref') || ' ' || (r->>'amount_kobo') FROM public.create_pending_purchase('$2', '$3', '[{\"name\": \"A\"}]'::jsonb, $promo, $payer) r;")"
}
initiate() { "${PSQL[@]}" -tA -c "$(as "$1" "SELECT public.initiate_ticket_payment_attempt('$2')->>'amount_kobo';")" >"$OUT" 2>"$ERR"; }
finalize() { "${PSQL[@]}" -q -c "SELECT public.finalize_pending_purchase('$1');" >"$OUT" 2>"$ERR"; }
confirm() { val "SELECT public.confirm_ticket_payment('$1', $2);"; }
wallet_pay() { "${PSQL[@]}" -tA -c "$(as "$1" "SELECT public.confirm_ticket_payment_via_wallet('$2');")" >"$OUT" 2>"$ERR"; }
balance() { val "SELECT balance_kobo FROM public.user_wallets WHERE user_id = '$1'"; }
fund() { "${PSQL[@]}" -q -c "INSERT INTO public.user_wallets (user_id, balance_kobo) VALUES ('$1', $2) ON CONFLICT (user_id) DO UPDATE SET balance_kobo = $2;" >/dev/null; }
price() {  # price <event> <tier key/name> <new price>   (current-app save: tiers carry their key)
  "${PSQL[@]}" -q -c "UPDATE public.events SET ticket_types = (SELECT jsonb_agg(CASE WHEN t->>'name' = '$2' THEN t || jsonb_build_object('price', $3) ELSE t END) FROM jsonb_array_elements(ticket_types) t) WHERE id = '$1';" >"$OUT" 2>"$ERR"
}
ticket_amounts() { val "SELECT string_agg(amount::text || '/' || discount_percentage::text || '/' || payment_status, ',' ORDER BY id) FROM public.tickets WHERE payment_ref = '$1'"; }
credited() { val "SELECT COALESCE(sum(amount_kobo), 0) FROM public.organizer_transactions WHERE metadata->>'paystack_reference' = '$1' OR metadata->>'wallet_reference' = '$1'"; }
new_event() {  # new_event <n> [price] [quantity]
  "${PSQL[@]}" -q -c "INSERT INTO public.events (id, organizer_id, title, event_date, status, ticket_types) VALUES ('$(ev "$1")', '$ORG', 'Event $1', now() + interval '30 days', 'live', '[{\"name\": \"Regular\", \"price\": ${2:-10000}, \"quantity\": ${3:-100}}]');" >/dev/null
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
  PYTHONDONTWRITEBYTECODE=1 python3 - "$REPO_ROOT" <<'PY' | "${PSQL[@]}" -q >/dev/null 2>"$ERR" || die "could not load verbatim functions: $(grep -m1 ERROR "$ERR")"
import glob, importlib.util, os, re, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location('cvf', os.path.join(root, 'scripts', 'local-pg-test', 'check-verbatim-functions.py'))
cvf = importlib.util.module_from_spec(spec); spec.loader.exec_module(cvf)
files = [f for f in sorted(glob.glob(os.path.join(root, 'supabase', 'migrations', '*.sql'))) if os.path.basename(f)[:4] < '0229']
def latest(name):
    d = None
    for f in files:
        x = cvf.last_definition(open(f, encoding='utf-8').read(), name)
        if x: d = x
    return d
print("SET check_function_bodies = off;")
print("ALTER TABLE public.events ADD COLUMN IF NOT EXISTS show_attendance_count boolean NOT NULL DEFAULT true;")
print(latest('purchase_ticket') + ';')
m = open(os.path.join(root, 'supabase', 'migrations', '0221_event_attendance_visibility.sql'), encoding='utf-8').read()
i = m.index('CREATE FUNCTION public.get_event_ticket_type_availability(p_event_id uuid)')
print(m[i:m.index('$function$;', i) + len('$function$;')])
m = open(os.path.join(root, 'supabase', 'migrations', '0060_ticket_payment_attempt_ref.sql'), encoding='utf-8').read()
i = m.index('CREATE TABLE IF NOT EXISTS public.ticket_payment_attempts')
print(m[i:m.index(');', i) + 2])
print(latest('initiate_ticket_payment_attempt') + ';')
PY
  "${PSQL[@]}" -q >/dev/null <<SQL
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.confirm_ticket_payment_via_wallet(text),
  public.initiate_ticket_payment_attempt(text), public.refund_ticket(uuid,text), public.get_event_analytics(uuid),
  public.get_event_ticket_type_availability(uuid) TO authenticated;
INSERT INTO public.users (id, role, is_organizer, full_name, email, username) VALUES
  ('$ORG', 'user', true, 'Org', 'org@example.test', 'org230'), ('$PAYER', 'user', false, 'Payer', 'payer@example.test', 'payer230'),
  ('${B[1]}', 'user', false, 'B1', 'b1@example.test', 'b1'), ('${B[2]}', 'user', false, 'B2', 'b2@example.test', 'b2'),
  ('${B[3]}', 'user', false, 'B3', 'b3@example.test', 'b3'), ('${B[4]}', 'user', false, 'B4', 'b4@example.test', 'b4'),
  ('${B[5]}', 'user', false, 'B5', 'b5@example.test', 'b5'), ('${B[6]}', 'user', false, 'B6', 'b6@example.test', 'b6'),
  ('${B[7]}', 'user', false, 'B7', 'b7@example.test', 'b7'), ('${B[8]}', 'user', false, 'B8', 'b8@example.test', 'b8'),
  ('${B[9]}', 'user', false, 'B9', 'b9@example.test', 'b9');
INSERT INTO public.promo_codes (code, discount_percentage) VALUES ('TEN', 10), ('GONE', 10);
SQL
  "${PSQL[@]}" -q -f "$MIG/0229_ticket_tier_rename.sql" >/dev/null 2>"$ERR" || die "0229 failed on the base: $(grep -m1 ERROR "$ERR")"
  for n in 1 2 3 4 5 6 7 8 9; do new_event "$n"; done
  new_event 10 10000 2     # capacity 2
}

fn_md5() { val "SELECT md5(string_agg(proname || prosrc, '|' ORDER BY proname)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($1)"; }
PATCHED="'create_pending_purchase','finalize_pending_purchase','confirm_ticket_payment','confirm_ticket_payment_via_wallet','initiate_ticket_payment_attempt'"
FEE_HELPERS="'ticket_fee_buyer_charge_kobo','ticket_fee_organizer_deduction_kobo','ticket_fee_organizer_deduction_total_kobo','ticket_fee_buyer_multiplier','ticket_fee_quote'"

scenario() {
  local with="$1"
  MODE=$([ "$with" = 1 ] && echo "with 0230" || echo "without 0230")
  echo "== $MODE"
  build
  # A legacy order (created before 0230): no snapshot.
  local legacy legacy_amt; read -r legacy legacy_amt <<<"$(create "${B[9]}" "$(ev 9)" Regular)"
  local fee_before; fee_before=$(fn_md5 "$FEE_HELPERS")
  if [ "$with" = 1 ]; then
    if "${PSQL[@]}" -q -f "$M230" >"$OUT" 2>"$ERR"; then pass "0230 applies on the 0203/0208/0229-patched production function bodies"; else fail "0230 applies ($(grep -m1 -E "ERROR|FATAL" "$ERR"; head -c 300 "$ERR"))"; return; fi
    expect_value "the five functions carry the [0230] patch" "$(val "SELECT count(*) FROM pg_proc WHERE proname IN ($PATCHED) AND prosrc LIKE '%[0230]%'")" "5"
    expect_value "the 0229 tier patches are still in place" "$(val "SELECT count(*) FROM pg_proc WHERE proname IN ('create_pending_purchase','finalize_pending_purchase') AND prosrc LIKE '%[0229]%'")" "2"
    expect_value "the 0208 fee model (1.5% attendee / 3.5% organizer) is unchanged" "$(fn_md5 "$FEE_HELPERS")" "$fee_before"
  fi

  echo "-- [$MODE] snapshot contents"
  local r a; read -r r a <<<"$(create "${B[1]}" "$(ev 1)" Regular)"
  expect_value "order total for 1 x ₦10,000 is ₦10,150 (1.5% service fee)" "$a" "1015000"
  if [ "$with" = 1 ]; then
    expect_value "the order stores the full agreed quote" \
      "$(val "SELECT concat_ws('/', quote_unit_price, quote_discount_pct, quote_quantity, quote_face_kobo, quote_service_fee_kobo, quote_discount_kobo, quote_organizer_deduction_kobo, quote_currency, quote_tier_key, quoted_at IS NOT NULL) FROM public.pending_purchases WHERE payment_ref = '$r'")" \
      "10000/0/1/1000000/15000/0/35000/NGN/Regular/t"
    expect_error "the agreed total cannot be edited afterwards" "cannot be changed after it is created" "UPDATE public.pending_purchases SET amount_kobo = 1 WHERE payment_ref = '$r';"
    expect_error "the agreed unit price cannot be edited afterwards" "cannot be changed after it is created" "UPDATE public.pending_purchases SET quote_unit_price = 1 WHERE payment_ref = '$r';"
    expect_error "a snapshot cannot be added to an older order" "only be written when the order is created" "UPDATE public.pending_purchases SET quote_unit_price = 1 WHERE payment_ref = '$legacy';"
    expect_ok "status changes are still allowed (finalize / expiry)" "UPDATE public.pending_purchases SET status = status WHERE payment_ref = '$r';"
  fi

  echo "-- [$MODE] Paystack: price RAISED after the card charge started"
  read -r r a <<<"$(create "${B[2]}" "$(ev 2)" Regular)"
  initiate "${B[2]}" "$r"; expect_value "payment attempt charges the agreed ₦10,150" "$(tail -n1 "$OUT")" "1015000"
  price "$(ev 2)" Regular 12000
  finalize "$r"
  local st; st=$(confirm "$r" 1015000)
  if [ "$with" = 1 ]; then
    expect_value "the paid order is confirmed at the agreed amount" "$st" "confirmed"
    expect_value "...its ticket records the agreed price ₦10,000" "$(ticket_amounts "$r")" "10000/0/paid"
    expect_value "...the organizer is credited on the agreed price (₦10,000 - 3.5%)" "$(credited "$r")" "965000"
  else
    case "$st" in amount_mismatch:1218000:1015000) pass "DEFECT REPRODUCED: buyer charged ₦10,150 but no ticket ($st)";; *) fail "expected amount_mismatch without 0230, got $st";; esac
  fi
  expect_value "duplicate Paystack callback does not confirm or credit twice" "$(finalize "$r"; confirm "$r" 1015000)/$(credited "$r")" \
    "$([ "$with" = 1 ] && echo "already_paid/965000" || echo "amount_mismatch:1218000:1015000/0")"

  echo "-- [$MODE] Paystack: price LOWERED after the charge started"
  read -r r a <<<"$(create "${B[3]}" "$(ev 3)" Regular)"
  initiate "${B[3]}" "$r"
  price "$(ev 3)" Regular 8000
  finalize "$r"; st=$(confirm "$r" 1015000)
  expect_value "the paid order is confirmed" "$st" "confirmed"
  if [ "$with" = 1 ]; then
    expect_value "...at the agreed ₦10,000 (the ₦10,150 paid matches the ticket exactly)" "$(ticket_amounts "$r")" "10000/0/paid"
  else
    expect_value "DEFECT REPRODUCED: ticket issued at ₦8,000 though the buyer paid ₦10,150 (overpayment kept silently)" "$(ticket_amounts "$r")" "8000/0/paid"
  fi

  echo "-- [$MODE] Paystack: promo DELETED / CHANGED after the charge started"
  read -r r a <<<"$(create "${B[4]}" "$(ev 4)" Regular GONE)"
  expect_value "with a 10% promo the order total is ₦9,150" "$a" "915000"
  initiate "${B[4]}" "$r"
  "${PSQL[@]}" -q -c "DELETE FROM public.promo_codes WHERE code = 'GONE';"
  finalize "$r"; st=$(confirm "$r" 915000)
  if [ "$with" = 1 ]; then
    expect_value "promo deleted mid-checkout: confirmed with the agreed 10% discount" "$st/$(ticket_amounts "$r")" "confirmed/10000/10/paid"
  else
    case "$st" in amount_mismatch:*) pass "DEFECT REPRODUCED: promo deleted mid-checkout, buyer charged but no ticket ($st)";; *) fail "expected amount_mismatch without 0230, got $st";; esac
  fi
  read -r r a <<<"$(create "${B[4]}" "$(ev 5)" Regular TEN)"
  initiate "${B[4]}" "$r"
  "${PSQL[@]}" -q -c "UPDATE public.promo_codes SET discount_percentage = 50 WHERE code = 'TEN';"
  finalize "$r"; st=$(confirm "$r" 915000)
  if [ "$with" = 1 ]; then
    expect_value "promo changed 10% -> 50% mid-checkout: ticket keeps the agreed 10%" "$st/$(ticket_amounts "$r")" "confirmed/10000/10/paid"
  else
    expect_value "DEFECT REPRODUCED: promo changed mid-checkout, ticket records 50% though the buyer paid for 10%" "$st/$(ticket_amounts "$r")" "confirmed/10000/50/paid"
  fi
  "${PSQL[@]}" -q -c "UPDATE public.promo_codes SET discount_percentage = 10 WHERE code = 'TEN';"

  echo "-- [$MODE] Wallet: price RAISED before paying"
  fund "${B[5]}" 3000000
  read -r r a <<<"$(create "${B[5]}" "$(ev 6)" Regular)"
  price "$(ev 6)" Regular 12000
  if wallet_pay "${B[5]}" "$r"; then
    if [ "$with" = 1 ]; then fail "wallet payment of a stale quote should be refused"
    else expect_value "DEFECT REPRODUCED: wallet debited ₦12,180, more than the agreed ₦10,150" "$(tail -n1 "$OUT")/$((3000000 - $(balance "${B[5]}")))" "confirmed/1218000"; fi
  else
    if [ "$with" = 1 ]; then
      grep -q "price of this ticket has changed" "$ERR" && pass "wallet payment of a stale quote is refused with a clear message" || fail "wrong refusal: $(grep -m1 ERROR "$ERR")"
      expect_value "...nothing was debited and no ticket was issued" "$(balance "${B[5]}")/$(val "SELECT count(*) FROM public.tickets WHERE payment_ref = '$r'")" "3000000/0"
      expect_value "...the order is left untouched (still pending)" "$(val "SELECT status FROM public.pending_purchases WHERE payment_ref = '$r'")" "pending"
      local r2 a2; read -r r2 a2 <<<"$(create "${B[5]}" "$(ev 6)" Regular)"
      expect_value "retry after the price change gets a FRESH order at the new total" "$([ "$r2" != "$r" ] && echo new)/$a2" "new/1218000"
      wallet_pay "${B[5]}" "$r2"
      expect_value "...which the wallet pays at exactly that total" "$(tail -n1 "$OUT")/$((3000000 - $(balance "${B[5]}")))" "confirmed/1218000"
      wallet_pay "${B[5]}" "$r2"
      expect_value "duplicate wallet payment is a no-op (debited once)" "$(tail -n1 "$OUT")/$((3000000 - $(balance "${B[5]}")))" "already_paid/1218000"
    else fail "without 0230 the wallet payment should go through ($(grep -m1 ERROR "$ERR"))"; fi
  fi

  echo "-- [$MODE] Wallet: price LOWERED before paying, then refund"
  fund "${B[6]}" 3000000
  read -r r a <<<"$(create "${B[6]}" "$(ev 7)" Regular)"
  price "$(ev 7)" Regular 8000
  if wallet_pay "${B[6]}" "$r"; then
    [ "$with" = 1 ] && fail "wallet payment of a stale (lowered) quote should be refused" \
      || expect_value "DEFECT REPRODUCED: wallet debited ₦8,120, not the agreed ₦10,150" "$((3000000 - $(balance "${B[6]}")))" "812000"
  else
    if [ "$with" = 1 ]; then
      pass "wallet payment of a lowered stale quote is refused (buyer re-quotes)"
      read -r r a <<<"$(create "${B[6]}" "$(ev 7)" Regular)"
      wallet_pay "${B[6]}" "$r"
      expect_value "...the fresh order is paid at the new ₦8,120" "$(tail -n1 "$OUT")/$((3000000 - $(balance "${B[6]}")))" "confirmed/812000"
      local tid; tid=$(val "SELECT id FROM public.tickets WHERE payment_ref = '$r'")
      expect_value "a refund returns exactly what the wallet was charged" \
        "$(val "$(as "$ORG" "SELECT public.refund_ticket('$tid', 'cancelled')->>'amount_kobo';")")/$(balance "${B[6]}")" "812000/3000000"
    else fail "without 0230 the wallet payment should go through ($(grep -m1 ERROR "$ERR"))"; fi
  fi

  echo "-- [$MODE] retry after a price change; no stale reuse"
  read -r r a <<<"$(create "${B[7]}" "$(ev 8)" Regular)"
  local same; same=$(create "${B[7]}" "$(ev 8)" Regular)
  expect_value "an identical retry at the same price reuses the order (no double charge)" "$same" "$r $a"
  price "$(ev 8)" Regular 12000
  local again; again=$(create "${B[7]}" "$(ev 8)" Regular)
  if [ "$with" = 1 ]; then
    expect_value "a retry after a price change gets a fresh order at the new total" "$([ "${again% *}" != "$r" ] && echo new) ${again#* }" "new 1218000"
    initiate "${B[7]}" "$r" && fail "a new card attempt on the stale order should be refused" \
      || { grep -q "price of this ticket has changed" "$ERR" && pass "a new card attempt on the stale order is refused (no charge starts)" || fail "wrong refusal: $(grep -m1 ERROR "$ERR")"; }
    initiate "${B[7]}" "${again% *}"; expect_value "...the fresh order can be paid" "$(tail -n1 "$OUT")" "1218000"
  else
    expect_value "DEFECT REPRODUCED: the retry is handed the stale ₦10,150 order (the checkout screen refuses it: buyer stuck)" "$again" "$r $a"
  fi

  echo "-- [$MODE] someone-else-pays request"
  read -r r a <<<"$(create "${B[8]}" "$(ev 9)" Regular "" payer230)"
  price "$(ev 9)" Regular 12000
  if initiate "$PAYER" "$r"; then
    [ "$with" = 1 ] && fail "payer starting a charge on a stale request should be refused" \
      || pass "DEFECT REPRODUCED: the payer is charged the stale ₦$((a/100)) for a ₦12,000 ticket ($(tail -n1 "$OUT"))"
  else
    [ "$with" = 1 ] && grep -q "price of this ticket has changed" "$ERR" && pass "payer starting a charge on a stale request is refused" || fail "payer refusal ($(grep -m1 ERROR "$ERR"))"
  fi
  if [ "$with" = 1 ]; then
    expect_value "a legacy (pre-0230) order whose price changed is also refused at payment start" \
      "$(initiate "${B[9]}" "$legacy" && echo started || (grep -q "price of this ticket has changed" "$ERR" && echo refused))" "refused"
    price "$(ev 9)" Regular 10000
    initiate "${B[9]}" "$legacy"; expect_value "a legacy order at an unchanged price can still be paid" "$(tail -n1 "$OUT")" "$legacy_amt"
    finalize "$legacy"; expect_value "...and finalizes exactly as before 0230" "$(confirm "$legacy" "$legacy_amt")/$(ticket_amounts "$legacy")" "confirmed/10000/0/paid"
  fi

  echo "-- [$MODE] tier identity and capacity"
  read -r r a <<<"$(create "${B[1]}" "$(ev 10)" Regular)"
  # Current app: deletes "Regular" and adds a brand-new tier (new key) with the same name and another price.
  "${PSQL[@]}" -q -c "UPDATE public.events SET ticket_types = '[{\"key\": \"k-new\", \"name\": \"Regular\", \"price\": 50, \"quantity\": 100}]' WHERE id = '$(ev 10)';" >/dev/null 2>&1
  if [ "$(val "SELECT ticket_types->0->>'key' FROM public.events WHERE id = '$(ev 10)'")" = "k-new" ]; then
    finalize "$r"; local fst=$?
    if [ "$with" = 1 ]; then
      [ $fst -ne 0 ] && grep -q "ticket type for this order has changed" "$ERR" && pass "an order for a deleted tier is never issued as the new same-named tier" || fail "tier swap should be refused ($(grep -m1 ERROR "$ERR"); rc=$fst; tickets $(ticket_amounts "$r"))"
      expect_value "...the order stays pending and reconcilable (no ticket, nothing confirmed)" "$(val "SELECT status FROM public.pending_purchases WHERE payment_ref = '$r'")/$(confirm "$r" "$a")" "pending/not_found"
    else
      expect_value "DEFECT REPRODUCED: an order for the deleted ₦10,000 tier is issued as the new ₦50 tier" "$([ $fst -eq 0 ] && ticket_amounts "$r")" "50/0/pending"
    fi
  else
    fail "fixture: could not replace the tier ($(grep -m1 ERROR "$ERR"))"
  fi
  "${PSQL[@]}" -q -c "UPDATE public.events SET ticket_types = '[{\"key\": \"cap\", \"name\": \"Capped\", \"price\": 10000, \"quantity\": 1}]' WHERE id = '$(ev 10)';" >/dev/null
  local c1 c2 ca; read -r c1 ca <<<"$(create "${B[2]}" "$(ev 10)" Capped)"; read -r c2 ca <<<"$(create "${B[3]}" "$(ev 10)" Capped)"
  finalize "$c1"; confirm "$c1" "$ca" >/dev/null
  finalize "$c2" && fail "capacity: the second order should be refused" || { grep -q "Only 0 Capped" "$ERR" && pass "tier capacity is still enforced at finalize" || fail "capacity refusal ($(grep -m1 ERROR "$ERR"))"; }

  [ "$with" = 1 ] || return 0
  echo "-- [$MODE] undo, re-apply, drift"
  expect_error "undo_0229 refuses while 0230 is applied" "0230 is applied" "SET vents.rollback_confirm = 'undo-0229'; $(cat "$REPO_ROOT/supabase/rollback/undo_0229.sql")"
  expect_error "0230 refuses to run twice" "already" "$(cat "$M230")"
  expect_error "undo refuses without the confirmation setting" "Refusing" "$(cat "$REPO_ROOT/supabase/rollback/undo_0230.sql")"
  local TICKETS; TICKETS=$(val "SELECT md5(string_agg(id || ticket_type || amount || payment_status || status, '|' ORDER BY id)) FROM public.tickets")
  expect_ok "undo runs with the confirmation setting" "SET vents.rollback_confirm = 'undo-0230'; $(cat "$REPO_ROOT/supabase/rollback/undo_0230.sql")"
  expect_value "undo restores every patched function byte-for-byte" "$(fn_md5 "$PATCHED")" "$PRE_0230_SRC"
  expect_value "undo drops the trigger and helpers" "$(val "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_pending_purchases_quote_immutable') + (SELECT count(*) FROM pg_proc WHERE proname IN ('ticket_order_quote_problem','pending_purchases_quote_immutable'))")" "0"
  expect_value "undo keeps every ticket and every stored quote" "$(val "SELECT md5(string_agg(id || ticket_type || amount || payment_status || status, '|' ORDER BY id)) FROM public.tickets")/$(val "SELECT count(*) > 0 FROM public.pending_purchases WHERE quote_unit_price IS NOT NULL")" "$TICKETS/t"
  if "${PSQL[@]}" -q -f "$M230" >"$OUT" 2>"$ERR"; then pass "0230 re-applies after undo"; else fail "0230 re-applies after undo ($(grep -m1 ERROR "$ERR"))"; fi
  expect_ok "undo again" "SET vents.rollback_confirm = 'undo-0230'; $(cat "$REPO_ROOT/supabase/rollback/undo_0230.sql")"
  "${PSQL[@]}" -q -c "CREATE OR REPLACE FUNCTION public.initiate_ticket_payment_attempt(p_payment_ref text) RETURNS jsonb LANGUAGE sql AS \$f\$ SELECT NULL::jsonb \$f\$;" >/dev/null
  if "${PSQL[@]}" -q -f "$M230" >"$OUT" 2>"$ERR"; then fail "0230 refuses a drifted function"
  else grep -q "not the expected version" "$ERR" && pass "0230 refuses a drifted function" || fail "drift refusal wording ($(grep -m1 ERROR "$ERR"))"; fi
  expect_value "...and changed nothing (transaction rolled back)" "$(val "SELECT count(*) FROM pg_proc WHERE proname LIKE '%[0230]%' OR prosrc LIKE '%[0230]%'")" "0"
  expect_ok "undo_0229 runs once 0230 is undone" "SET vents.rollback_confirm = 'undo-0229'; $(cat "$REPO_ROOT/supabase/rollback/undo_0229.sql")"
  if "${PSQL[@]}" -q -f "$MIG/0230_checkout_price_snapshot.sql" >"$OUT" 2>"$ERR"; then fail "0230 should refuse without 0229"
  else grep -q "requires 0229" "$ERR" && pass "0230 refuses to apply without 0229" || fail "0229 dependency refusal ($(grep -m1 ERROR "$ERR"))"; fi
}

MODE="baseline"; build
PRE_0230_SRC=$(fn_md5 "$PATCHED")

scenario 0
scenario 1

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES CHECKOUT PRICE SNAPSHOT (0230) CHECKS PASSED"; exit 0; fi
echo "$FAILS FAILED, $PASSES PASSED" >&2; exit 1
