#!/usr/bin/env bash
# Mutation test for 0231 (finding N3): each safeguard is removed in turn and
# the verification suite must FAIL on the named check.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$SCRIPT_DIR/run-ticket-tier-identity-safe-verification.sh"
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
declare -A EXPECT=(
  [no_ambiguity_refusal]="older-app delete+add should be refused"
  [no_name_ownership]="name takeover should be refused"
  [no_duplicate_tolerance]="legacy duplicate edit"
  [match_keyless_by_key]="the older app's reorder + price edit keeps the renamed tier's key and earlier names"
)
BAD=0
bash "$SUITE" >"$LOG" 2>&1 || { echo "FAIL: the unmutated suite must pass first"; tail -5 "$LOG"; exit 1; }
echo "PASS: unmutated 0231 passes the suite"
for m in "${!EXPECT[@]}"; do
  if MUTATE="$m" bash "$SUITE" >"$LOG" 2>&1; then echo "FAIL: mutation '$m' was NOT caught"; BAD=$((BAD+1))
  elif grep -qF "FAIL: [with 0231] ${EXPECT[$m]}" "$LOG"; then echo "PASS: mutation '$m' caught by: ${EXPECT[$m]}"
  else echo "FAIL: mutation '$m' failed, but not on the expected check"; grep "^FAIL" "$LOG" | head -3; BAD=$((BAD+1)); fi
done
if [ "$BAD" -eq 0 ]; then echo "MUTATION TEST PASSED: all ${#EXPECT[@]} weakened versions of 0231 are caught"; exit 0; fi
echo "MUTATION TEST FAILED: $BAD mutation(s) not caught" >&2; exit 1
