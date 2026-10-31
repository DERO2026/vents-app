#!/usr/bin/env bash
# Real overlapping-connection concurrency test for confirm_ticket_payment /
# allocate_ticket_platform_fees (migration 0192).
#
# Why this exists: run-rollback-verification.sh proves correctness under
# sequential retries (duplicate delivery, idempotent re-allocation), but
# never proves what happens when two Postgres backends are genuinely
# in-flight at the same time against the same payment_ref -- e.g. two
# near-simultaneous Paystack webhook deliveries racing each other. Row-level
# `FOR UPDATE` locking is what's actually relied on for that safety; this
# script forces real lock contention between two separate connections and
# checks the outcome, instead of reasoning about Postgres's documented
# locking semantics from the SQL text.
#
# Design: connection A opens an explicit transaction, takes the row lock
# `confirm_ticket_payment` itself takes (`SELECT ... FOR UPDATE`), and holds
# it open for a fixed delay. Connection B calls the real
# `confirm_ticket_payment(...)` function concurrently, while A still holds
# the lock -- B's internal `FOR UPDATE` must block until A releases it. This
# is genuine overlap: B's query is live and waiting on the server while A's
# transaction is still open, not two sequentially-awaited calls.
#
# Two scenarios are run, both with a fixed, deterministic delay so the
# interleaving (who blocks on whom) is not left to chance:
#   1. A holds the lock and ROLLS BACK without writing anything (simulating
#      an aborted/slow first delivery) -- B must then proceed and succeed
#      exactly once.
#   2. A holds the lock long enough to actually run confirm_ticket_payment
#      to completion and COMMIT -- B, still blocked the whole time, must
#      then see the ticket already paid and no-op, with no duplicate
#      organizer_transactions row, no double wallet credit, and no
#      re-allocation.
#
# Prerequisites: same as run-rollback-verification.sh (local PostgreSQL
# reachable via `sudo -u postgres psql`), plus Node with the `pg` package
# already present in this repo's node_modules.
#
# Usage:
#   scripts/local-pg-test/run-concurrency-verification.sh [migration_file]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATION_FILE="${1:-$REPO_ROOT/supabase/migrations/_superseded/0192_platform_fee_accounting_foundation.sql}"
DB_NAME="vents_local_pg_concurrency_test"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME")

echo "== Using migration: $MIGRATION_FILE =="

echo "== (Re)creating throwaway database '$DB_NAME' =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME;"

echo "== Applying minimal schema =="
"${PSQL[@]}" -f "$SCRIPT_DIR/schema.sql"

echo "== Applying migration under test =="
"${PSQL[@]}" -f "$MIGRATION_FILE"

echo "== Granting the local 'postgres' superuser a predictable TCP route for the Node client =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "ALTER ROLE postgres PASSWORD 'localtestpass';" >/dev/null

echo "== Running real overlapping-connection scenarios via Node (pg) =="
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=localtestpass PGDATABASE="$DB_NAME" \
  node "$SCRIPT_DIR/concurrency-check.cjs"

echo "== Cleanup =="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;"

echo
echo "ALL CONCURRENCY CHECKS PASSED"
