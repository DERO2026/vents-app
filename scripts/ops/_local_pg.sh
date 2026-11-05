# Shared local-PostgreSQL connection settings for the O4 scripts
# (o4-preflight.sh, verify-backup-restore.sh, the backup-restore self-test).
# Sourced, not run. Works on Linux (Debian/Ubuntu/WSL packages) and macOS
# (Homebrew postgresql@17). Every call goes through a Unix socket to a LOCAL
# server with an emptied environment (env -i), so no hosted-database variable,
# service file or ~/.psqlrc can redirect or alter it. bash 3.2 compatible
# (macOS /bin/bash).
#
#   Linux:  tools in /usr/bin (pg_wrapper), socket /var/run/postgresql,
#           run as the `postgres` OS user via sudo.
#   macOS:  tools in $(brew --prefix postgresql@17)/bin, socket /tmp,
#           run as you (Homebrew's server superuser is your login name).
#
# Overrides (only needed for unusual installs):
#   VENTS_PG_BIN         directory holding psql/pg_dump/pg_restore
#   VENTS_PG_SOCKET_DIR  directory holding .s.PGSQL.5432
#   VENTS_PG_RUN_AS      "postgres" (sudo -u postgres) or "self"

VENTS_OS="$(uname -s)"
if [ -z "${VENTS_PG_BIN:-}" ]; then
  if [ "$VENTS_OS" = "Darwin" ]; then
    for d in "$(brew --prefix postgresql@17 2>/dev/null)/bin" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
      if [ -x "$d/psql" ]; then VENTS_PG_BIN="$d"; break; fi
    done
    VENTS_PG_BIN="${VENTS_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
  else
    VENTS_PG_BIN=/usr/bin
  fi
fi
if [ -z "${VENTS_PG_SOCKET_DIR:-}" ]; then
  if [ "$VENTS_OS" = "Darwin" ]; then VENTS_PG_SOCKET_DIR=/tmp; else VENTS_PG_SOCKET_DIR=/var/run/postgresql; fi
fi
if [ -z "${VENTS_PG_RUN_AS:-}" ]; then
  if [ "$VENTS_OS" = "Darwin" ]; then VENTS_PG_RUN_AS=self; else VENTS_PG_RUN_AS=postgres; fi
fi
SOCKET_DIR="$VENTS_PG_SOCKET_DIR"
case "$VENTS_PG_RUN_AS" in postgres|self) ;; *) echo "VENTS_PG_RUN_AS must be postgres or self" >&2; exit 2 ;; esac

# Run a PostgreSQL client tool from VENTS_PG_BIN with an empty environment.
pgtool() {
  local tool="$1"; shift
  if [ "$VENTS_PG_RUN_AS" = "postgres" ]; then
    sudo -u postgres env -i PATH="$VENTS_PG_BIN:/usr/bin:/bin" "$VENTS_PG_BIN/$tool" "$@"
  else
    env -i PATH="$VENTS_PG_BIN:/usr/bin:/bin" HOME="${HOME:-/}" PGUSER="$(id -un)" "$VENTS_PG_BIN/$tool" "$@"
  fi
}
# psql on the local socket, port 5432, ignoring ~/.psqlrc.
pg() { pgtool psql -X -h "$SOCKET_DIR" -p 5432 "$@"; }

# Temporary directory for the dump copy: readable by the postgres OS user on
# Linux (it runs pg_restore), private to you on macOS.
vents_mktemp() {
  local d; d="$(mktemp -d)"
  if [ "$VENTS_PG_RUN_AS" = "postgres" ]; then chmod 755 "$d"; else chmod 700 "$d"; fi
  echo "$d"
}
vents_file_mode() { if [ "$VENTS_PG_RUN_AS" = "postgres" ]; then echo 644; else echo 600; fi; }

# Refuse unless the server on the socket is local and not a Supabase server.
vents_require_local_server() {
  [ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || { echo "REFUSING TO RUN: no local PostgreSQL socket at $SOCKET_DIR (port 5432)." >&2; exit 2; }
  local c
  c="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" 2>/dev/null | tail -n1)"
  [ "$c" = "true/true" ] || { echo "REFUSING TO RUN: connection is not a local, non-Supabase PostgreSQL server (${c:-no answer})." >&2; exit 2; }
}
