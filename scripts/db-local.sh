#!/usr/bin/env bash
# Local Postgres for migration and SQL checks.
#   scripts/db-local.sh up        start a local server (docker supabase/postgres if available, else the
#                                 system PostgreSQL cluster on port 54329)
#   scripts/db-local.sh down      stop it
#   scripts/db-local.sh migrate   apply supabase/migrations/*.sql in order (ledger table public._migrations);
#                                 applies supabase/local/shim.sql first when auth.uid() is missing
#   scripts/db-local.sh test      run tests/sql/*.sql
#   scripts/db-local.sh reset     drop and recreate the database, then migrate
#   scripts/db-local.sh psql      open psql
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SUPABASE_PG_PORT:-54329}"
DBNAME="${SUPABASE_PG_DB:-viladomat}"
IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:17.6.1.030}"
NAME="${SUPABASE_PG_CONTAINER:-viladomat-pg}"
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:${PORT}/${DBNAME}}"
ADMIN_URL="${DATABASE_URL%/*}/postgres"

have_docker() { command -v docker >/dev/null 2>&1 && timeout 5 docker info >/dev/null 2>&1; }
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
DATA_DIR="${SUPABASE_PG_DATA:-/tmp/viladomat-pg}"

wait_ready() {
  for i in $(seq 1 60); do
    if psql "$ADMIN_URL" -Atc 'select 1' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "postgres did not become ready on :$PORT" >&2; return 1
}

ensure_db() {
  if ! psql "$ADMIN_URL" -Atc "select 1 from pg_database where datname='$DBNAME'" | grep -q 1; then
    psql "$ADMIN_URL" -q -c "create database \"$DBNAME\""
  fi
}

start_system_pg() {
  if [ -z "$PGBIN" ]; then echo "no PostgreSQL server binaries found" >&2; exit 1; fi
  if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
    mkdir -p "$DATA_DIR"; chown postgres:postgres "$DATA_DIR" 2>/dev/null || true
    su postgres -c "$PGBIN/initdb -D '$DATA_DIR' -U postgres --auth=trust -E UTF8 >/dev/null"
  fi
  su postgres -c "$PGBIN/pg_ctl -D '$DATA_DIR' -o '-p $PORT -c listen_addresses=localhost' -l '$DATA_DIR/server.log' start >/dev/null" || true
}

case "${1:-}" in
  up)
    if have_docker && docker image inspect "$IMAGE" >/dev/null 2>&1; then
      if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then docker start "$NAME" >/dev/null; else
        docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -p "${PORT}:5432" "$IMAGE" >/dev/null
      fi
    else
      start_system_pg
    fi
    wait_ready && ensure_db && echo "ready: $DATABASE_URL" ;;
  down)
    if have_docker && docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then docker rm -f "$NAME" >/dev/null; fi
    if [ -f "$DATA_DIR/postmaster.pid" ]; then su postgres -c "$PGBIN/pg_ctl -D '$DATA_DIR' stop -m fast >/dev/null" || true; fi ;;
  reset)
    psql "$ADMIN_URL" -q -c "drop database if exists \"$DBNAME\" with (force)"
    ensure_db
    "$0" migrate ;;
  migrate)
    if [ -z "$(psql "$DATABASE_URL" -Atc "select to_regprocedure('auth.uid()')")" ]; then
      echo "applying local shim (no Supabase auth schema present)"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f supabase/local/shim.sql
    fi
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "create table if not exists public._migrations (name text primary key, applied_at timestamptz default now())"
    for f in supabase/migrations/*.sql; do
      n=$(basename "$f")
      if psql "$DATABASE_URL" -Atc "select 1 from public._migrations where name='$n'" | grep -q 1; then continue; fi
      echo "applying $n"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
      psql "$DATABASE_URL" -q -c "insert into public._migrations(name) values ('$n')"
    done
    echo "migrations applied" ;;
  test)
    shopt -s nullglob
    for f in tests/sql/*.sql; do
      echo "sql test: $f"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
    done
    echo "sql tests passed" ;;
  psql)
    psql "$DATABASE_URL" ;;
  *)
    echo "usage: $0 {up|down|migrate|test|reset|psql}" >&2; exit 2 ;;
esac
