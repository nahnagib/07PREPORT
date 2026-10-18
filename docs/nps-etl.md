# NPS Score ETL (Process department): runbook

Job `process_nps` (`07ps-sales-dashboard-app/data/etl/src/departments/process/`). It loads the customers' delivery
ratings from the NPS developer's MySQL database into the warehouse. The **NPS Score** page under Process and its API
are implemented locally (step 2, 2026-10-18); the follow-up workflow remains pending business approval.
- Only the ETL connects to the NPS database.
- Anything that shows the data reads the `v_process_nps_*` views of the warehouse.
- There are no NPS credentials in `backend/.env`.

## 1. What it loads

| Layer | Table / view | From | Load |
|---|---|---|---|
| Raw | `raw_nps_rating` | `nps_rating_full_data` (every rating and comment message) | full read every run, upsert by `id`, `_deleted_at` on ids that left the source |
| Raw | `raw_nps_low_rating` | `low_rating_data` (the messages of deliveries rated "below", copied by the developer's script, same ids) + `team_branch`, `recipient_email`, `email_notification`, `notification_date` | same |
| Raw | `raw_nps_sync_state` | `sync_state` (the developer's own bookkeeping; read only, never written) | replaced |
| Mart | `dim_process_nps_level` | `departments/process/nps.py` | upsert |
| Mart | `fact_process_nps_response` | one row per **rating** message | replaced in one transaction |
| Mart | `fact_process_nps_comment` | one row per free-text message, linked to its delivery's rating | replaced in one transaction |
| Serving | `v_process_nps_response`, `v_process_nps_comment`, `v_process_nps_summary`, `v_process_nps_trend`, `v_process_nps_low_rating` | migration 0046 | — |

Raw is small (152 rating rows, 9 low-rating rows on 2026-10-17), so both tables are read completely every run, paged
by id. The facts are rebuilt with DELETE + INSERT in **one transaction** with the quality checks. Readers keep seeing the
previous rows until the commit, and a failed check rolls everything back. This is simpler than an atomic table swap
and gives the same guarantee at this size.

## 2. Rules (decisions of 2026-10-18)

**The measure (D1, step 2 labels).** Customers rate each delivery with one, two or three stars. The page maps those
answers to Detractors, Passives and Promoters respectively. The source has no numeric 0–10 answer; the mapping is:

| Level | Answer (`body`, the whole `<p>…</p>` text, trimmed) | Meaning |
|---|---|---|
| 3 `exceeded` | فاقت التوقعات | Promoter (★★★; equivalent NPS group 9–10) |
| 2 `met` | في مستوى التوقعات | Passive (★★; equivalent group 7–8) |
| 1 `below` | أقل من المتوقع | Detractor (★; equivalent group 0–6) |

- **Anything else is not a rating.** It is a comment (free text) or blank, and never counts as 0.
- **One place.** The rule lives in `departments/process/nps.py` only; its tests use the three Arabic strings.
- **Main figures:** the count and the share of each level, and the responses total.
- **NPS** = %Promoters − %Detractors over the responders, −100…+100. It is always
  computed from the counts of whatever is grouped (a team's score is never the average of its salespeople's scores).
- **CSAT** = (Passives + Promoters) / Responders × 100. The backend formulas live in `backend/src/measures/npsScore.ts`.
  Example: 124 Promoters, 44 Passives, 9 Detractors → 177 responders, NPS 64.97 and CSAT 94.92. Round only for display.
- **Bands:** `backend/src/config/npsThresholds.ts`: NPS red below 50, yellow from 50, green from 90 (target 90);
  CSAT red below 85, yellow from 85, green from 95 (target 95). Lower boundaries are inclusive.
- **Responses and comments.** One response = one delivery's rating. A comment is linked to the rating of the same
  `delivery_code`: the latest one before it, else the first one after it (`-1` when the delivery has no rating).
- **Small groups.** Fewer than `NPS_MIN_RESPONDERS` (backend setting, default 5): show the value faded with `n = x`.
  Zero responders gives a null score, displayed as a dash. The gauge is drawn 0–100; negative NPS pins the needle to 0
  while the numeric label retains its negative value.

**Dates (D2).**
- The source stores **UTC**, checked on 2026-10-17: `scheduled_date` = Odoo's picking scheduled date − 2 h on 146 of
  146 rows.
- `create_date` (the rating) and `scheduled_date` (the delivery) are converted to Africa/Tripoli.
- Reports filter on the rating date: `RatingDateKey` = the local date of `create_date`.

**Keys (D3).** All through `core/resolve.py` `KeyMaps`, never names:
- **Customer:** `partner_id` → its commercial partner (`map_partner_customer`).
- **Salesperson:** `salesperson_id` is the Odoo **user** id (sheet `OdooUsers`); 146 of 146 match.
- **Team:** `team_id` as transacted (sheet `OdooTeams`). With no team, or a SALESPERSON team, it is the salesperson's
  team; with neither, `-1`.
- **Segment and channel:** the segment follows the team, the channel the salesperson.
- **Sales order:** `SalesOrderKey` is the sale order matched by name (`order_id`), else `-1`. 145 of 146 non-blank match.

**Company.** The source `company_id` is **not** used: the developer's script fills it from the WhatsApp account
(`wa_account_id`), not `res.company`. The 5 "company 7" rows of 2026-10 are TIKA.
- `CompanyKey` is the company of the matched **sale order**.
- Else, the company of the matched **delivery** (`fact_sales_deliveries.DeliveryReference` = `delivery_code`).
- Else, the source `company_name` mapped to its Odoo company: MAJAAL → 1, TIKA → 3 (`transform.COMPANY_BY_SOURCE_NAME`).
- Else `-1`, with a warning.
- Order and picking names repeat across companies, so a name with several candidates is narrowed by the customer, then
  by the company name. If it is still not exactly one, there is no match (no guess).
- `company_source` on the fact says which rule applied (`order` / `delivery` / `company_name` / `none`).

**Low ratings (D4).**
- A low rating = level 1, a flag on the response fact. There is no separate fact.
- `low_rating_data` is read only to cross-check (warnings) and for `team_branch` (B2B / B2C).
- No escalation KPIs: `email_notification` and `notification_date` are always empty in the source.

**History (D5).**
- Everything the source has is loaded. The profiled source starts on **2026-10-01**.
- The developer's weekly report reads from 2026-07-12 in a database named `nps_dashboard`; this was asked of the
  developer on 2026-10-18.
- The database name is `NPS_DB_NAME`, so switching databases is a configuration change.

**Personal data (D6).**
- `mobile_number`, `recipient_email` and `partner_name` stay in the raw tables only.
- Comments are stored in the mart as plain text, with phone numbers and e-mail addresses masked.
- The page requires `nps_score`; the detractor list and its comments additionally require `nps_comments`.
  Migration 0048 grants both to admin only until business roles are confirmed. The page is English with Arabic group names.

**Schedule (D7).**
- The job runs inside the nightly `full_all`, as its last step and optional: its failure leaves the run `partial` and
  never touches sales or finance.
- It also runs alone every 3 hours at :30 (`ETL_SCHEDULE_PROCESS_NPS_CRON`).
- There is no watermark: the developer's script reloads the tables as a whole, so `updated_at` is the same on every row.

**Exclusions (D8).** None: the finance Backoffice / Inter Company exclusions do not apply. The step 2 page should use
the global filters and the role's data scope like every report.

**Message errors.** Rating-row failure fields are not used for reach. Reach uses the separate message source described in §8.

## 3. Access and credentials

All NPS settings are `NPS_*` in `data/etl/.env` (`DB_*` is the warehouse). Never print, log or commit them.

| Variable | Meaning |
|---|---|
| `NPS_ENABLED` | `true` = the job runs. `false` (default): not run; `full_all` records it as skipped, and run alone it fails saying so. |
| `NPS_SSH_ENABLED` | `true` (default) = SSH tunnel. `false` = connect to `NPS_DB_HOST` directly (ETL on the same server). |
| `NPS_SSH_HOST`, `NPS_SSH_PORT`, `NPS_SSH_USER` | the SSH server |
| `NPS_SSH_KEY_PATH` / `NPS_SSH_PASSWORD` | a private key (preferred; mounted read-only) or a password. The log says which one was used. |
| `NPS_SSH_HOST_KEY` / `NPS_SSH_KNOWN_HOSTS` | the expected host key fingerprint (`SHA256:…`, as `ssh-keygen -l` prints it) and/or a known_hosts file. One is required; an unknown or different key is refused. |
| `NPS_DB_HOST`, `NPS_DB_PORT` | MySQL as seen **from the SSH server** (`127.0.0.1:3306`) |
| `NPS_DB_NAME`, `NPS_DB_USER`, `NPS_DB_PASSWORD` | the NPS database and a read-only user |
| `NPS_CONNECT_RETRY_WINDOW_SECONDS` | network failures at connect are retried with backoff for this long (default 900). A rejected login, a host key mismatch or an unknown database fail at once. |

Missing variables fail the NPS job only, with a message naming them.

**Safety.**
- The tunnel listens on 127.0.0.1, on a free port, and is closed at the end of the extraction.
- Every MySQL session is `READ ONLY`, and the code has only SELECT helpers (`etl_platform/sources/mysql_ssh.py`).

**Recommended for production (DevOps runs these, not the ETL).** Replace `root` with dedicated accounts.

A read-only MySQL user on the NPS server:

```sql
CREATE USER 'bmh_nps_reader'@'127.0.0.1' IDENTIFIED BY '<long random password>';
CREATE USER 'bmh_nps_reader'@'localhost' IDENTIFIED BY '<the same password>';
GRANT SELECT ON xtremech_nps_dashboard.* TO 'bmh_nps_reader'@'127.0.0.1', 'bmh_nps_reader'@'localhost';
ALTER USER 'bmh_nps_reader'@'127.0.0.1' WITH MAX_USER_CONNECTIONS 3;
ALTER USER 'bmh_nps_reader'@'localhost' WITH MAX_USER_CONNECTIONS 3;
```

An SSH user that can only forward to MySQL (the server runs OpenSSH 8.0). On the ETL host, create a key pair with
`ssh-keygen -t ed25519 -N '' -f nps_etl_key`. Mount `nps_etl_key` read-only into the `etl-api` container
(`docker-compose.yml` has the commented line) and set `NPS_SSH_KEY_PATH=/run/secrets/nps_ssh_key`. On the NPS server:

```sh
sudo useradd --create-home --shell /sbin/nologin bmh-tunnel
sudo install -d -m 700 -o bmh-tunnel -g bmh-tunnel /home/bmh-tunnel/.ssh
# one line in /home/bmh-tunnel/.ssh/authorized_keys (mode 600, owner bmh-tunnel), the PUBLIC key nps_etl_key.pub:
#   restrict,port-forwarding,permitopen="127.0.0.1:3306" ssh-ed25519 AAAA... bmh-etl
sudo tee -a /etc/ssh/sshd_config >/dev/null <<'EOF'
Match User bmh-tunnel
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:3306
    PasswordAuthentication no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    ForceCommand /sbin/nologin
EOF
sudo sshd -t && sudo systemctl reload sshd
```

Then use `NPS_SSH_USER=bmh-tunnel`, `NPS_DB_USER=bmh_nps_reader`, and the server's host key fingerprint
(`ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub` on the server, or from a known_hosts entry checked with the
server owner).

## 4. Running

```sh
python -m etl_platform.run process_nps          # alone (core_dims first when older than ETL_CORE_DIMS_FRESH_MINUTES)
python -m etl_platform.run full_all             # nightly: ... -> sales_full -> process_nps
```

- **Control Center:** ETL Control Center → **NPS Score** (`POST /admin/etl/start/nps`).
- **Backend schedule:** `ETL_SCHEDULE_PROCESS_NPS_CRON` (default `30 */3 * * *`). It is off unless
  `ETL_SCHEDULE_PROCESS_NPS_ENABLED=true`; set it together with `NPS_ENABLED=true` in the ETL.
- **Migrations:** 0046 (ratings), 0047 (group labels), 0048 (permissions), 0049 (message facts/views),
  0050 (last successful message snapshot). Each has a matching script under `data/warehouse/down/`.

## 5. Quality checks (every run, inside the load transaction)

| Check | Severity |
|---|---|
| orphan: every fact key → its dimension (company, customer, salesperson, team, segment, channel, level, dates, sales order ≠ -1, comment → response ≠ -1) | FAIL |
| duplicate `response_id`; a level outside 1..3 | FAIL |
| an id in the source that is not a whole number (the FLOAT Odoo ids) | FAIL (extract) |
| the source returns 0 rows while the warehouse holds some | FAIL (extract; nothing is marked deleted) |
| no rating for 3 days (`warn:nps_source_stale`) | WARN |
| `sync_state` older than 3 days, or empty (`warn:nps_sync_state_stale`) | WARN |
| a response whose company was not found (`warn:nps_company_unmatched`) | WARN |
| a response naming an order not in `dim_sales_order`, or ambiguous (`warn:nps_order_unmatched`) | WARN |
| source rows that are not one of the 3 answers: comments and blanks, listed, never counted (`warn:nps_rows_not_a_rating`) | WARN |
| CustomerKey / SalespersonKey / SalesTeamKey `-1` above 10 % | WARN |
| a low-rating id missing from the full table; a "below" rating missing from the low-rating table | WARN |
| a delivery rated more than once | WARN |

`etl_task_log` holds the rows extracted and loaded, the per-level counts, the NPS-style score, the comments, the blank
rows, the company rule used, and every key fallback with sample ids.

## 6. How to verify

```sh
python scripts/process/check_nps_totals.py --from 2026-10-11 --to 2026-10-17
```

Read-only on both sides. It prints `MATCH` when all available checks agree:
1. Rows: source `COUNT(*)` = raw (not deleted), for both tables.
2. Per month (Tripoli) × level: the source rows classified with `nps.py` = `v_process_nps_summary`.
3. Per company × level: the source `company_name` = our `CompanyKey`.
4. When reach is enabled and the source table exists: source message ids = active raw ids, then date × company reach
   boxes and error groups = the two serving views for the requested period. Otherwise reach is explicitly `SKIPPED`.

It then prints the **weekly e-mail's table** for the period: counts per `company_name` and level, from the same source
rows, plus independently calculated NPS and CSAT for comparison with the page (use the same date/company filters).

**Note on the weekly e-mail.** The e-mail compares the **UTC** `create_date` with local dates, while the dashboard
converts it to Africa/Tripoli (UTC+2). A rating made between 22:00 and 24:00 UTC (00:00–02:00 in Tripoli) is on the
next day for us, so a week can differ at its edges; the script lists those ratings.

- **First local run (2026-10-18):** 152 / 9 rows; 133 responses (50 exceeded, 76 met, 7 below), NPS-style +32.3; 15
  comments, 4 blank. Company came from the order for 145 rows, from the company name for 6, and from the delivery for 1.
  The result was MATCH.
- **Weekly e-mail, 11–17 Oct:** MAJAAL 8 / 9 / 1, TIKA 10 / 18 / 2 (exceeded / met / below), the same on both time bases.

Other tools:
- `scripts/process/profile_nps_source.py`: the read-only discovery profile of phase 0. Its output goes to
  `scripts/process/output/`, which is gitignored, with phones and e-mails masked.
- ETL tests: `tests/test_process_nps.py` covers the rating rule (the three Arabic strings, comments, blanks,
  whitespace), the transform, the source module's safety rules, and the job on SQLite with a fake source.

## 7. Troubleshooting

| Message | Check |
|---|---|
| `MySQL source profile 'NPS' is missing: …` | the named `NPS_*` variables in `data/etl/.env` |
| `Job 'process_nps' is disabled in this environment` | `NPS_ENABLED=true` (and the backend schedule flag) |
| `SSH HOST KEY MISMATCH` | the server was rebuilt, or the connection is intercepted. Confirm the new fingerprint with the server owner before changing `NPS_SSH_HOST_KEY`. |
| `The SSH server rejected the login` | `NPS_SSH_USER` and the key / password |
| `Cannot reach the SSH server` / `Cannot reach MySQL …` | network, the SSH port, `NPS_DB_HOST`/`NPS_DB_PORT` as seen from the server, `AllowTcpForwarding` / `PermitOpen` |
| `MySQL rejected the login (1045)` / `no database named … (1049)` / `refused access (1142)` | `NPS_DB_USER` / `NPS_DB_PASSWORD`, `NPS_DB_NAME`, the GRANT |
| `returned 0 rows … not marking them deleted` | the developer's script was reloading the tables; the next run tries again |
| a report shows fewer responses than the e-mail | the date edges (see §6). In the app (step 2), note that the default Customer Group filter (B2B + B2C) leaves out ratings whose team is unknown (segment -1). |

## 8. Message reach

Reach counts **outbound feedback messages**, not people, ratings or unique recipients. Its source is the developer's
`whatsapp_outbound_messages` table in the same NPS database, not Odoo's `whatsapp.message`. At the handoff on
2026-10-18 the table had not been supplied (rechecked read-only during continuation). Do not enable it in production until its columns, states, failure values,
UTC timestamps and `updated_at` behavior have been profiled. Error keyword mapping is provisional.

The announced columns are `id`, `create_date`, `company_name`, `template_name`, `state`, `mobile_number`,
`failure_type`, `failure_reason`, `first_seen_at`, `updated_at`. Rules and error groups live in
`data/etl/src/departments/process/whatsapp.py`.

| ETL variable | Meaning |
|---|---|
| `NPS_REACH_ENABLED` | Default false. When true, check for the source table; if missing, log and skip reach while loading ratings normally. |
| `NPS_REACH_TEMPLATE_MATCH` | Case-insensitive substring of the template name, default `Feedback`. |
| `NPS_REACH_EXCLUDED_NUMBERS` | Comma-separated test numbers; compare the final nine digits so country-code and leading-zero variants match. Empty by default; configure the confirmed business test numbers. |
| `NPS_REACH_START` | Inclusive local message start date (`yyyy-mm-dd`); empty means all history. |

The raw table retains every source column and soft-deletes ids that leave the source. Only raw retains the mobile number.
The fact stores the Tripoli message date, company (MAJAAL → 1, TIKA → 3), normalized state, error group and scope flags.
In-scope messages match the feedback template, are not test numbers, and meet the start date.

The five boxes are Total Reach (every in-scope message), Delivered (`delivered`), Not Delivered (`sent`), Read (`read`)
and Error (`error`). These are mutually exclusive current states: Read is separate from Delivered. Any other state
remains in Total Reach and is shown separately with a warning; it is never silently dropped.
Errors group into 131026 undeliverable, 131049 ecosystem, template quality, phone format, Meta temporary, and Other.
Template quality and phone format are flagged fixable. The source's free-text error details are never sent to the page.

`GET /nps-score/reach` reads `v_process_nps_reach` and `v_process_nps_message_error`. Only company and date filters
apply; ordinary customer-group/channel/branch/salesperson/customer selections leave the numbers visible with
**Company and date filters only** (including the default B2B+B2C selection). Company role restrictions are enforced.
Mandatory restrictions on any other dimension, including the salesperson lock, return a restricted state without
counts because the source cannot enforce them.

Before the first successful message load, the response is `waiting` with null totals. The page shows
**Waiting for the WhatsApp message data**, without invented numbers. `process_nps_reach_state` is committed with the
message fact so an initially empty but successfully loaded source can correctly show zero. Skipped or failed loads
preserve the last snapshot and its displayed UTC refresh timestamp. An unexpectedly empty source after a previous
nonempty load warns and retains that snapshot. Fixture tests cover states, exclusions, local midnight, missing and
empty sources, deletion/restoration, serving-view reconciliation and transactional rollback.

## 9. Detractor follow-up (pending approval)

Read-only Odoo discovery found no helpdesk module, open follow-up activities, `rating.rating` rows or relevant complaint
fields. Chatter was automated rating notifications, apart from one employee note whose content was not read.
No reliable follow-up reason or resolution timestamp exists in the current source.

The proposed workflow creates one case per detractor through ETL, with an admin-managed reason list, owner, status,
`solved_at`, notes and a separate `nps_followup` permission. This requires business approval before implementation.
Until approved, the reason/status charts show waiting messages and the list shows no follow-up data. No solved times,
reasons or statuses are inferred from rating messages.

## 10. Continuation verification (2026-10-18)

- Business decision: leave follow-up pending; keep `nps_score` and `nps_comments` admin-only, with English UI and Arabic group names.
- Live read-only reconciliation: MATCH, 152 full source rows / 9 low-rating rows, 133 ratings (50 Promoters, 76 Passives,
  7 Detractors). The WhatsApp table remains absent, so reach is explicitly skipped during reconciliation and waiting in the UI.
- Signed-in browser: 11–17 October, all customer groups, Majaal → 18 responders, NPS 38.89, CSAT 94.44, matching the script.
  Default B2B+B2C correctly gives 127 year-to-date responders; clearing that filter gives all 133.
- Layout checked at 1440px and 390px; no document horizontal overflow. The trend controls now wrap below the title on
  phones; the detractor table scrolls within its card. Ratings and reach remain separate when there are no ratings.
- Backend: full suite 649 passed before the additional empty-snapshot test, which also passes; nine read-only warehouse
  tests pass. Frontend: full suite 386 passed. ETL: full suite 474 passed, one skipped, one existing Windows-only failure
  (`test_wrong_case_file_name_gets_a_near_match_hint`, because Windows filenames ignore case); focused NPS tests 48 passed.
- Repository-wide lint still reports pre-existing errors (including admin-page apostrophes, backend TypeScript ESLint
  configuration, and missing shared-UI ESLint configuration). These are separate from the reach implementation.
- Production frontend/backend build passes. Changed frontend files pass targeted lint; 23 relevant frontend tests pass
  after the final responsive-header and filter-provider changes.
- Migration 0050 is applied locally. No source table, permission grant, remote branch or deployment was changed.

For Windows reconciliation, the ETL `.env` may use Docker's `host.docker.internal` warehouse address. Export the local
warehouse `DB_*` settings from `backend/.env` into the process first; keep the NPS source profile from `data/etl/.env`.
The source remains read-only. Local browser checks use frontend port 3100 and backend 4100, with 3100 in the backend's
process-local `FRONTEND_ORIGIN`; all ETL schedules are disabled for that preview.
