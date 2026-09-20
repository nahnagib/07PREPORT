#!/usr/bin/env bash
# Logical backup of the warehouse database (compressed mysqldump). See docs/DEPLOYMENT.md section 4.
#
#   BACKUP_DEFAULTS_FILE  MySQL option file holding [client] host/user/password of a backup account
#                         (mode 600). REQUIRED -- the password is never passed on the command line.
#   DB_NAME               database to dump (default ps_warehouse)
#   BACKUP_DIR            where dumps go (default ./db_backups, git-ignored)
#   BACKUP_KEEP_DAYS      delete dumps older than this (default 14)
# Restore: gunzip -c <dump>.sql.gz | mysql --defaults-extra-file="$BACKUP_DEFAULTS_FILE" "$DB_NAME"
set -euo pipefail
: "${BACKUP_DEFAULTS_FILE:?set BACKUP_DEFAULTS_FILE to a MySQL option file (see the header of this script)}"
DB_NAME="${DB_NAME:-ps_warehouse}"
BACKUP_DIR="${BACKUP_DIR:-./db_backups}"
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/${DB_NAME}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
# --single-transaction: consistent InnoDB snapshot without locking the ETL's tables.
mysqldump --defaults-extra-file="$BACKUP_DEFAULTS_FILE" --single-transaction --routines --triggers \
  --set-gtid-purged=OFF "$DB_NAME" | gzip -9 > "$out"
if [ ! -s "$out" ]; then
  echo "backup is empty: $out" >&2
  rm -f "$out"
  exit 1
fi
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime "+${BACKUP_KEEP_DAYS:-14}" -delete
echo "backup written: $out ($(du -h "$out" | cut -f1))"
