#!/bin/sh
# Backs up the database to a compressed, timestamped file and removes
# backups older than the retention period. Run it daily (cron or a systemd
# timer, see deploy/), and copy BACKUP_DIR to storage in another place.
#
#   PG* variables          which database
#   BACKUP_DIR             where to write (default /var/backups/exam-simulator)
#   BACKUP_KEEP_DAYS       how long to keep local backups (default 14)
#
# Restore with scripts/restore.sh. Test a restore at least once a month.
set -eu
DIR="${BACKUP_DIR:-/var/backups/exam-simulator}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
: "${PGDATABASE:?set PGDATABASE}"
mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/${PGDATABASE}-${STAMP}.dump"
# Custom format: compressed, and pg_restore can restore all or part of it.
pg_dump --format=custom --no-owner --no-privileges --file="$FILE.partial"
mv "$FILE.partial" "$FILE"
chmod 600 "$FILE"
# A backup that pg_restore cannot read is not a backup.
pg_restore --list "$FILE" >/dev/null
find "$DIR" -maxdepth 1 -name "${PGDATABASE}-*.dump" -mtime +"$KEEP" -delete
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
