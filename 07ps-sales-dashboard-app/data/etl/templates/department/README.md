# Department template

A working skeleton for a new ETL department on the platform. It follows `docs/adding-a-department.md` and the finance
department (`src/departments/finance/`), the reference implementation.

The template lives **outside** `src/` on purpose. The platform registry imports every module under `src/departments/`,
so a template there would register a real job.

## Steps

1. **Copy the code.** Copy this folder to `src/departments/<dept>/` and rename `jobs.py` / `transform.py`
   identifiers: `DEPARTMENT`, job and task names, table names.
2. **Copy the test.** Copy `test_department.py.tmpl` to `tests/test_<dept>.py`.
3. **Write the migration.** Copy `migration_template.sql` to `data/warehouse/migrations/00NN_<dept>_<topic>.sql`, with
   the matching `data/warehouse/down/00NN_<dept>_<topic>_down.sql`.
   - Tables are `raw_<source>_*`, `dim_<dept>_*`, `fact_<dept>_*`, and views `v_<dept>_*`.
   - Every key column is `<Entity>Key`, and every dimension has a `-1` member.
4. **Odoo labels.** List every Odoo selection field you show in `core/labels.py` `SELECTION_FIELDS`. Never write
   their labels in code.
5. **Org attribution.** Use `core.resolve.KeyMaps` for customer, salesperson, team, company and product keys, and
   decide `person_fallback` for the team (see "Org attribution rules").
6. **Credentials.** A dedicated Odoo bot user gets its own credential profile (`ODOO_<PROFILE>_LOGIN`, `_API_KEY`,
   `_KEY_EXPIRES`). Until it exists, fall back to `default` with a WARNING; see `departments/finance/jobs.py`
   `finance_source`.
7. **Orchestration.** Add the job to the backend scheduler and Control Center:
   - `PlatformJob` in `backend/src/etl/services/pythonRunner.ts`;
   - a schedule in `etl/scheduler/registerSchedules.ts` with `ETL_SCHEDULE_<DEPT>_*` in `etlConfig.ts`;
   - a `START_CONFIGS` entry in `routes/admin/etlControl.ts`;
   - a mode in the frontend Control Center.
8. **Freshness.** Add the department to `backend/src/measures/departmentFreshness.ts` (`ETL_DEPARTMENTS`).
9. **Verify:**
   - `python -m etl_platform.run --list` shows the job;
   - `pytest` passes;
   - the migration applies, reverses (down) and re-applies;
   - one run on a copy of the warehouse passes every orphan check.

## What the skeleton does

- **`extract_<dept>`** reads Odoo through the guarded, read-only client and replaces the raw tables.
- **`load_<dept>`** builds the dimensions and fact with `transform.build`, then runs in one transaction: upsert the
  dimensions, replace today's snapshot (or swap the mart), evaluate the checks, and roll back on any failure.
- **Checks.** Orphan checks on every key column; sanity checks from the second load on.
