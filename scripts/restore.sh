#!/bin/sh
# Restores a backup made by scripts/backup.sh into an EMPTY database.
#
#   PGDATABASE=exam_restore scripts/restore.sh /var/backups/exam-simulator/exam-20261115T020000Z.dump
#
# Restore into a new database, check it, then point the application at it
# (or rename databases during a maintenance window). It refuses to write
# into a database that already has tables, so it cannot overwrite live data.
set -eu
FILE="${1:?usage: PGDATABASE=<empty database> scripts/restore.sh <backup file>}"
: "${PGDATABASE:?set PGDATABASE to the empty target database}"
[ -r "$FILE" ] || { echo "cannot read $FILE" >&2; exit 1; }
TABLES="$(psql -qAtX -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [ "$TABLES" != "0" ]; then
  echo "refusing: database $PGDATABASE already has $TABLES tables. Restore into an empty database." >&2
  exit 1
fi
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$PGDATABASE" "$FILE"
echo "restored $FILE into $PGDATABASE"
psql -qAtX -c "SELECT 'migrations: ' || count(*) FROM schema_migrations" -c "SELECT 'users: ' || count(*) FROM users" -c "SELECT 'questions: ' || count(*) FROM questions"
