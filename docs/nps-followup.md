# NPS Detractor Follow-up

One case per detractor rating (★, "أقل من المتوقع"), followed up on the **Detractor Follow-up** page
(Process › Detractor Follow-up, `/process/nps-followup`). Built on the NPS Score data (`docs/nps-etl.md`).

## Stage, status and reasons

Migrations `0066_nps_followup_stage_status.sql` and `0067_nps_reason_two_level.sql` (2026-11-06). **Stage and status are
two separate things. Their names and values are never mixed.**

| | Stage | Status |
|---|---|---|
| What it is | The workflow step. Users move the case through it. | The outcome group. It is worked out from the stage; nobody sets it by hand. |
| Values | NEW, CONTACTED, IN_PROGRESS, RESOLVED, REJECTED (+ HISTORICAL) | OPEN, CLOSE, DISPUTED |
| Shown as | The board columns, the Stage filter, the stage history | The badge on the card and in the case window, the Status filter, the KPIs |
| Editable | Yes | No (generated column plus statusOfStage()) |

**Stage → status** (the generated column `status` of 0066; `statusOfStage()` in the backend and the frontend is the same
rule):

| Stage | Status |
|---|---|
| New, Contacted, In progress | Open |
| Resolved | Close |
| Historical | none (NULL): no badge, left out of the status KPIs and the Status filter |
| anything else (Rejected) | Disputed |

Two cards in the same column always have the same badge. That is expected.

**What 0066 changed** on `nps_followup_case`:
- the column `status` (which held the stage values) is renamed `stage`; `SOLVED` → `RESOLVED`, `CANCELLED` → `REJECTED`;
- `solved_at` → `resolved_at`;
- new `rejected_at` (Tripoli time), set when the stage becomes Rejected, kept while it stays Rejected, cleared when it
  leaves. A case rejected before 0066 gets the time of its last change to Cancelled. The Rejected column has no 30-day
  window;
- new `status`, a STORED generated column. MySQL refuses any write to it;
- the history (`nps_followup_audit`) is rewritten: field `status` → `stage`, `solved_at` → `resolved_at`, and the old
  values.

**The rules that keep them apart:**
- The API returns both `stage` and `status`. The filters are `stages=` and `statuses=`; a stage value in `statuses=`
  (or the other way round) is refused (400), so a mix-up never filters silently.
- A client can never write `status` (or `rejectedAt`): a PATCH that sends it is refused (`case.statusReadOnly`).
- KPIs: Open, Close and Disputed (counts and shares) come from the status, over every case of the filters. The time
  KPIs (Close SLA missed, Contact SLA missed, resolved in the last 30 days and within SLA) use the stage and case creation time.
- The history records only stage changes, as field `stage`. There is never an audit row for `status`: it changes by
  itself with the stage.
- The ETL (`followup.py`) inserts the stage only. Before 0066 the stage still lives in `status`, so it falls back to
  that column, only while the column `stage` does not exist. The run details say which column was written
  (`stage_column`).
- `backend/src/services/__tests__/npsStageStatusSql.test.ts` fails if any SQL or code in the repo (outside 0052 and the
  `down/` files) still compares `status` with a stage value.

**The follow-up charts on the NPS Score page** (one row: Errors by reason · Detractors by reason · Detractors by
status · Resolved Ageing; 2 × 2 on desktop so the six ageing buckets remain readable, 1 column on phones):

| Chart | Slices | Click |
|---|---|---|
| Detractors by reason | the reason categories, "Not yet classified" | a category → its sub-reasons ("Not specified" included); "← All reasons" |
| Detractors by status | Open, Close, Disputed (the generated `status`) | a status → its stages (Open → New / Contacted / In Progress, Close → Resolved, Disputed → Rejected; a stage with no case shows 0); "← All statuses" |
| Resolved Ageing | Six age buckets, stacked Resolved / Still open, with the Close SLA marker | No chart-to-table filtering exists on this page |

The reason and status donuts share the total of cases **with a status** (Open + Close + Disputed, including Rejected).
Historical has no status and is shown in the note. The ageing chart excludes Rejected as well and shows
"Rejected: n · Historical: n" below it. `charted + historical + noCase` equals the detractor total;
the ageing bars sum to `charted - rejected`. All charts use the same date, scope and global filters.

Status colours use `--ps-fu-*`; SLA time colours use the dedicated `--ps-sla-*` tokens described below.

## SLA

