# Phase 6 report: orchestration, docs, template, deployment plan (2026-10-04)

Branch `feature/debt-receivables-etl`, worktree `07PREPORT-etl`. Nothing committed; nothing deployed. Odoo was only
read; `etl-worker` and `etl-api` stay stopped.

## 1. Orchestration now runs platform jobs

**The problem.** Before this phase, the scheduler and Control Center still ended in
`python -m sales_pipeline.main`, the legacy writer. Restarting the ETL containers would have recreated the legacy
tables.

| Layer | Change |
|---|---|
| Flask `etl-api` (`data/etl/api`) | `POST /etl/run` takes `{"job": "<platform job>"}`, validated against the platform registry; it spawns `python -m etl_platform.run <job> --trigger-source <label>`. Without `job`, the old `loadMode` maps to `sales_incremental` (incremental) / `full_all` (full). `outputMode` other than `sql` is refused (Excel export retired). The legacy writer is never started |
| Node runner (`pythonRunner.ts`) | `PlatformJob` type, `platformJobFor()`; every request carries the job name |
| Queue / tracking (`etlQueue.ts`, `etlRunTracker.ts`) | the job name travels on the BullMQ payload and is stored in `etl_job_runs.job_type`; new mode `finance` |
| Schedules (`registerSchedules.ts`, `etlConfig.ts`) | incremental → `sales_incremental`, nightly full → `full_all`, **new** `ETL_SCHEDULE_FINANCE_CRON` (default `30 6 * * *`) → `finance_receivables` |
| Control Center (backend + frontend) | Sales Refresh / Full Refresh / **Receivables Snapshot**; scheduler panel shows the finance schedule; the retired SQL/Excel modes only appear as labels on old runs |
| Env examples | `ETL_SCHEDULE_FINANCE_*` added; `ODOO_DEBT_*` commented out until the bot user exists (a `CHANGE_ME` value would have made the job try a fake login instead of falling back) |

**Verified end to end** (local Flask API, worktree code):

- an unknown job is refused (400, listing the six valid jobs);
- `platform_selfcheck` was started over HTTP, ran the platform CLI, streamed 14 log lines and exited 0;
- the step lines match the pattern the Node worker uses for progress.

## 2. Per-department freshness

- New `GET /meta/freshness?department=sales|finance|core` (`measures/departmentFreshness.ts`). It returns the last
  successful top-level run, a newer failure if any, and for finance the newest snapshot date.
- Checked live:

  | Department | Last success (UTC) | Job | Snapshot |
  |---|---|---|---|
  | finance | 17:04 | `finance_receivables` | 2026-10-04 |
  | sales | 11:26 | `sales_full` | – |
  | core | 17:01 | `core_dims` | – |

  An unknown department returns 400.
- The sales footer keeps its own check (`refreshStatus.ts`, sales runs only).

## 3. Receivables: end-of-extraction recount

After reading the open lines, `extract_receivables` asks Odoo for the ids again.

- Lines posted or closed during the read are listed in `etl_task_log.details.recount`, and a WARNING is logged.
- The snapshot itself stays one consistent read.
- This makes the kind of difference seen with INV/2026/10/0105 visible on every run.

## 4. Migration 0034 (retire), template, docs

- **`data/warehouse/migrations/manual/0034_retire_legacy.sql`** drops the 34 `zz_legacy_*` tables, the 3 `pipeline_*`
  tables, the 8 `qa_*` tables and the 4 `_tmp_keys_*` tables, each named explicitly.
  - It lives in `manual/`, so `apply_migrations.py` can never apply it, not even by name.
  - It was checked first that no backend, frontend or platform code reads those tables.
  - **Not applied.**
- **`data/etl/templates/department/`**: README with the 9 steps, `jobs.py`, `transform.py`, `migration_template.sql`
  and `test_department.py.tmpl`.
  - It is outside `src/` on purpose: the registry imports every module under `src/departments/`.
  - The template transform was run against the test key maps: keys resolve and fallbacks are reported.
- **Docs.**
  - `docs/ETL.md`: new section 0, the current platform (jobs, schedules, orchestration chain, run log, freshness,
    tables, data quality, safety). The legacy sections are marked as such.
  - `docs/rename-map.md`: status updated (0028–0033 applied, 0034 manual).
  - `docs/deployment-plan.md`: the deployment plan from the worktree (next section).

## 5. Deployment plan (summary of `docs/deployment-plan.md`)

0. **State.** `powerBI_Data` is already at 0033 and loaded. The stopped production containers hold old code and
   **must not be restarted as they are**.
1. **Open decisions.** None blocks the deploy.
2. **You commit and merge.** Review the worktree changes, commit, open a PR, then merge `--no-ff` into production's
   local `main` in `07PREPORT-ppl`. Merge the Kaizen/UX resolutions first if they are not there yet. Never apply 0024.
3. **Inputs.** Back up the five production workbooks, then copy the staging versions in. Re-apply any production
   edits made after 2026-10-01 first.
4. **Configuration.** Fill in the new env vars, with the debt bot user commented out.
5. **Database.** Production needs nothing more. Other databases: 0028 → 0033 in order; never 0034 here.
6. **Deploy.** `scripts/deploy.sh deploy <tag>` with the schedules disabled; rebuild the `etl-api` image. The smoke
   check's incremental run is now `sales_incremental`.
7. **First runs** from the Control Center: Full Refresh, then Receivables Snapshot. Check the run log, DQ results and
   freshness.
8. **Enable schedules** and observe for 7 days.
9. **Retire.** Apply 0034 by hand, after your approval.
- **Rollback.** Old images plus the 2026-10-01 dump restore, which loses the new tables and the finance history.

## 6. Tests

| Suite | Result |
|---|---|
| ETL (`pytest`, incl. `api/tests`) | 381 passed, 1 skipped; 1 failure (`test_input_check::test_wrong_case_file_name_gets_a_near_match_hint`, pre-existing) |
| Backend (`vitest`) | 432 passed (96 skipped) |
| Backend / frontend `tsc` | clean |

New tests:

- the platform API (5);
- runner payload and job mapping (2);
- department freshness (2);
- receivables recount (1).

The existing `api/tests` (37) pass after making the job name backward compatible.

**Not verified visually.** The Control Center page with the new modes (frontend type check only). It needs the full
authenticated stack; check it at step 7 of the deployment.

## 7. Not done (follow-ups)

- **True write-date incremental extraction for sales.** `sales_incremental` still re-extracts the sales models in
  full, about 20 minutes.
- **Code-written sales labels.** `v_sales_deliveries.DeliveryStatus`, `v_sales_documents.SalesDocumentType` and
  `v_sales_leads.LeadType` still carry labels written in code. They feed page wording, so they need the page owners'
  agreement.
- **Debt report page.** Backend endpoints and frontend reading `v_finance_*`.
- **Still waiting on you:**
  - the Aged Receivable exports (2026-10-04, per company);
  - the answers in `odoo_user_second_accounts_review.csv`;
  - the bot user;
  - approval of the deployment.
