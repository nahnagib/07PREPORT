# MARCOM Data Upload (Promotion) — Phase 2

Admin screen + API that loads the Marketing Director's monthly Excel workbook
(`backend/assets/marcom/MARCOM_Contribution_Data_Template.xlsx`, `TEMPLATE_VERSION 1.0`) into the
`marcom_*` tables. The four report pages (Phase 4) read only from those tables.

## Flow

1. **Validate (dry run)** — `POST /marcom/upload/validate`. Size/ZIP/zip-bomb checks run first, then the
   file is stored under a random UUID name in the private staging dir and parsed in a worker thread
   (30 s timeout). The parsed rows are diffed against the live rows; nothing is written to the data
   tables. Returns a preview and a `stagedUploadId` (valid 1 hour, owner only).
2. **Commit** — `POST /marcom/upload/commit`. Re-verifies the SHA-256, re-parses the stored file, re-diffs
   under a MySQL named lock, and writes in one transaction. Client-supplied data is never trusted; only the id.

Merge semantics: upsert by natural key. Rows absent from the file are never touched. Updates are
append-only (`is_current` flips, old row kept until rollback or forever). Re-uploading the same file
reports `0 inserted, N unchanged`.

## Endpoints

All require login **and** the `admin_marcom_upload` permission (server-side, on every route).
`GET /marcom/freshness` needs *any* of the four MARCOM report-page view permissions instead.
Errors are `{ "error": "<message>", "code": "<STABLE_CODE>", ... }`.

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /marcom/upload/template` | Download the shipped template | Static file, not regenerated |
| `POST /marcom/upload/validate` | Dry run | multipart field `file`; `.xlsx` ≤ 10 MB; rate-limited (20 / 10 min / user) |
| `POST /marcom/upload/commit` | Import a staged upload | body `{ stagedUploadId, confirmNewBrands? }` |
| `GET /marcom/upload/staged/:id/errors.csv` | Error + warning report | owner only; formula-injection safe |
| `GET /marcom/upload/batches?page=&pageSize=` | History | newest first |
| `GET /marcom/upload/batches/:id` | Batch detail | counts per table, warnings, new brands |
| `GET /marcom/upload/batches/:id/file` | Download the original file | audited |
| `POST /marcom/upload/batches/:id/rollback` | Roll back the **latest** successful batch | body `{ reason }` (required) |
| `GET /marcom/freshness` | Latest period + uploader + upload date | for the page headers (Phase 4) |

### `POST /marcom/upload/validate` → 200

```json
{
  "stagedUploadId": "9f0c…-uuid",
  "expiresAt": "2026-09-20T11:51:00.000Z",
  "filename": "feb.xlsx",
  "fileHash": "sha256…",
  "templateVersion": "1.0",
  "period": { "from": "2026-02", "to": "2026-02", "label": "February 2026" },
  "tables": [
    { "id": "spend", "label": "P1 MARCOM Spending", "rowsFound": 2, "insert": 2, "update": 0, "unchanged": 0,
      "invalid": 0, "skippedEmpty": 27, "skippedExample": 1,
      "updates": [ { "rowNumber": 7, "key": "2026|2|brand a", "changes": [ { "field": "spend", "old": "10000.00", "new": "12500.00" } ] } ],
      "updatesTruncated": false }
  ],
  "totals": { "insert": 10, "update": 0, "unchanged": 0, "examplesSkipped": 7 },
  "newBrands": ["Brand A", "Brand B"],
  "issues": [
    { "severity": "error", "sheet": "P1 - MARCOM Spending", "table": "spend", "cell": "B7",
      "code": "INVALID_MONTH", "message": "\"Agust\" is not a valid month name (use January...December)." }
  ],
  "errorCount": 0, "warningCount": 0,
  "duplicateOf": null,
  "requiresNewBrandConfirmation": true,
  "nothingToImport": false,
  "canCommit": true
}
```

Table ids: `spend, campaigns, media, social, web, trade, events`. Issue codes:
`REQUIRED_MISSING, INVALID_YEAR, YEAR_OUT_OF_RANGE, INVALID_MONTH, INVALID_ENUM, INVALID_DATE, INVALID_NUMBER,
NEGATIVE_NUMBER, NOT_INTEGER, INVALID_PERCENT, PERCENT_OUT_OF_RANGE, PERCENT_SCALED (w), NEW_BRAND (w),
FORMULA_NO_VALUE (w), EXCEL_ERROR_VALUE, EXAMPLE_COLOUR (w), END_BEFORE_START, COMPLETION_BEFORE_PLANNED (w),
DUPLICATE_KEY, UNKNOWN_CAMPAIGN, ZERO_SPEND (w), ZERO_BUDGET (w), CLICKS_GT_IMPRESSIONS (w),
ENGAGEMENT_GT_IMPRESSIONS (w), BOUNCE_GT_VISITORS (w), ATTENDANCE_GT_EXPECTED (w), ROW_UPDATES_EXISTING (w),
DUPLICATE_FILE (w)` — `(w)` = warning, everything else blocks the import.

Validate failures: `400 INVALID_FILE` (bad type/signature/structure; structure errors add `problems[]`),
`413 FILE_TOO_LARGE`, `429 RATE_LIMITED`, `400 NO_FILE`.

### `POST /marcom/upload/commit`

Request `{ "stagedUploadId": "…", "confirmNewBrands": true }` → 200:

```json
{ "batchId": 1, "period": { "from": "2026-02", "to": "2026-02", "label": "February 2026" },
  "totals": { "inserted": 10, "updated": 0, "unchanged": 0, "examplesSkipped": 7 },
  "tables": [ { "id": "spend", "label": "P1 MARCOM Spending", "inserted": 2, "updated": 0, "unchanged": 0 } ],
  "newBrandsCreated": ["Brand A", "Brand B"] }