Limits live in `backend/src/config/npsSla.ts` and the shared frontend constant `frontend/src/lib/nps/sla.ts`:
`NPS_SLA = { contactHours: 24, closeDays: 5 }`. A test checks that they agree. Unit conversions use `HOURS_PER_DAY`.
Both deadlines start at **case creation**, not the rating: contact within 24 calendar hours
(`contacted_at - created_at ≤ 24 h`), resolve within 5 calendar days (`resolved_at - created_at ≤ 5 d`).
`created_at` is stored in UTC and converted to Tripoli time before comparing it with the local contact/resolution times.
Comparisons and buckets use unrounded durations; exactly at either deadline is still within SLA.

| Case | Rule | Time colour |
|---|---|---|
| Open | Age ≤ 24 h, contacted or not | Green |
| Open | 24 h < age ≤ 5 d and contacted | Amber |
| Open | Age > 24 h and no contact time | Red: Contact SLA missed |
| Open | Age > 5 d, contacted or not | Red: Close SLA missed (takes precedence in the tooltip) |
| Resolved | Resolved within 5 d | Green |
| Resolved | Resolved after 5 d | Red |
| Rejected / Historical | No SLA | Grey; text says "rejected" / "historical" |

The list, board card edge and time, NPS detractor table and case window all use this state. Each time value has an
icon and a tooltip naming its rule; a late close shows how many days past the close deadline it is.
The palette validator checks the green/amber/red palette in both themes; automated WCAG checks require 4.5:1 text
contrast on card and page surfaces. Icons, labels and chart hatching supplement colour.

**Resolved Ageing** replaces "Resolved by time" with vertical stacked bars: **≤ 1 d · 1–2 d · 2–5 d · 5–10 d ·
10–30 d · > 30 d**. Resolved cases use creation-to-resolution duration (solid); Still open uses creation-to-now age
(hatched). Buckets through 5 d are green; later buckets are red. A vertical **Close SLA 5 d** marker separates them.
The two series have tooltips and labels; Rejected, Historical and missing cases are excluded and counted in the note.
There is no existing chart-to-detractor-table filtering mechanism, so the bars do not filter the table.

Below the chart: **Closed within SLA: x of y (z %) · Contacted within 24 h: x of y (z %)**.
The close denominator is all resolved cases. The contact denominator is the union of contacted cases, resolved cases
and open cases older than 24 h; newly open cases still waiting within their contact window are not treated as failures.
The contact numerator requires a recorded contact time within 24 h. Rejected and Historical are excluded from both.
Percentages round to whole numbers. An empty denominator displays "— (none due yet)".

Board SLA KPIs remain full width: **Close SLA missed** (open more than 5 days), **Contact SLA missed** (open older
than 24 h with no contact time), **Resolved, last 30 days** (with "x within SLA (5 d)"), and **Not classified**.
A case can miss both deadlines and count in both missed KPIs. These stage KPIs use the displayed board cases;
the existing truncation note applies when there are more than 2,000 cases.

Calendar hours remain in use. The Critical Number feature already has working-day helpers in
`backend/src/measures/criticalNumber.ts` and `criticalNumberHistory.ts`, which skip Fridays and configured official
holidays. They do **not** implement the Friday/Saturday weekend required here and are not used for NPS.

**Reasons in two levels** (0067, `dim_nps_reason`, managed on the Reasons tab): a **category** and its **sub-reasons**,
English and Arabic. On a case people pick a category, then a sub-reason. **Other** has no sub-reasons; it needs a short
note (`reason_note`, up to 200 characters). Each category also has its own row, **Not specified**: the cases the
migration moved without a known sub-reason point to it. It is never offered for a new choice.

| Category | Sub-reasons |
|---|---|
| Product Quality | Defective products, Poor performance, Inconsistent quality |
| Product Availability | Out-of-stock items, Limited assortment, Discontinued products |
| Product Range | Missing brands, Missing designs, Missing sizes, Missing colors, Missing specifications |
| Pricing | High prices, Uncompetitive offers, Unclear discounts |
| Delivery & Logistics | Late deliveries, Damaged goods, Incomplete deliveries |
| Customer Service | Poor responsiveness, Unprofessional treatment, Lack of follow-up |
| Sales Experience | Incorrect information, Insufficient product knowledge, Misleading commitments, Poor product displays, Limited samples, Inadequate assistance |
| Claims & After-Sales | Unresolved complaints, Rejected claims, Slow resolution |
| Technical Support | Insufficient technical advice, Incorrect recommendations, Delayed assistance |
| Billing & Payments | Invoice errors, Refund delays, Payment disputes |
| Other | (a short note) |

