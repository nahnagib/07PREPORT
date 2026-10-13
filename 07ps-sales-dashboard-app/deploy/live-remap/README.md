# Live remap — table-name case fix (2026-10-13)

## Why

Live MySQL runs on Linux with `lower_case_table_names = 0`: `Dim_Company` and `dim_company` are **two different
tables** there. The legacy pipeline wrote `Dim_Company` (keys 1 Majaal, 2 Tika), `Dim_Segment` (5 = Unknown), plus
`Dim_Customer`, `Dim_Date` and `Dim_Salesperson`. The core ETL writes the lowercase tables (`dim_company`: CompanyKey = Odoo id —
1 Majaal, 2 Namaa Al Bahr, 3 Tika, 9 Athena, 11 Structura; `dim_segment`: -1 = Unknown).

Migration 0029 was meant to retire the legacy tables, but it looked them up by their **lowercase** name only, which
works on Windows (case-insensitive) and not on Linux: on live the legacy tables stayed, and the backend kept reading
them because its SQL used the capitalised names. Visible symptom: the Company "ETL Relation" dropdown on live shows only
`1 Majaal, 2 Tika` (no Athena). Less visible: reports and filters joined new-key data against the stale legacy tables.

The code fix (same commit as this folder) makes every backend query use the lowercase core tables. From then on, every
stored key is read against the core table, so the values that admins saved on live **through the old dropdowns**
(legacy keys) must be moved to the core keys **in the same window**. Otherwise a company saved as `2` (legacy Tika)
would point at `2 = Namaa Al Bahr`.

| Stored key | Legacy → core | Where |
|---|---|---|
| CompanyKey | Tika 2 → 3 (Majaal 1 = 1) | `admin_company(+_history)`, `salesperson_admin_profile(+_history)`, `sales_team_admin_profile(+_history)` `company_key_override`, `role_data_scope` companyKeys |
| SegmentKey | Unknown 5 → -1 (others equal) | `admin_customer_group(+_history)`, both profiles' `segment_key_override`, `role_data_scope` segmentKeys |
| SalespersonKey / customer keys | identical / not stored in admin tables | nothing to do |

The remap is **by name** (legacy name = core name), never `WHERE key = 2`. Values that migration 0029 had already moved
(e.g. `3`) are not legacy keys and stay as they are. **The legacy tables are not renamed or dropped** (Power BI may read
them; `01_readonly_checks.sql` section G helps decide a later cleanup).

## Files

| File | What | Writes? |
|---|---|---|
| `01_readonly_checks.sql` | Server setting, legacy/core tables, name mapping, every stored key with both names, row counts, who still uses the legacy tables | **no** (SELECT / SHOW only) |
| `00_backup.md` | `mysqldump` of the 13 tables involved + restore steps | dump only |
| `02_remap.sql` | Guarded, by-name remap with audit table `zz_remap_audit_20261013`; **ROLLBACK by default** (dry run), COMMIT by editing the last lines | yes (on COMMIT) |
| `03_verify.sql` | Post-deploy checks; any `PROBLEM` row = stop | no |
| `04_rollback.sql` | Restores the logged old values from the audit table; ROLLBACK by default | yes (on COMMIT) |

`02_remap.sql` aborts **before any change** (error `Table '<db>.ABORT_<reason>' doesn't exist`) when: the server is not
case-sensitive or `Dim_Company` is missing; a stored legacy key has a missing/ambiguous name; two legacy keys map to one
core key; a legacy key equals a value 0029 already wrote (3 / -1); or two admin_company / customer-group rows would link
the same core key. A second run after a COMMIT changes nothing (`ALREADY APPLIED`).

## Order — all in ONE maintenance window

Run every script WITHOUT `--force` (except 01), with an account allowed to UPDATE/DELETE/INSERT the tables above and to
CREATE the audit table; save every output.

1. **Read-only checks** (any time before; send the output back for review first):
   `mysql --defaults-extra-file=<readonly.cnf> --force --table <db> < 01_readonly_checks.sql > 01_results.txt 2>&1`
2. **Dry run of the remap** (changes nothing; check sections 1a/1b, 3a/3b and 5a):
   `mysql --defaults-extra-file=<admin.cnf> --table <db> < 02_remap.sql > 02_dryrun.txt 2>&1`
3. **Stop writes**: `docker compose stop backend` (so nobody saves a company/role while keys move).
4. **Backup**: `00_backup.md`.
5. **Remap, COMMIT**: in `02_remap.sql` comment out `ROLLBACK;` and uncomment `COMMIT;` (last lines, `>>> APPLY <<<`), run
   it again → `02_commit.txt` must end with `COMMITTED`.
6. **Deploy the code** (the commit that contains this folder). With `scripts/deploy.sh`, set `AUTO_ROLLBACK=0` for this
   release: an automatic code rollback would leave remapped data under the old code (if the code must go back, run step 8).
   No migration is needed for this release.
7. **Verify**: `mysql ... --table <db> < 03_verify.sql > 03_results.txt` (no `PROBLEM` rows), then in the app:
   Admin → Companies → Edit → *ETL Relation* lists Majaal, Namaa Al Bahr, Tika, Athena, Structura (no `-1 Unknown`);
   Tika is linked to `3 Tika`; the report filters show Tika and Athena data.
8. **If the release has to be undone**: roll the code back AND run `04_rollback.sql` (ROLLBACK by default; switch to COMMIT
   the same way). If that fails, restore the dump (`00_backup.md`).

## Tested

On a throwaway MySQL 8.0.46 started with `--lower_case_table_names=0`, seeded with legacy + core tables, Tika saved with
legacy key 2 in every table, rows already on core keys (3, -1), a role holding both `2` and `3`, and a segment `5`:
dry run (no change, no audit rows) → COMMIT (exactly the legacy-key rows changed; the duplicate role scope deleted) →
second COMMIT (`ALREADY APPLIED`, no change) → `03_verify.sql` (0 problems) → `04_rollback.sql` dry run (no change) and
COMMIT (data identical to the original seed) → re-applying after the rollback works. The aborts (missing legacy name,
admin_company clash, case-insensitive server) were each triggered and changed nothing.
