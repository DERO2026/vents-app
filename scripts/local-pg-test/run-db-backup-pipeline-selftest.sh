#!/usr/bin/env bash
# Self-test for the daily backup pipeline (.github/workflows/db-backup.yml),
# entirely local: a throwaway source database stands in for production, and
# the same scripts the workflow runs -- db-backup-key.sh, db-backup-dump.sh,
# db-backup-validate.sh, verify-backup-restore.sh -- are run against it,
# including the failure paths. No hosted database is contacted.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OPS="$REPO_ROOT/scripts/ops"
MIG="$REPO_ROOT/supabase/migrations"
SRC_DB="vents_local_pg_dbbackup_src"
ROLE="vents_backup_selftest"
. "$OPS/_local_pg.sh" || { echo "REFUSING TO RUN: scripts/ops/_local_pg.sh missing" >&2; exit 2; }
vents_require_local_server
pg() { pgtool psql -X -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }

W="$(mktemp -d)"; chmod 700 "$W"
cleanup() {
  rm -rf "$W"
  pg -d postgres -q -c "DROP DATABASE IF EXISTS $SRC_DB;" -c "DROP ROLE IF EXISTS $ROLE;" >/dev/null 2>&1 || true
}
trap cleanup EXIT
PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
# The workflow never exports these to the validation step; neither do we.
unset DATABASE_URL BACKUP_DB_URL BACKUP_ENCRYPTION_PASSPHRASE

# --- a source database shaped like production (19 pre-apply functions) -----
pg -d postgres -q -c "DROP DATABASE IF EXISTS $SRC_DB;" -c "CREATE DATABASE $SRC_DB;" >/dev/null
pg -d "$SRC_DB" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null 2>&1
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  pg -d "$SRC_DB" -q -f "$MIG/$m.sql" >/dev/null 2>&1
done
for f in schema-representative-rewards.sql schema-live-payout-extras.sql schema-earnings-policies.sql live-money-functions.sql; do
  pg -d "$SRC_DB" -q -f "$SCRIPT_DIR/$f" >/dev/null 2>&1
done
pg -d "$SRC_DB" -q -1 -c "SET check_function_bodies = off; SET vents.rollback_confirm = 'restore-pre-0201-0203';" \
  -f - <"$REPO_ROOT/supabase/rollback/pre_0201_0203_functions.sql" >/dev/null
# Rows with awkward text (newline, tab, backslash, quotes) to prove row parity
# survives COPY escaping; one marker string to prove nothing leaks into logs.
pg -d "$SRC_DB" -q -c "CREATE TABLE public.selftest_rows (id int PRIMARY KEY, note text);
  INSERT INTO public.selftest_rows SELECT g, 'row ' || g || E'\n\ttab \\\\ back ''q'' \"dq\"' FROM generate_series(1, 500) g;
  INSERT INTO public.selftest_rows VALUES (0, 'SELFTEST-SECRET-ROW-MARKER');" >/dev/null
PW="$(openssl rand -hex 16)"
pg -d postgres -q -c "DROP ROLE IF EXISTS $ROLE;" -c "CREATE ROLE $ROLE LOGIN SUPERUSER PASSWORD '$PW';" >/dev/null
URL="postgresql://$ROLE:$PW@127.0.0.1:5432/$SRC_DB?sslmode=disable"
dump() { env -u DATABASE_URL BACKUP_SELFTEST=1 BACKUP_DB_URL="$1" bash "$OPS/db-backup-dump.sh" "$2" "$3" 2>&1; }

# --- 1. source URL guard ---------------------------------------------------
OUT=$(env BACKUP_DB_URL="$URL" bash "$OPS/db-backup-dump.sh" "$W/x.gpg" "$OPS/db-backup-key.sh" 2>&1); RC=$?
if [ $RC -ne 0 ] && [[ "$OUT" == *"not the VENTS Supabase session pooler URI"* ]] && [ ! -e "$W/x.gpg" ]; then
  pass "without the self-test flag, a non-production URL is refused before any connection"
else fail "non-production URL: rc=$RC"; fi
for bad in "postgresql://postgres.slrtjxtzhowhwhebjprv:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres" \
           "postgresql://postgres:pw@db.slrtjxtzhowhwhebjprv.supabase.co:5432/postgres" \
           "postgresql://postgres.slrtjxtzhowhwhebjprv:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=disable" \
           "postgresql://postgres.otherproject:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"; do
  OUT=$(env BACKUP_DB_URL="$bad" bash "$OPS/db-backup-dump.sh" "$W/x.gpg" "$OPS/db-backup-key.sh" 2>&1); RC=$?
  if [ $RC -eq 0 ] || [[ "$OUT" != *"not the VENTS Supabase session pooler URI"* ]]; then fail "accepted a wrong URL shape (rc=$RC)"; fi
