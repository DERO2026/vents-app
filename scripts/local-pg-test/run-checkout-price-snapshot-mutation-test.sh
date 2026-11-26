#!/usr/bin/env bash
# Mutation test for 0230 (finding N1): each safeguard is removed in turn and
# the verification suite must FAIL with the named check. Proves the suite
# would catch a regression in each guard, not just pass on the real file.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$SCRIPT_DIR/run-checkout-price-snapshot-verification.sh"
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
declare -A EXPECT=(
  [finalize_ignores_snapshot]="the paid order is confirmed at the agreed amount"
  [no_stale_guard]="wallet payment of a stale quote should be refused"
  [stale_reuse]="a retry after a price change gets a fresh order at the new total"
  [no_tier_key_check]="tier swap should be refused"
  [mutable_snapshot]="the agreed total cannot be edited afterwards"
)
BAD=0
bash "$SUITE" >"$LOG" 2>&1 || { echo "FAIL: the unmutated suite must pass first"; tail -5 "$LOG"; exit 1; }
echo "PASS: unmutated 0230 passes the suite"
for m in "${!EXPECT[@]}"; do
  if MUTATE="$m" bash "$SUITE" >"$LOG" 2>&1; then
    echo "FAIL: mutation '$m' was NOT caught (suite passed)"; BAD=$((BAD+1))
  elif grep -q "FAIL: \[with 0230\] ${EXPECT[$m]}" "$LOG"; then
    echo "PASS: mutation '$m' caught by: ${EXPECT[$m]}"
  else
    echo "FAIL: mutation '$m' failed the suite, but not on the expected check"; grep "^FAIL" "$LOG" | head -3; BAD=$((BAD+1))
  fi
done
if [ "$BAD" -eq 0 ]; then echo "MUTATION TEST PASSED: all ${#EXPECT[@]} weakened versions of 0230 are caught"; exit 0; fi
echo "MUTATION TEST FAILED: $BAD mutation(s) not caught" >&2; exit 1
