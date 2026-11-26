#!/usr/bin/env bash
# Mutation test for migration 0220 (OEL-01). Runs
# run-ticket-integrity-verification.sh twice, from the repository, on the
# local throwaway database it manages:
#
#   1. WITH 0220 applied: every check must pass (exit 0).
#   2. WITHOUT 0220 (WITHOUT_0220=1): the same behavioural checks run on the
#      unpatched functions. The run must fail (exit 1), the reproduction of the
#      original hole must pass, and the set of failed checks must be EXACTLY the
#      checks tagged "[0220]" -- no fewer (each one detects the missing fix) and
#      no more (every other check covers behaviour that does not depend on 0220).
#
# Same safety rules as the harness: local Unix-socket PostgreSQL only; no
# network, no hosted database, no .env files.
#
# Usage: scripts/local-pg-test/run-ticket-integrity-mutation-test.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$SCRIPT_DIR/run-ticket-integrity-verification.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
names() { sed -E 's/^(PASS|FAIL): //; s/ \(expected .*$//; s/ \(wrong error\)$//'; }
problems=0
bad() { echo "MUTATION TEST PROBLEM: $1" >&2; problems=$((problems + 1)); }

echo "== Run 1: with migration 0220 =="
if bash "$HARNESS" >"$TMP/with.log" 2>&1; then rc_with=0; else rc_with=$?; fi
tail -n1 "$TMP/with.log"
[ "$rc_with" -eq 0 ] || { bad "the run WITH 0220 failed (exit $rc_with)"; grep '^FAIL' "$TMP/with.log" >&2 || true; }
grep -q '^== WITHOUT_0220' "$TMP/with.log" && bad "the run WITH 0220 skipped the migration"
grep -E '^PASS: \[0220\] ' "$TMP/with.log" | names | sort >"$TMP/tagged"
echo "checks tagged [0220]: $(wc -l <"$TMP/tagged" | tr -d ' ')"
[ -s "$TMP/tagged" ] || bad "no [0220] checks passed in the run WITH 0220"

echo "== Run 2: without migration 0220 (WITHOUT_0220=1) =="
if WITHOUT_0220=1 bash "$HARNESS" >"$TMP/without.log" 2>&1; then rc_without=0; else rc_without=$?; fi
tail -n1 "$TMP/without.log"
[ "$rc_without" -eq 1 ] || bad "the run WITHOUT 0220 should exit 1 (failed checks), got $rc_without"
grep -q '^== WITHOUT_0220=1: 0220 is NOT applied' "$TMP/without.log" || bad "the run WITHOUT 0220 did not run in that mode"
grep -q '^== Applying 0220' "$TMP/without.log" && bad "the run WITHOUT 0220 applied 0220"
for repro in "a direct purchase_ticket call on a paid tier creates a ticket without any payment" \
             "... and the pass checks in at the door (QR scan)" "... and an unpaid ticket also passes manual check-in"; do
  grep -qxF "PASS: $repro" "$TMP/without.log" || bad "the reproduction did not show the hole: $repro"
done
grep -E '^FAIL: ' "$TMP/without.log" | names | sort >"$TMP/failed"

echo "== Comparing =="
comm -23 "$TMP/tagged" "$TMP/failed" >"$TMP/undetected"
comm -13 "$TMP/tagged" "$TMP/failed" >"$TMP/unexpected"
if [ -s "$TMP/undetected" ]; then bad "[0220] checks that still PASS without 0220 (they do not detect the missing fix):"; sed 's/^/  /' "$TMP/undetected" >&2; fi
if [ -s "$TMP/unexpected" ]; then bad "untagged checks that FAIL without 0220 (they depend on 0220 but are not tagged):"; sed 's/^/  /' "$TMP/unexpected" >&2; fi
echo "failed without 0220: $(wc -l <"$TMP/failed" | tr -d ' '); tagged [0220]: $(wc -l <"$TMP/tagged" | tr -d ' ')"

echo
if [ "$problems" -eq 0 ]; then
  echo "MUTATION TEST PASSED: with 0220 all checks pass; without it exactly the $(wc -l <"$TMP/tagged" | tr -d ' ') [0220] checks fail and the hole is reproduced"
else
  echo "MUTATION TEST FAILED ($problems problem(s))"; exit 1
fi