done
[ "$FAILS" -eq 0 ] && pass "transaction pooler, direct host, sslmode=disable and another project are all refused"
OUT=$(env BACKUP_DB_URL="" bash "$OPS/db-backup-dump.sh" "$W/x.gpg" "$OPS/db-backup-key.sh" 2>&1); RC=$?
if [ $RC -ne 0 ] && [[ "$OUT" == *"secret is empty"* ]]; then pass "an empty DATABASE_URL fails loudly"; else fail "empty URL: rc=$RC"; fi

# --- 2. passphrase ---------------------------------------------------------
OUT=$(env BACKUP_DB_URL="$URL" bash "$OPS/db-backup-key.sh" "$W/key" "$W/mode" 2>&1); RC=$?
if [ $RC -eq 0 ] && [ "$(cat "$W/mode")" = "derived-from-DATABASE_URL" ] && [ "$(wc -c <"$W/key")" -eq 64 ] \
   && [ "$(cat "$W/key")" = "$(printf '%s' "$URL" | openssl dgst -sha256 -hmac vents-db-backup-v1 -r | cut -d' ' -f1)" ] \
   && [[ "$OUT" != *"$(cat "$W/key")"* ]] && [ "$(stat -c %a "$W/key")" = "600" ]; then
  pass "without a passphrase secret the key is HMAC(URL), reproducible by hand, mode 600, never printed"
else fail "derived key: rc=$RC $OUT"; fi
OUT=$(env BACKUP_DB_URL="$URL" BACKUP_ENCRYPTION_PASSPHRASE="a-dedicated-passphrase-of-40-characters!" bash "$OPS/db-backup-key.sh" "$W/key2" "$W/mode2" 2>&1); RC=$?
if [ $RC -eq 0 ] && [ "$(cat "$W/mode2")" = "passphrase-secret" ] && [[ "$OUT" != *"dedicated-passphrase"* ]]; then
  pass "a BACKUP_ENCRYPTION_PASSPHRASE secret takes precedence and is never printed"
else fail "passphrase secret: rc=$RC"; fi
OUT=$(env BACKUP_ENCRYPTION_PASSPHRASE="short" bash "$OPS/db-backup-key.sh" "$W/key3" "$W/mode3" 2>&1); RC=$?
if [ $RC -ne 0 ]; then pass "a passphrase shorter than 24 characters is refused"; else fail "short passphrase accepted"; fi

# --- 3. good backup end to end -------------------------------------------
DOUT=$(dump "$URL" "$W/backup.dump.gpg" "$W/key"); RC=$?
if [ $RC -eq 0 ] && [ -s "$W/backup.dump.gpg" ] && [ ! -e "$W/backup.dump.gpg.partial" ]; then pass "the dump step succeeds and leaves one encrypted file"
else fail "dump: rc=$RC $DOUT"; fi
if [ "$(head -c 5 "$W/backup.dump.gpg")" != "PGDMP" ] && ! grep -aq 'SELFTEST-SECRET-ROW-MARKER' "$W/backup.dump.gpg" \
   && ! grep -aq 'selftest_rows' "$W/backup.dump.gpg"; then
  pass "the stored file is ciphertext: no archive header, no table name, no row text"
else fail "the backup file is not encrypted"; fi
VOUT=$(FUNCTION_CHECK=enforce bash "$OPS/db-backup-validate.sh" "$W/backup.dump.gpg" "$W/key" "$W/report" 2>&1); RC=$?
if [ $RC -eq 0 ] && [[ "$VOUT" == *"BACKUP VERIFIED"* ]] && echo "$VOUT" | grep -qE '^Public tables restored: ([0-9]+)/\1$' \
   && echo "$VOUT" | grep -qE '^Public table rows matching the backup: ([0-9]+)/\1$' && [[ "$VOUT" == *"Functions matching: 19/19"* ]]; then
  pass "the backup decrypts and restores every public table with every row; 19/19 fingerprints"
else fail "validate good: rc=$RC $VOUT"; fi
ALL="$DOUT $VOUT"
if [[ "$ALL" != *"$PW"* ]] && [[ "$ALL" != *"$URL"* ]] && [[ "$ALL" != *"SELFTEST-SECRET-ROW-MARKER"* ]] \
   && [[ "$ALL" != *"$(cat "$W/key")"* ]] && [[ "$ALL" != *"wallet sum"* ]]; then
  pass "the log carries no password, URL, key, row data or money totals"
else fail "something sensitive reached the log"; fi
if [ -z "$(find "$W" /tmp -maxdepth 3 -type f -newer "$W/key" -exec sh -c 'head -c 5 "$1" 2>/dev/null | grep -q PGDMP && echo "$1"' _ {} \; 2>/dev/null)" ]; then
  pass "no decrypted archive is left on disk after validation"
else fail "a plain archive was left behind"; fi

