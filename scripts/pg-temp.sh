#!/usr/bin/env bash
# Starts or stops a throwaway PostgreSQL 16 instance for integration tests and
# loads migrations, the July 2026 blueprint and the synthetic test bank.
#
#   scripts/pg-temp.sh start   # prints the PG* variables to export
#   scripts/pg-temp.sh stop
#
# For local development and CI only. Never point this at a real database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DATA="${PG_TEMP_DATA:-/tmp/pmp-sim-pgdata}"
PORT="${PG_TEMP_PORT:-5545}"
SOCK=/tmp
DB=pmpsim_test

# PostgreSQL refuses to run as root; fall back to the postgres account.
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
sql() { psql -h "$SOCK" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

case "${1:-}" in
  start)
    if [ -d "$DATA" ]; then as_pg "$BIN/pg_ctl -D $DATA -m fast stop" >/dev/null 2>&1 || true; rm -rf "$DATA"; fi
    mkdir -p "$DATA"
    if [ "$(id -u)" = 0 ]; then chown postgres "$DATA"; fi
    as_pg "$BIN/initdb -D $DATA -A trust -U postgres" >/dev/null
    # Loopback TCP with TLS and password sign-in, so the protocol client's
    # authentication and encryption can be tested. Local sockets stay trusted.
    if command -v openssl >/dev/null; then
      openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
        -keyout "$DATA/server.key" -out "$DATA/server.crt" >/dev/null 2>&1
      cp "$DATA/server.crt" /tmp/pmp-sim-pg-ca.crt
      chmod 600 "$DATA/server.key"
      if [ "$(id -u)" = 0 ]; then chown postgres "$DATA/server.key" "$DATA/server.crt"; fi
      SSL_OPTS="-c ssl=on -c ssl_cert_file=$DATA/server.crt -c ssl_key_file=$DATA/server.key"
    else
      SSL_OPTS=""
    fi
    cat > "$DATA/pg_hba.conf" <<HBA
local all all trust
hostssl all scram_user 127.0.0.1/32 scram-sha-256
host all scram_user 127.0.0.1/32 scram-sha-256
host all md5_user 127.0.0.1/32 md5
host all plain_user 127.0.0.1/32 password
HBA
    if [ "$(id -u)" = 0 ]; then chown postgres "$DATA/pg_hba.conf"; fi
    as_pg "$BIN/pg_ctl -D $DATA -o '-p $PORT -c listen_addresses=127.0.0.1 -k $SOCK $SSL_OPTS' -l $DATA/server.log -w start" >/dev/null
    psql -h "$SOCK" -p "$PORT" -U postgres -d postgres -q -c "CREATE DATABASE $DB"
    # The same migration command production uses, so it is exercised by every test run.
    PGHOST="$SOCK" PGPORT="$PORT" PGUSER=postgres PGDATABASE="$DB" node "$ROOT/scripts/migrate.ts" >/dev/null
    sql -f "$ROOT/db/seed/synthetic_bank.sql" >/dev/null
    sql -c "SET password_encryption = 'scram-sha-256'; CREATE ROLE scram_user LOGIN PASSWORD 'scram pass ü'; \
            SET password_encryption = 'md5'; CREATE ROLE md5_user LOGIN PASSWORD 'md5 pass'; \
            CREATE ROLE plain_user LOGIN PASSWORD 'plain pass';" >/dev/null
    echo "export PGHOST=$SOCK PGPORT=$PORT PGUSER=postgres PGDATABASE=$DB"
    ;;
  stop)
    as_pg "$BIN/pg_ctl -D $DATA -m fast stop" >/dev/null
    rm -rf "$DATA"
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