```

Refusals: `403 STAGED_FORBIDDEN` (someone else's), `404 STAGED_NOT_FOUND`, `410 STAGED_EXPIRED`,
`409 STAGED_CONSUMED`, `409 FILE_CHANGED`, `422 BLOCKING_ERRORS` (+`issues[]`),
`409 NEW_BRANDS_UNCONFIRMED` (+`newBrands[]`), `503 BUSY` (another import holds the lock > 30 s).

### `POST /marcom/upload/batches/:id/rollback`

Request `{ "reason": "Spend figures were wrong" }` → `{ "batchId": 2 }`.
Refusals: `400 REASON_REQUIRED`, `404 BATCH_NOT_FOUND`, `409 NOT_LATEST` (+`latestBatchId`), `409 NOT_ROLLBACKABLE`.

### `GET /marcom/freshness`

`{ "hasData": true, "latestPeriod": { "year": 2026, "month": 3, "label": "March 2026" }, "uploadedBy": "Nahla", "uploadedAt": "…", "batchId": 4 }`
or `{ "hasData": false }`.

## Apply the migration

Production/dev database (same runner as every other migration; 0022 and 0023 are idempotent):

```bash
python data/warehouse/apply_migrations.py
```

Note: on a *fresh* database migration `0018` currently fails (pre-existing, unrelated). If you hit that, apply
only the new files: `0022_marcom_contribution.sql`, then `0023_marcom_upload_staging.sql`.
Dev-only down script (destroys MARCOM data): `data/warehouse/down/0022_0023_marcom_down.sql`.

Optional env: `MARCOM_STAGING_DIR` (private dir for staged files; default `<os tmp>/07ps-marcom-staging`),
`MARCOM_STAGED_TTL_MIN` (60), `MARCOM_PARSE_TIMEOUT_MS` (30000), `RATE_LIMIT_MARCOM_MAX` / `RATE_LIMIT_MARCOM_WINDOW_MIN` (20 / 10).

## Run the tests

```bash
npm test --workspace backend                      # unit tests; DB-backed suites are skipped
npx vitest run frontend/src                       # state machine + component tests (from the repo root)

python backend/scripts/marcomTestDb.py up         # throwaway MySQL 8 in docker (127.0.0.1:33307, db marcom_test)
npm run test:marcom-db --workspace backend        # DB-backed service + HTTP route tests (92 tests)
python backend/scripts/marcomTestDb.py down
```

The DB suites refuse to run against any database not named `marcom_test` on localhost — they TRUNCATE the MARCOM tables.

## Manual test script (real template)

1. Admin login → **Admin → MARCOM Data Upload**. A non-admin must not see the tab, and must get 403 from any `/marcom/upload/*` URL.
2. **Download template**; open it, then close without changes. Upload it → "Nothing to import (7 example rows skipped)", no Confirm button.
3. In the template fill P1 row 7 (2026 / February / Brand A / 10000 / 40000 / 500000 / 400000 / 12000 / 20 / 700 / 1000 / 500),
   save, upload → 1 insert in P1, blocking-free; the new-brand notice lists `Brand A`. Confirm is disabled until the box is ticked. Confirm → success screen.
4. Upload the **same** file again → duplicate-file banner, "Nothing to import… All 1 rows already match".
5. Change the spend to 12500, save, upload → "To update 1" and `spend 10000.00 → 12500.00`. Confirm → history row `0 / 1 / 0`.
6. Type `Agust` in the month → "Blocking errors" with `P1 - MARCOM Spending`, `B7`, `INVALID_MONTH`; Confirm stays disabled; **Download error report (CSV)** works.
7. **Roll back latest batch** (needs a reason) → history shows "↺ Rolled back"; re-upload of step 3's file shows it as an update again (values reverted).
8. In a second browser tab validate a file, wait > 1 h (or set `expires_at` in the past), click Confirm → "This upload expired… please re-upload".

## Assumptions / behaviour worth knowing

- **Rollback deletes** the rows the batch inserted (rather than marking them non-current) and re-arms the rows it superseded.
  Reason: the FK from data rows to `marcom_brand` would otherwise block removing brands the batch created. The batch record,
  its summary, the original file and the `audit_log` entry remain, so nothing is lost for audit.
- "Period covered" is the reporting months of the month-keyed sheets (P1, P3, P4-A). Campaign/event dates are used only if the file has none.
- A no-op commit (everything unchanged) is allowed by the API and recorded as a batch (`0 inserted, N unchanged`); the UI does not offer it.
- Audit: `audit_log.action` is limited to CREATE/UPDATE/DELETE, so the real verb (`validate`, `commit`, `rollback`, `file_download`) is in `after_value.event`.
- Auth is bearer-JWT (no cookies) so there is no CSRF surface; that matches the rest of the API.
- `permission`: one permission, `admin_marcom_upload`, gates every upload route (view). It is separate from the four report-page permissions.
