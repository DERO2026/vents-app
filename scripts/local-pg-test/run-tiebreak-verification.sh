#!/usr/bin/env bash
# Zero-cost local-Postgres execution test for allocate_ticket_platform_fees'
# deterministic largest-remainder tie-break.
#
# Why this exists: an earlier review session ran a 3-ticket, equal-weight
# scenario (fee=10001, not divisible by 3) ad hoc against a local Postgres
# instance and reported 3334/3334/3333 as the result, but never committed
# that scenario into this harness -- so the claim was not reproducible from
# the repo. This script commits it as a real, repeatable assertion: three
# tickets with IDENTICAL amount (so the largest-remainder weights tie
# exactly), an authoritative fee that does not divide evenly by 3, and an
# assertion on the exact per-ticket split, confirming the remainder is
# distributed deterministically by ticket id (ascending) when fractional
# shares are tied.
#
# Prerequisites: same as run-rollback-verification.sh -- a local PostgreSQL
# server reachable via `psql` as a superuser. No Docker, no hosted service,
# no real Supabase project touched.
#
# Usage:
#   scripts/local-pg-test/run-tiebreak-verification.sh [migration_file]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATION_FILE="${1:-$REPO_ROOT/supabase/migrations/0192_platform_fee_accounting_foundation.sql}"
DB_NAME="vents_local_pg_tiebreak_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

echo "== Using migration: $MIGRATION_FILE =="

echo "== (Re)creating throwaway database '$DB_NAME' =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"

echo "== Applying minimal schema =="
"${PSQL[@]}" -f "$SCRIPT_DIR/schema.sql"

echo "== Applying migration under test =="
"${PSQL[@]}" -f "$MIGRATION_FILE"

echo "== Seeding 3 equal-amount tickets so largest-remainder weights tie exactly =="
echo "== (amount=10000 each; authoritative fee=10001, not divisible by 3) =="
"${PSQL[@]}" <<'SQL'
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000011', 'buyer-tie@test.com'),
  ('00000000-0000-0000-0000-000000000012', 'organizer-tie@test.com');
INSERT INTO public.events (id, organizer_id, title, event_date, status)
VALUES ('10000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000012', 'Tie-break Test Event', now() + interval '10 days', 'live');
INSERT INTO public.tickets (id, event_id, user_id, payer_id, quantity, payment_ref, payment_status, amount, ticket_type)
VALUES
  ('20000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011', 1, 'PAYREF-TIEBREAK-1', 'pending', 10000, 'A'),
  ('20000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011', 1, 'PAYREF-TIEBREAK-1', 'pending', 10000, 'B'),
  ('20000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011', 1, 'PAYREF-TIEBREAK-1', 'pending', 10000, 'C');
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, ticket_sale_id, metadata)
VALUES ('00000000-0000-0000-0000-000000000012', 'credit', 3000000,
  (SELECT min(id::text)::uuid FROM public.tickets WHERE payment_ref = 'PAYREF-TIEBREAK-1'),
  jsonb_build_object('paystack_reference', 'PAYREF-TIEBREAK-1', 'buyer_fee_kobo', 10001));
SQL

echo "== Confirming payment and triggering allocation =="
RESULT=$("${PSQL[@]}" -tA -c "SELECT public.confirm_ticket_payment('PAYREF-TIEBREAK-1', 3150000);")
[ "$RESULT" = "confirmed" ] || { echo "FAIL: expected 'confirmed', got '$RESULT'"; exit 1; }

echo "== Asserting exact per-ticket split for a 3-way tie (fee=10001, equal weights) =="
"${PSQL[@]}" -tA -c "SELECT id, amount, platform_fee_kobo FROM public.tickets WHERE payment_ref='PAYREF-TIEBREAK-1' ORDER BY id;"

ALLOCATIONS=$("${PSQL[@]}" -tA -F',' -c "SELECT platform_fee_kobo FROM public.tickets WHERE payment_ref='PAYREF-TIEBREAK-1' ORDER BY id;" | tr '\n' ',')
EXPECTED="3334,3334,3333,"
[ "$ALLOCATIONS" = "$EXPECTED" ] || { echo "FAIL: expected ordered allocations $EXPECTED, got $ALLOCATIONS"; exit 1; }
echo "PASS: remainder distributed deterministically by ascending id (3334, 3334, 3333)"

ALLOCATED_SUM=$("${PSQL[@]}" -tA -c "SELECT sum(platform_fee_kobo) FROM public.tickets WHERE payment_ref='PAYREF-TIEBREAK-1';")
[ "$ALLOCATED_SUM" = "10001" ] || { echo "FAIL: expected sum 10001, got $ALLOCATED_SUM"; exit 1; }
echo "PASS: allocated sum ($ALLOCATED_SUM) matches authoritative fee exactly"

echo "== Re-running allocator directly: idempotent, no change to the tie-broken split =="
RESULT2=$("${PSQL[@]}" -tA -c "SELECT public.allocate_ticket_platform_fees('PAYREF-TIEBREAK-1');")
[ "$RESULT2" = "already_allocated" ] || { echo "FAIL: expected 'already_allocated', got '$RESULT2'"; exit 1; }
ALLOCATIONS2=$("${PSQL[@]}" -tA -F',' -c "SELECT platform_fee_kobo FROM public.tickets WHERE payment_ref='PAYREF-TIEBREAK-1' ORDER BY id;" | tr '\n' ',')
[ "$ALLOCATIONS2" = "$EXPECTED" ] || { echo "FAIL: idempotent re-run changed the split: $ALLOCATIONS2"; exit 1; }
echo "PASS: idempotent re-run left the tie-broken split unchanged"

echo "== Cleanup =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"

echo
echo "ALL TIE-BREAK CHECKS PASSED"
