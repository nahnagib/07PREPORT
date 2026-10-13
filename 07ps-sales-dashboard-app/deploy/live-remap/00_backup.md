# 00 — Backup before the live remap

Take this **right before** `02_remap.sql` (COMMIT), in the same window. It dumps every table the remap can change, plus
the legacy and core company/segment tables, for the record. A full backup (`scripts/backup_db.sh`, as `deploy.sh` does)
is still recommended on top of it.

Replace `<database>` (e.g. `powerBI_Data`) and `<admin.cnf>` (a `--defaults-extra-file` with an account that has
`SELECT, LOCK TABLES, SHOW VIEW, TRIGGER`). Table names are case-sensitive on this server: type them exactly as below.

```bash
STAMP=$(date +%Y%m%d_%H%M%S)
mysqldump --defaults-extra-file=<admin.cnf> \
  --single-transaction --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  <database> \
  admin_company admin_company_history \
  admin_customer_group admin_customer_group_history \
  salesperson_admin_profile salesperson_admin_profile_history \
  sales_team_admin_profile sales_team_admin_profile_history \
  role_data_scope \
  Dim_Company dim_company Dim_Segment dim_segment \
  > live_remap_backup_${STAMP}.sql

# sanity check: the dump is complete and names every table
tail -1 live_remap_backup_${STAMP}.sql            # expect: -- Dump completed on ...
grep -c '^CREATE TABLE' live_remap_backup_${STAMP}.sql   # expect: 13
```

Keep the file off the server as well (copy it to the usual backup location).

## Restore (only if 04_rollback.sql cannot be used)

`04_rollback.sql` is the normal way back: it restores exactly the logged values and nothing else. Restore the dump only
if the rollback script fails or the audit table is lost. **A restore overwrites every change made to these tables after
the backup** (for example a company or role scope edited after the deploy). Roll the backend back to the previous release
at the same time: the old code expects the legacy keys.

```bash
# 1. stop the backend (no writes to the admin tables while restoring)
docker compose stop backend

# 2. restore the 13 tables (the dump drops and recreates each one; FK checks are off inside the dump)
mysql --defaults-extra-file=<admin.cnf> --default-character-set=utf8mb4 <database> < live_remap_backup_<STAMP>.sql

# 3. mark the remap as rolled back, so 02_remap.sql can be run again later
mysql --defaults-extra-file=<admin.cnf> <database> \
  -e "UPDATE zz_remap_audit_20261013 SET rolled_back_at = NOW() WHERE rolled_back_at IS NULL;"

# 4. deploy the previous backend release, then start it
scripts/deploy.sh rollback      # or check out the previous tag and deploy it
```