**The old reasons were moved like this** (`nps_reason_legacy_map` keeps the record, with the number of cases each one
had):

| Old reason | New reason |
|---|---|
| Late delivery | Delivery & Logistics › Late deliveries |
| Damaged product | Delivery & Logistics › Damaged goods |
| Wrong or missing item | Delivery & Logistics › Incomplete deliveries |
| Driver behaviour | Delivery & Logistics › Not specified |
| Product quality | Product Quality › Not specified |
| Price or invoice issue | Billing & Payments › Not specified |
| Customer service | Customer Service › Not specified |
| Other | Other |

A case whose old reason is not in the map stops 0067 before anything is moved (add it to the map first). The old list
`nps_followup_reason` stays, unused, until a later migration drops it.

## 1. For the people who use it

- **New detractors appear as cases within 30 minutes.** `process_nps` runs in the 30-minute refresh (and in the
  02:00 full run), and every run creates the cases for new detractor ratings.
- **Board:** one column per stage: New → Contacted → In progress → Resolved, or Rejected. The badge on each card is
  its status (Open, Close, Disputed).
  - The oldest case is at the top of each column.
  - Resolved shows the last 30 days only. Rejected has no window.
  - Historical cases (rated before the cut-over) are in the List view only.
- **List:** every case, newest rating first, with the same filters. **Export** downloads the list as Excel.
- **Time open / Resolved in** runs from case creation and uses the SLA colours and tooltips above.
  Rejected and Historical show their names in grey.
- **Filters:**
  - The usual company, customer group, channel, branch, salesperson and customer filters. Your role's data scope
    applies.
  - The follow-up's own: rating dates, stage, status, reason category and sub-reason, owner, search (customer, order,
    delivery, #case).
  - The "?" beside each board stage and status KPI gives a quick definition. Stage and Status filters and list headers
    offer the full guides, including Historical. Help opens on hover, keyboard focus or tap.
  - The filters are kept in the address, so a link opens the same view.
- **A case** (click a card or a row) shows:
  - the rating, read-only: rated at, company, customer, order, delivery, branch, salesperson; the order and the
    delivery open their Odoo form in a new tab (no link when no single Odoo picking matched the delivery code);
  - the customer's comment, only for roles with View on *NPS Score detractor list and comments*;
  - the follow-up fields: stage (the status beside it follows the stage), reason category and sub-reason (Other: a
    short note), owner, contacted at, resolved at, root cause, action taken, notes;
  - the history: who changed what, and when.
- **Rules when saving:**
  - Contacted / In progress fill *Contacted at* with now when it is empty.
  - Resolved needs a reason, and fills *Resolved at* with now when it is empty.
  - Rejected needs a note saying why, and records *Rejected at*.
  - Other needs a short note saying what the reason is.
  - Dates can't be before the rating or in the future.
  - If someone else saved the case while you were editing, your save is refused and their version is shown; make
    your change again.
- **The NPS Score page follows your edits at once:** its Detractors table (stage, status, reason, owner, time open)
  and the follow-up charts read the cases live (see "The follow-up charts on the NPS Score page" below), so a saved change shows on the next page load. A row of
  that table opens the case here.
- **Source changed:** the rating left the NPS source or is no longer a detractor. The case and its follow-up are kept
  and marked ⚠; the history says when.
- **Reasons** (tab, for roles with *Detractor Follow-up reasons*):
  - Categories and their sub-reasons, with English and Arabic names. Add a sub-reason under a category, or a new
    category.
  - A reason in use can be renamed or deactivated, not deleted. A deactivated reason leaves the form but stays on its
    cases; a deactivated category hides all its sub-reasons.

## 2. Data

Migration `0052_nps_detractor_followup.sql` (reverse: `data/warehouse/down/0052_nps_detractor_followup_down.sql`, which
drops every case: export first).

| Table | What |
|---|---|
| `dim_nps_reason` | the two-level reason list (0067; see "Stage, status and reasons") |
| `nps_followup_reason` | the old flat list (0052), unused since 0067 |
| `nps_followup_case` | one row per detractor rating (`response_id` unique), the copy of the rating time, `stage`, the generated `status`, the manual fields, `source_changed` (+ when, why), `version` (edit lock) |
| `nps_followup_audit` | one row per changed field: case, who (`NULL` = the nightly refresh), when (UTC), old value, new value |

