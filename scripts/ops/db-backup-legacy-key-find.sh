#!/usr/bin/env bash
# Recovers the encryption key of a LEGACY backup artifact -- one whose
# manifest says key_source=derived-from-DATABASE_URL (runs #20 and #22,
# 10-11 Nov 2026) -- on YOUR OWN machine, without the secret ever appearing
# on screen, in a command line, in shell history or in a file.
#
# Why a helper: those runs encrypted with
#   key = hex(HMAC-SHA256(key="vents-db-backup-v1", message=<raw secret>))
# where <raw secret> is the database connection string EXACTLY as it was
# stored in GitHub, byte for byte. Small differences give a different key:
# postgres:// vs postgresql://, a "?sslmode=require" suffix, a URL-encoded
# password, or a newline pasted at the end. Run #22's log shows the string
# was the DIRECT form (postgres@db.slrtjxtzhowhwhebjprv.supabase.co:5432).
#
# This script asks once, at a hidden prompt, for either the database
# PASSWORD or the full connection string you stored. It builds every
# plausible stored form in memory, derives each candidate key, and asks gpg
# to decrypt the artifact with it (gpg's integrity check rejects every wrong
# key). Only the key that decrypts is kept, in <key-out> (mode 600). It
# prints which FORM matched (for example "scheme=postgresql, sslmode=none,
# password=url-encoded, ending=newline"), never the value. Nothing is
# decrypted to disk here: use db-backup-decrypt.sh with the key afterwards.
#
# It never connects to any database and refuses to run on a GitHub runner.
#
# Usage: db-backup-legacy-key-find.sh <unzipped-artifact-dir> <key-out>
# Needs: bash, python3, gpg.
set -euo pipefail
DIR="${1:?usage: $0 <unzipped-artifact-dir> <key-out>}"
OUT="${2:?usage: $0 <unzipped-artifact-dir> <key-out>}"
[ "${GITHUB_ACTIONS:-}" != "true" ] || { echo "STOP: this is for your own machine, never a workflow" >&2; exit 1; }
for t in python3 gpg; do command -v "$t" >/dev/null || { echo "STOP: $t is not installed" >&2; exit 1; }; done
M="$DIR/manifest.txt"
[ -f "$M" ] || { echo "STOP: $M not found (unzip the whole artifact into an empty folder)" >&2; exit 1; }
field() { sed -n "s/^$1=//p" "$M" | head -1; }
FILE="$(field file)"; SUM="$(field sha256)"; SRC="$(field key_source)"
[ "$SRC" = "derived-from-DATABASE_URL" ] || { echo "STOP: this artifact's key_source is '${SRC:-none}', not derived-from-DATABASE_URL; use the passphrase instead" >&2; exit 1; }
[ -n "$FILE" ] && [ -f "$DIR/$FILE" ] || { echo "STOP: the manifest's file= is missing from $DIR" >&2; exit 1; }
[ -e "$OUT" ] && { echo "STOP: $OUT already exists; choose a new file name" >&2; exit 1; }

GOT="$(python3 -I -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$DIR/$FILE")"
[ "$GOT" = "$SUM" ] || { echo "STOP: the backup file's sha256 differs from the manifest's: damaged or not the file that was backed up" >&2; exit 1; }
echo "ok: $FILE is intact (sha256 matches the manifest)"

umask 077
WORK="$(mktemp -d)"; GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
cleanup() {
  find "$WORK" -type f -exec sh -c 'for f; do (shred -u "$f" 2>/dev/null || rm -P "$f" 2>/dev/null || rm -f "$f"); done' sh {} + 2>/dev/null || true
  rm -rf "$WORK" "$GNUPGHOME"
}
trap cleanup EXIT

# Read the secret at a hidden prompt (from the terminal when there is one).
SECRET=""
if [ -n "${VENTS_KEYFIND_STDIN:-}" ]; then
  IFS= read -r SECRET || true   # automated tests only
else
  IFS= read -rs -p "Database password, or the full connection string you stored (hidden): " SECRET </dev/tty || true; echo >&2
fi
[ -n "$SECRET" ] || { echo "STOP: nothing was entered" >&2; exit 1; }

# Candidate keys, built in python from stdin (not argv or the environment).
cat >"$WORK/gen.py" <<'PY'
import hashlib, hmac, os, sys, urllib.parse
work = sys.argv[1]
s = sys.stdin.read()
REF = "slrtjxtzhowhwhebjprv"
forms = []  # (description, raw stored string without its ending)
def add(desc, raw):
    forms.append((desc, raw))
if s.startswith("postgres://") or s.startswith("postgresql://"):
    scheme, rest = s.split("://", 1)
    base, q, query = rest.partition("?")
    for sch in dict.fromkeys([scheme, "postgresql" if scheme == "postgres" else "postgres"]):
        for ssl, label in dict.fromkeys([("?" + query if q else "", "as entered" if q else "none"), ("", "none"), ("?sslmode=require", "require")]):
            add(f"input=full string, scheme={sch}, sslmode={label}", f"{sch}://{base}{ssl}")
else:
    pw = s
    encs = [("raw", pw)]
    enc = urllib.parse.quote(pw, safe="")
    if enc != pw: encs.append(("url-encoded", enc))
    for sch in ("postgresql", "postgres"):
        for ssl, label in (("", "none"), ("?sslmode=require", "require")):
            for elabel, p in encs:
                add(f"input=password, form=direct, scheme={sch}, sslmode={label}, password={elabel}",
                    f"{sch}://postgres:{p}@db.{REF}.supabase.co:5432/postgres{ssl}")
seen = set(); n = 0
with open(os.path.join(work, "index"), "w") as idx:
    for desc, raw in forms:
        for end, elabel in (("", "none"), ("\n", "newline"), ("\r\n", "CRLF"), (" ", "space")):
            msg = raw + end
            if msg in seen: continue
            seen.add(msg); n += 1
            key = hmac.new(b"vents-db-backup-v1", msg.encode(), hashlib.sha256).hexdigest()
            path = os.path.join(work, f"k{n:03d}")
            with open(path, "w") as f: f.write(key)
            os.chmod(path, 0o600)
            idx.write(f"k{n:03d}\t{desc}, ending={elabel}\n")
print(f"{n} candidate forms prepared", file=sys.stderr)
PY
printf '%s' "$SECRET" | python3 -I "$WORK/gen.py" "$WORK"
unset SECRET

FOUND=""
while IFS=$'\t' read -r k desc; do
  if gpg --batch --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-file "$WORK/$k" \
         --yes -o /dev/null -d "$DIR/$FILE" 2>/dev/null; then
    FOUND="$k"; FOUND_DESC="$desc"; break
  fi
done <"$WORK/index"

if [ -z "$FOUND" ]; then
  echo "NOT FOUND: no stored form of what you entered decrypts this backup." >&2
  echo "  Check the password (or paste the exact connection string you put in GitHub), then try again." >&2
  echo "  Nothing was written." >&2
  exit 1
fi
cp "$WORK/$FOUND" "$OUT"; chmod 600 "$OUT"
echo "FOUND: the key that decrypts $FILE is saved to $OUT (mode 600)"
echo "  matched: $FOUND_DESC"
echo "  next:    bash scripts/ops/db-backup-decrypt.sh $DIR $OUT <backup.dump>"
