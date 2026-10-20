# NPS Detractor Follow-up

One case per detractor rating (★, "أقل من المتوقع"), followed up on the **Detractor Follow-up** page
(Process › Detractor Follow-up, `/process/nps-followup`). Built on the NPS Score data (`docs/nps-etl.md`).

## 1. For the people who use it

- **New detractors appear as cases after the nightly refresh at 02:00, so the next morning.** A rating that
  arrives at 10:00 today becomes a case tomorrow morning.
- **Board:** one column per status: New → Contacted → In progress → Solved, or Cancelled.
  - The oldest case is at the top of each column.
  - Solved shows the last 30 days only.
  - Historical cases (rated before the cut-over) are in the List view only.
- **List:** every case, newest rating first, with the same filters. **Export** downloads the list as Excel.
- **Time open** (rating → Solved, or → now while open) colours each card:
  - green: under 48 h
  - yellow: 48 h to 5 days
  - red: over 5 days

  Cancelled and Historical cases have no time.
- **Filters:**
  - The usual company, customer group, channel, branch, salesperson and customer filters. Your role's data scope
    applies.
  - The follow-up's own: rating dates, status, reason, owner, search (customer, order, delivery, #case), and
    "Source changed only".
  - The filters are kept in the address, so a link opens the same view.
- **A case** (click a card or a row) shows:
  - the rating, read-only: rated at, company, customer, order, delivery, branch, salesperson; the order and the
    delivery open their Odoo form in a new tab (no link when no single Odoo picking matched the delivery code);
  - the customer's comment, only for roles with View on *NPS Score detractor list and comments*;
  - the follow-up fields: status, reason, owner, contacted at, solved at, root cause, action taken, notes;
  - the history: who changed what, and when.
- **Rules when saving:**
  - Contacted / In progress fill *Contacted at* with now when it is empty.
  - Solved needs a reason, and fills *Solved at* with now when it is empty.
  - Cancelled needs a note saying why.
  - Dates can't be before the rating or in the future.
  - If someone else saved the case while you were editing, your save is refused and their version is shown; make
    your change again.
- **The NPS Score page follows your edits at once:** its Detractors table (status, reason, owner, time open), *Detractors
  by reason* and *Detractors by status* read the cases live, so a saved change shows on the next page load. A row of
  that table opens the case here.
- **Source changed:** the rating left the NPS source or is no longer a detractor. The case and its follow-up are kept
  and marked ⚠; the history says when.
- **Reasons** (tab, for roles with *Detractor Follow-up reasons*):
  - The reasons have English and Arabic names.
  - A reason in use can be renamed or deactivated, not deleted. A deactivated reason leaves the form but stays on its
    cases.

## 2. Data

Migration `0052_nps_detractor_followup.sql` (reverse: `data/warehouse/down/0052_nps_detractor_followup_down.sql`, which
drops every case: export first).

| Table | What |
|---|---|
| `nps_followup_reason` | the reason list. Seeded: Late delivery, Damaged product, Wrong or missing item, Driver behaviour, Product quality, Price or invoice issue, Customer service, Other (with Arabic names) |
| `nps_followup_case` | one row per detractor rating (`response_id` unique), the copy of the rating time, status, the manual fields, `source_changed` (+ when, why), `version` (edit lock) |
| `nps_followup_audit` | one row per changed field: case, who (`NULL` = the nightly refresh), when (UTC), old value, new value |

- These are **application tables**, like Kaizen's. The ETL's mart reload never replaces them.
- The rating's facts are read live from `v_process_nps_response`.
- The database itself refuses:
  - an unknown status;
  - Solved without a solved time;
  - a solved time on a case that is not Solved;
  - a contacted or solved time before the rating.
- Times:
  - `rated_at_local`, `contacted_at` and `solved_at` are Tripoli wall-clock times.
  - `created_at`, `updated_at`, `source_changed_at` and the audit's `changed_at` are UTC.
  - The API sends all of them in Tripoli time.

## 3. How cases are created (`process_nps`)

`departments/process/followup.py`, at the end of `load_nps`, in the same transaction as the NPS facts:

1. **Add missing cases.** Every detractor without a case gets one.
   - Status **New** when rated on or after `NPS_FOLLOWUP_START`, **Historical** before it.
   - Idempotent: the unique `response_id` means a rerun adds nothing.
2. **Flag source changes.**
   - A case whose rating left `fact_process_nps_response` gets `source_changed` = "rating no longer in the NPS
     source".
   - A case whose rating is no longer a detractor gets `source_changed` = "rating is no longer a detractor".
   - Each flag writes one audit row, and `warn:nps_followup_source_changed` lists the cases.
   - When the rating comes back as a detractor, the flag clears.
3. **Never** writes status, reason, owner, dates or text, so a nightly reload can't undo anyone's work.

The run's `etl_task_log` details carry `followup`: created, flagged, restored, cases per status.

**Settings (ETL env):** `NPS_FOLLOWUP_START=yyyy-mm-dd`, the cut-over (Tripoli date).
- Empty: no case is created, and the run details say so.
- A value that is not a date fails the run.
- Set it to the go-live date of the page.
- Local stack: `2026-10-01`, so the local board has cases.

If migration 0052 is not applied, the step is skipped and says so.

## 4. API (`backend/src/routes/npsFollowup.ts`)

| | |
|---|---|
| `GET /nps-followup/options` | statuses, reasons, owners (active users) |
| `GET /nps-followup/board` | non-Historical cases (Solved: last 30 days) + KPIs: open, open over 5 days, solved in 30 days (and within 48 h), not classified, cancelled |
| `GET /nps-followup/cases` | the List view, paged (`page`, `pageSize` ≤ 500) |
| `GET /nps-followup/cases/export` | .xlsx; the comment column only with Export on `nps_comments` |
| `GET /nps-followup/cases/:id` | the case, the comment (View on `nps_comments`), the history |
| `PATCH /nps-followup/cases/:id` | `{ version, ...changed fields }` → 409 with the current case when `version` is stale |
| `GET/POST/PATCH/DELETE /nps-followup/reasons[/:id]` | the reason list |

**Query parameters** (`/board`, `/cases`, `/cases/export`):
- the global filters (`companyKeys`, `segmentKeys`, `channelKeys`, `salesTeamKeys`, `salespersonKeys`,
  `customerKeys`);
- `dateFrom`, `dateTo` (rating date);
- `statuses`, `reasonIds`, `ownerIds` (`0` = no owner);
- `sourceChanged`, `search`.

**Scope:** every read and edit goes through `resolveScopedFilters`, the same as the NPS Score page. A case whose rating
left the source has no rating row, so it is shown only when no filter or role scope applies.

## 5. Permissions

| Page key | Actions | Who (migration 0052) |
|---|---|---|
| `nps_followup` | View (board, list, case), Edit (change a case), Export | Admin, Excellence Manager |
| `nps_followup_reasons` | View, Create, Edit, Delete | Admin, Excellence Manager |
| `nps_score`, `nps_comments` | View | the Excellence Manager also gets View on both (not Export) |

The Excellence Manager is the existing `EXCELLENCE_MANAGER` role (migration 0027, Kaizen). Other roles get access on
the Roles page.

## 6. Go-live checklist

1. Apply migration 0052.
2. ETL env: `NPS_FOLLOWUP_START=<go-live date>`.
3. After the next 02:00 run, check the run details' `followup` block (created, by status) and the Board.
