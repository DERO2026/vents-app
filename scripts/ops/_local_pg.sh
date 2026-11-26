# Shared local-PostgreSQL connection settings for the O4 scripts
# (o4-preflight.sh, verify-backup-restore.sh, the backup-restore self-test).
# Sourced, not run. Works on Linux (Debian/Ubuntu/WSL packages) and macOS
# (Homebrew postgresql@17, or MacPorts postgresql17-server under /opt/local).
# Every call goes through a Unix socket to a LOCAL
# server with an emptied environment (env -i), so no hosted-database variable,
# service file or ~/.psqlrc can redirect or alter it. bash 3.2 compatible
# (macOS /bin/bash).
#
#   Linux:  tools in /usr/bin (pg_wrapper), socket /var/run/postgresql,
#           run as the `postgres` OS user via sudo.
#   macOS Homebrew: tools in $(brew --prefix postgresql@17)/bin, socket /tmp,
#           run as you, database role = your login name (Homebrew's superuser).
#   macOS MacPorts: tools in /opt/local/lib/postgresql17/bin, socket /tmp
#           (or /opt/local/var/run/postgresql17 if that is where it is), run
#           as you, database role `postgres` (the superuser MacPorts' initdb
#           creates). Homebrew wins when both are installed.
#
# Overrides (only needed for unusual installs):
#   VENTS_PG_BIN         directory holding psql/pg_dump/pg_restore
#   VENTS_PG_SOCKET_DIR  directory holding .s.PGSQL.5432
#   VENTS_PG_RUN_AS      "postgres" (sudo -u postgres) or "self"
#   VENTS_PG_USER        database role for "self" (default: your login name;
#                        `postgres` for MacPorts)

VENTS_OS="$(uname -s)"
VENTS_PG_FLAVOR=""
if [ -z "${VENTS_PG_BIN:-}" ]; then
  if [ "$VENTS_OS" = "Darwin" ]; then
    # Homebrew's prefix only when brew itself answers (otherwise the empty
    # result would turn into the bogus candidate "/bin").
    VENTS_BREW_PG="$(brew --prefix postgresql@17 2>/dev/null || true)"
    for d in ${VENTS_BREW_PG:+"$VENTS_BREW_PG/bin"} /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
      if [ -x "$d/psql" ]; then VENTS_PG_BIN="$d"; VENTS_PG_FLAVOR=homebrew; break; fi
    done
    if [ -z "${VENTS_PG_BIN:-}" ] && [ -x /opt/local/lib/postgresql17/bin/psql ]; then
      VENTS_PG_BIN=/opt/local/lib/postgresql17/bin; VENTS_PG_FLAVOR=macports
    fi
    VENTS_PG_BIN="${VENTS_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
  else
    VENTS_PG_BIN=/usr/bin
  fi
fi
case "$VENTS_PG_BIN" in /opt/local/*) VENTS_PG_FLAVOR=macports ;; esac
if [ -z "${VENTS_PG_SOCKET_DIR:-}" ]; then
  if [ "$VENTS_OS" = "Darwin" ]; then
    VENTS_PG_SOCKET_DIR=/tmp
    if [ "$VENTS_PG_FLAVOR" = macports ] && [ ! -S /tmp/.s.PGSQL.5432 ] && [ -S /opt/local/var/run/postgresql17/.s.PGSQL.5432 ]; then
      VENTS_PG_SOCKET_DIR=/opt/local/var/run/postgresql17
    fi
  else
    VENTS_PG_SOCKET_DIR=/var/run/postgresql
  fi
fi
if [ -z "${VENTS_PG_RUN_AS:-}" ]; then
  if [ "$VENTS_OS" = "Darwin" ]; then VENTS_PG_RUN_AS=self; else VENTS_PG_RUN_AS=postgres; fi
fi
SOCKET_DIR="$VENTS_PG_SOCKET_DIR"
case "$VENTS_PG_RUN_AS" in postgres|self) ;; *) echo "VENTS_PG_RUN_AS must be postgres or self" >&2; exit 2 ;; esac
if [ -z "${VENTS_PG_USER:-}" ]; then
  if [ "$VENTS_PG_FLAVOR" = macports ]; then VENTS_PG_USER=postgres; else VENTS_PG_USER="$(id -un)"; fi
fi

# Run a PostgreSQL client tool from VENTS_PG_BIN with an empty environment.
pgtool() {
  local tool="$1"; shift
  if [ "$VENTS_PG_RUN_AS" = "postgres" ]; then
    sudo -u postgres env -i PATH="$VENTS_PG_BIN:/usr/bin:/bin" "$VENTS_PG_BIN/$tool" "$@"
  else
    env -i PATH="$VENTS_PG_BIN:/usr/bin:/bin" HOME="${HOME:-/}" PGUSER="$VENTS_PG_USER" "$VENTS_PG_BIN/$tool" "$@"
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
