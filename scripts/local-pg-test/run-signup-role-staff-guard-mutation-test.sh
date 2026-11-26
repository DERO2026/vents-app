#!/usr/bin/env bash
# Mutation test for 0232 (finding N2): weaken the staff check and the
# verification suite must FAIL on the named check.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$SCRIPT_DIR/run-signup-role-staff-guard-verification.sh"
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
declare -A EXPECT=(
  [admin_only]="sub-admin self-selecting Organizer should be refused"
  [role_only]="root (role 'user') self-selecting Organizer should be refused"
)
BAD=0
bash "$SUITE" >"$LOG" 2>&1 || { echo "FAIL: the unmutated suite must pass first"; tail -5 "$LOG"; exit 1; }
echo "PASS: unmutated 0232 passes the suite"
for m in "${!EXPECT[@]}"; do
  if MUTATE="$m" bash "$SUITE" >"$LOG" 2>&1; then echo "FAIL: mutation '$m' was NOT caught"; BAD=$((BAD+1))
  elif grep -qF "FAIL: [with 0232] ${EXPECT[$m]}" "$LOG"; then echo "PASS: mutation '$m' caught by: ${EXPECT[$m]}"
  else echo "FAIL: mutation '$m' failed, but not on the expected check"; grep "^FAIL" "$LOG" | head -3; BAD=$((BAD+1)); fi
done
if [ "$BAD" -eq 0 ]; then echo "MUTATION TEST PASSED: all ${#EXPECT[@]} weakened versions of 0232 are caught"; exit 0; fi
echo "MUTATION TEST FAILED: $BAD mutation(s) not caught" >&2; exit 1
