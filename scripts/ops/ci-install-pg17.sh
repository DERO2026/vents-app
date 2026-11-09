#!/usr/bin/env bash
# Installs PostgreSQL 17 (server + client) on a GitHub-hosted Ubuntu runner and
# leaves exactly one cluster, version 17, on port 5432 -- the port the restore
# drill (verify-backup-restore.sh) uses. CI only: it drops any other cluster.
# Production runs PostgreSQL 17.6, and pg_dump must not be older than the server.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = "true" ] || { echo "REFUSING TO RUN: CI runners only (it drops local PostgreSQL clusters)." >&2; exit 2; }
sudo apt-get update -qq
sudo apt-get install -y -qq postgresql-common >/dev/null
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
sudo apt-get install -y -qq postgresql-17 postgresql-client-17 postgresql-contrib-17 >/dev/null
pg_lsclusters --no-header | while read -r ver name _; do
  if [ "$ver" != "17" ]; then sudo pg_dropcluster --stop "$ver" "$name"; fi
done
if ! pg_lsclusters --no-header | grep -q '^17 *main'; then sudo pg_createcluster 17 main --port 5432; fi
sudo sed -i 's/^#\?port = .*/port = 5432/' /etc/postgresql/17/main/postgresql.conf
sudo pg_ctlcluster 17 main restart
# The client tools on PATH must be 17 too (pg_wrapper picks the newest cluster).
for t in pg_dump pg_restore psql; do
  v="$("$t" --version | grep -oE '[0-9]+' | head -1)"
  [ "$v" = "17" ] || { echo "STOP: $t on PATH is version $v, need 17" >&2; exit 1; }
done
pg_lsclusters
echo "ok: PostgreSQL 17 server on 5432; pg_dump $(pg_dump --version | grep -oE '[0-9]+\.[0-9]+' | head -1)"