- These are **application tables**, like Kaizen's. The ETL's mart reload never replaces them.
- The rating's facts are read live from `v_process_nps_response`.
- The database itself refuses:
  - an unknown stage;
  - Resolved without a resolved time, or a resolved time on a case that is not Resolved;
  - Rejected without a rejected time, or a rejected time on a case that is not Rejected;
  - a contacted or resolved time before the rating;
  - any write to `status` (generated).
- Times:
  - `rated_at_local`, `contacted_at`, `resolved_at` and `rejected_at` are Tripoli wall-clock times.
  - `created_at`, `updated_at`, `source_changed_at` and the audit's `changed_at` are UTC.
  - The API sends all of them in Tripoli time.

## 3. How cases are created (`process_nps`)

`departments/process/followup.py`, at the end of `load_nps`, in the same transaction as the NPS facts:

1. **Add missing cases.** Every detractor without a case gets one.
   - Stage **New** when rated on or after `NPS_FOLLOWUP_START`, **Historical** before it. Only the stage is written.
   - Idempotent: the unique `response_id` means a rerun adds nothing.
2. **Flag source changes.**
   - A case whose rating left `fact_process_nps_response` gets `source_changed` = "rating no longer in the NPS
     source".
   - A case whose rating is no longer a detractor gets `source_changed` = "rating is no longer a detractor".
   - Each flag writes one audit row, and `warn:nps_followup_source_changed` lists the cases.
   - When the rating comes back as a detractor, the flag clears.
3. **Never** writes the stage of an existing case, the status, reason, owner, dates or text, so a nightly reload can't
   undo anyone's work.

The run's `etl_task_log` details carry `followup`: the column written (`stage_column`), created, flagged, restored,
cases per stage (`by_stage`) and, after 0066, per status (`by_status`).

**Settings (ETL env):** `NPS_FOLLOWUP_START=yyyy-mm-dd`, the cut-over (Tripoli date).
- Empty: no case is created, and the run details say so.
- A value that is not a date fails the run.
- Set it to the go-live date of the page.
- Local stack: `2026-10-01`, so the local board has cases.

If migration 0052 is not applied, the step is skipped and says so.

## 4. API (`backend/src/routes/npsFollowup.ts`)

| | |
|---|---|
| `GET /nps-followup/options` | stages, statuses, reasons (two levels), owners |
| `GET /nps-followup/board` | non-Historical cases (Resolved: last 30 days) + KPIs: open, close, disputed (counts and shares, by status); closeSlaMissed, contactSlaMissed, resolved30Days, resolvedInSla, noReason (by stage) |
| `GET /nps-followup/cases` | the List view, paged (`page`, `pageSize` ≤ 500) |
| `GET /nps-followup/cases/export` | .xlsx; the comment column only with Export on `nps_comments` |
| `GET /nps-followup/cases/:id` | the case, the comment (View on `nps_comments`), the history |
| `PATCH /nps-followup/cases/:id` | `{ version, ...changed fields }` (stage, reasonId, reasonNote, owner, contactedAt, resolvedAt, rootCause, actionTaken, notes) → 409 with the current case when `version` is stale; `status` or `rejectedAt` → 400 |
| `GET/POST/PATCH/DELETE /nps-followup/reasons[/:id]` | the two-level reason list: POST `{ categoryKey, subReasonEn, subReasonAr }` adds a sub-reason, `{ categoryEn, categoryAr }` a category |

**Query parameters** (`/board`, `/cases`, `/cases/export`):
- the global filters (`companyKeys`, `segmentKeys`, `channelKeys`, `salesTeamKeys`, `salespersonKeys`,
  `customerKeys`);
- `dateFrom`, `dateTo` (rating date);
- `stages` (workflow steps), `statuses` (OPEN / CLOSE / DISPUTED), `categories` (reason category keys), `reasonIds`
  (exact reasons), `owners` (names; `__none__` = no owner);
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

1. Apply migrations 0052, 0059, 0066, 0067 (in that order).
2. ETL env: `NPS_FOLLOWUP_START=<go-live date>`.
3. After the next 02:00 run, check the run details' `followup` block (created, by status) and the Board.

### Unresolved stage (9 November 2026)

Migration 0069 adds Unresolved as a separate editable board stage. Unresolved and Rejected both derive Disputed status; neither is a resolved case or part of SLA ageing. Existing Rejected cases retain their stage and history. The internal status code CLOSE is displayed as Closed throughout the app and exports.