# --- 4. failure paths -----------------------------------------------------
printf 'a-wrong-key-that-is-long-enough-000000' >"$W/wrongkey"
VOUT=$(bash "$OPS/db-backup-validate.sh" "$W/backup.dump.gpg" "$W/wrongkey" "$W/r2" 2>&1); RC=$?
if [ $RC -ne 0 ] && [[ "$VOUT" == *"decryption failed"* ]]; then pass "a wrong key fails validation loudly"; else fail "wrong key: rc=$RC"; fi
head -c $(( $(wc -c <"$W/backup.dump.gpg") / 2 )) "$W/backup.dump.gpg" >"$W/truncated.gpg"
VOUT=$(bash "$OPS/db-backup-validate.sh" "$W/truncated.gpg" "$W/key" "$W/r3" 2>&1); RC=$?
if [ $RC -ne 0 ] && [[ "$VOUT" == *"FAILED"* ]]; then pass "a truncated backup fails validation"; else fail "truncated: rc=$RC"; fi
cp "$W/backup.dump.gpg" "$W/flipped.gpg"; printf '\x00\x00\x00\x00' | dd of="$W/flipped.gpg" bs=1 seek=$(( $(wc -c <"$W/flipped.gpg") / 2 )) conv=notrunc 2>/dev/null
VOUT=$(bash "$OPS/db-backup-validate.sh" "$W/flipped.gpg" "$W/key" "$W/r4" 2>&1); RC=$?
if [ $RC -ne 0 ] && [[ "$VOUT" == *"FAILED"* ]]; then pass "a tampered backup fails the integrity check"; else fail "tampered: rc=$RC"; fi
BADURL="postgresql://$ROLE:$PW@127.0.0.1:5432/vents_local_pg_does_not_exist?sslmode=disable"
DOUT=$(dump "$BADURL" "$W/nodb.gpg" "$W/key"); RC=$?
if [ $RC -ne 0 ] && [[ "$DOUT" == *"BACKUP FAILED"* ]] && [ ! -e "$W/nodb.gpg" ] && [ ! -e "$W/nodb.gpg.partial" ] && [[ "$DOUT" != *"$PW"* ]]; then
  pass "a failing pg_dump fails the step, leaves no file and prints no password"
else fail "pg_dump failure: rc=$RC $DOUT"; fi
VOUT=$(DATABASE_URL="$URL" bash "$OPS/db-backup-validate.sh" "$W/backup.dump.gpg" "$W/key" "$W/r5" 2>&1); RC=$?
if [ $RC -eq 2 ] && [[ "$VOUT" == *"REFUSING TO RUN"* ]]; then pass "validation refuses to run with a database URL in its environment"; else fail "validate with URL: rc=$RC"; fi

# --- 5. row parity and the function-check modes ---------------------------
pgtool pg_dump -h "$SOCKET_DIR" -p 5432 -d "$SRC_DB" >"$W/plain.sql"
chmod 644 "$W/plain.sql"; chmod 755 "$W"
# Make the COPY into selftest_rows fail on restore: the table restores empty.
sed -i '/^COPY public.selftest_rows /i ALTER TABLE public.selftest_rows ADD CONSTRAINT selftest_reject CHECK (id < 0);' "$W/plain.sql"
OUT=$(bash "$OPS/verify-backup-restore.sh" "$W/plain.sql" 2>&1); RC=$?
if [ $RC -ne 0 ] && [[ "$OUT" == *"ROW MISMATCH  selftest_rows"* ]] && [[ "$OUT" != *"NOT RESTORED"* ]]; then
  pass "a table that restores without its rows fails the drill (row parity), and is named"
else fail "row parity: rc=$RC $(echo "$OUT" | grep -E 'rows matching|ROW MISMATCH|NOT RESTORED')"; fi
pg -d "$SRC_DB" -q -c "CREATE OR REPLACE FUNCTION public.get_event_analytics(p_event_id uuid) RETURNS jsonb LANGUAGE sql AS \$\$ SELECT '{}'::jsonb \$\$;" >/dev/null
dump "$URL" "$W/drifted.gpg" "$W/key" >/dev/null
VOUT=$(bash "$OPS/db-backup-validate.sh" "$W/drifted.gpg" "$W/key" "$W/r6" 2>&1); RC=$?
if [ $RC -eq 0 ] && [[ "$VOUT" == *"Functions matching: 18/19 (check: report)"* ]] && [[ "$VOUT" == *"BACKUP VERIFIED"* ]]; then
  pass "daily mode (report) still verifies once functions change after a release, and shows 18/19"
else fail "report mode: rc=$RC $VOUT"; fi
VOUT=$(FUNCTION_CHECK=enforce bash "$OPS/db-backup-validate.sh" "$W/drifted.gpg" "$W/key" "$W/r7" 2>&1); RC=$?
if [ $RC -ne 0 ] && [[ "$VOUT" == *"not 19/19"* ]]; then pass "O4 mode (enforce) fails on a drifted function"; else fail "enforce mode: rc=$RC"; fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL $PASSES DB BACKUP PIPELINE SELF-TEST CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED ($PASSES passed)"; exit 1; fi
