#!/usr/bin/env bash
# Zero-cost local-Postgres execution test for migration 0192's financial
# functions (confirm_ticket_payment / credit_organizer_wallet /
# allocate_ticket_platform_fees).
#
# Why this exists: the existing test suite for this migration (see
# src/lib/platformFeeAllocation.security.test.ts) only does two kinds of
# checking -- regex assertions against the migration's raw SQL text, and a
# JavaScript reimplementation of the allocation algorithm. Neither actually
# EXECUTES the SQL. That gap let a real CTE-scoping bug in
# allocate_ticket_platform_fees ship past 75 passing text/JS tests -- a
# "ranked" CTE was referenced in a second statement after its own CTE's
# scope had already ended, which only a real Postgres engine can catch.
# This script runs the actual migration SQL against a real, local, throwaway
# Postgres database to close that gap for future financial migrations.
#
# Prerequisites: a local PostgreSQL server reachable via `psql` as a
# superuser (this repo's dev container ships PostgreSQL 16 via
# pg_ctlcluster; if yours doesn't, install one locally -- no Docker or
# hosted service required, and none of this touches the real Supabase
# project).
#
# Usage:
#   scripts/local-pg-test/run-rollback-verification.sh [migration_file]
#
# Defaults to supabase/migrations/_superseded/0192_platform_fee_accounting_foundation.sql
# if no argument is given. Exits non-zero on any unexpected SQL error or
# failed assertion.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATION_FILE="${1:-$REPO_ROOT/supabase/migrations/_superseded/0192_platform_fee_accounting_foundation.sql}"
DB_NAME="vents_local_pg_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

echo "== Using migration: $MIGRATION_FILE =="

echo "== (Re)creating throwaway database '$DB_NAME' =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"

echo "== Applying minimal schema =="
"${PSQL[@]}" -f "$SCRIPT_DIR/schema.sql"

echo "== Applying migration under test =="
"${PSQL[@]}" -f "$MIGRATION_FILE"

echo "== Seeding a conflicting paystack_reference to force a mid-function RAISE =="
"${PSQL[@]}" <<'SQL'
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'buyer@test.com'),
  ('00000000-0000-0000-0000-000000000002', 'organizer@test.com');
INSERT INTO public.events (id, organizer_id, title, event_date, status)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'Test Event', now() + interval '10 days', 'live');
INSERT INTO public.tickets (id, event_id, user_id, payer_id, quantity, payment_ref, payment_status, amount, ticket_type)
VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 1, 'PAYREF-ROLLBACK-1', 'pending', 5000, 'VIP'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 1, 'PAYREF-ROLLBACK-1', 'pending', 3000, 'Regular'),
  ('20000000-0000-0000-0000-000000000099', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 1, 'OTHER-REF', 'paid', 1000, 'Decoy');
INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, ticket_sale_id, metadata)
VALUES ('00000000-0000-0000-0000-000000000002', 'credit', 100000, '20000000-0000-0000-0000-000000000099',
  jsonb_build_object('paystack_reference', 'PAYREF-ROLLBACK-1', 'buyer_fee_kobo', 999999));
SQL

echo "== Call 1: expect RAISE EXCEPTION (reference already owned by a different ticket_sale_id) =="
if "${PSQL[@]}" -c "SELECT public.confirm_ticket_payment('PAYREF-ROLLBACK-1', 840000);" 2>/tmp/call1.err; then
  echo "FAIL: expected an exception, call succeeded" >&2
  exit 1
fi
grep -q "already recorded under a different ticket_sale_id" /tmp/call1.err || { echo "FAIL: unexpected error text"; cat /tmp/call1.err; exit 1; }

echo "== Asserting full rollback: ticket status, no partial txn/wallet writes =="
STILL_PENDING=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM public.tickets WHERE payment_ref='PAYREF-ROLLBACK-1' AND payment_status='pending';")
[ "$STILL_PENDING" = "2" ] || { echo "FAIL: expected both tickets still pending, got $STILL_PENDING"; exit 1; }
TXN_COUNT=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM public.organizer_transactions WHERE metadata->>'paystack_reference'='PAYREF-ROLLBACK-1';")
[ "$TXN_COUNT" = "1" ] || { echo "FAIL: expected only the pre-seeded decoy txn row, got $TXN_COUNT"; exit 1; }
echo "PASS: rollback left no partial writes"

echo "== Removing the conflict, retrying =="
"${PSQL[@]}" -c "DELETE FROM public.organizer_transactions WHERE ticket_sale_id='20000000-0000-0000-0000-000000000099';"
RESULT=$("${PSQL[@]}" -tA -c "SELECT public.confirm_ticket_payment('PAYREF-ROLLBACK-1', 840000);")
[ "$RESULT" = "confirmed" ] || { echo "FAIL: expected 'confirmed', got '$RESULT'"; exit 1; }

echo "== Asserting exactly-once allocation summing to the authoritative fee =="
BUYER_FEE=$("${PSQL[@]}" -tA -c "SELECT metadata->>'buyer_fee_kobo' FROM public.organizer_transactions WHERE metadata->>'paystack_reference'='PAYREF-ROLLBACK-1';")
ALLOCATED_SUM=$("${PSQL[@]}" -tA -c "SELECT sum(platform_fee_kobo) FROM public.tickets WHERE payment_ref='PAYREF-ROLLBACK-1';")
[ "$BUYER_FEE" = "$ALLOCATED_SUM" ] || { echo "FAIL: buyer_fee_kobo=$BUYER_FEE != allocated sum=$ALLOCATED_SUM"; exit 1; }
echo "PASS: allocated sum ($ALLOCATED_SUM) matches authoritative fee exactly"

echo "== Duplicate delivery: retry again, expect clean no-op =="
RESULT2=$("${PSQL[@]}" -tA -c "SELECT public.confirm_ticket_payment('PAYREF-ROLLBACK-1', 840000);")
[ "$RESULT2" = "already_paid" ] || { echo "FAIL: expected 'already_paid' on duplicate delivery, got '$RESULT2'"; exit 1; }
TXN_COUNT2=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM public.organizer_transactions WHERE metadata->>'paystack_reference'='PAYREF-ROLLBACK-1';")
[ "$TXN_COUNT2" = "1" ] || { echo "FAIL: duplicate delivery created an extra txn row ($TXN_COUNT2)"; exit 1; }
echo "PASS: duplicate delivery was a clean no-op"

echo "== Direct re-allocation idempotency =="
RESULT3=$("${PSQL[@]}" -tA -c "SELECT public.allocate_ticket_platform_fees('PAYREF-ROLLBACK-1');")
[ "$RESULT3" = "already_allocated" ] || { echo "FAIL: expected 'already_allocated', got '$RESULT3'"; exit 1; }
echo "PASS: allocator is idempotent on retry"

echo "== Cleanup =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"

echo
echo "ALL CHECKS PASSED"
