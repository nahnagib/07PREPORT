# BMH 7Ps Dashboard manuals: QA and open items (26 Sep 2026)

## Deliverables
| File | Pages |
|---|---|
| Manual_FullAccess_EN.pdf | 53 |
| Manual_FullAccess_AR.pdf | 56 |
| Manual_Salesperson_EN.pdf | 27 |
| Manual_Salesperson_AR.pdf | 29 |

Source files: `source/src/en` and `source/src/ar` (Markdown), `source/shots` (39 screenshots), `source/build.py` and `source/qa.py` (automatic checks). See `source/README.md` for how to rebuild.

## Revision 2 (26 Sep 2026): changes applied to all four manuals
- **Address:** every dashboard address is now `https://dashboards.benmussaholding.com/Dashboard`. The download troubleshooting line keeps the bare domain.
- **Install as an app:** new tip in *Opening the dashboard*. The phone FAQ now points to it.
- **Changing your password:** self-service steps and URL removed. Users now contact the administrator, the same process as a forgotten password. The note about being signed out elsewhere is kept.
- **Admin content removed:**
  - The "Admin" profile chip is replaced with a neutral "U / User" in 17 full-access screenshots, because no non-admin full-access account was available. The salesperson manuals now use a real salesperson header (`sales_header.png`).
  - The **Admin** link was removed from the sidebar and the bottom tab bar in the layout screenshot.
  - The Pipeline Health **Data Quality** panel was removed (text, screenshot band and marker).
  - The MARCOM **Upload data** button was removed (text item and screenshot).
  - The "Admin Panel > Companies / Customer Groups" wording was removed from the Daily Critical Number caption in the screenshot.
  - The sentence "Administration screens … are not covered here" was removed from the introduction.
  - The "and, for administrators only, Admin" mention was removed from the sidebar description.
- **Tasks sections:** all removed (Tachometer, Critical Number, Revenue Trend, Invoices Engine, Customer Growth). Tips are kept, and no empty headings remain.
- **Arabic layout:** figures and captions now stay inside the page margins. This was checked automatically for every image and text block in both Arabic manuals. The Arabic contents entries end with a right-to-left mark, so "7Ps" no longer runs into the page numbers.
- **Screenshot clean-up:** removed a leftover mouse pointer (Promotion hub) and a white patch (7Ps hub).

## QA checks passed
- **Coverage (rerun for revision 2):** all 16 reports (12 Promotion, 4 Product) are documented in both full-access manuals. Admin is excluded, as agreed. No "Admin Panel", "Data Quality", "Upload data" or "Tasks" text remains. English and Arabic counts are identical: full manuals have 21/51/12 headings (h1/h2/h3), 30 figures and 38 callouts; salesperson manuals have 9/32/5 headings, 11 figures and 26 callouts.
- **Salesperson manuals:** they don't mention any restricted report (checked automatically). Salesperson screenshots were taken from the real salesperson account, and the locked filters and one-row breakdown were confirmed live.
- **English/Arabic parity:** identical counts of chapters, sections, figures, callouts, tables, table rows and list items in each pair.
- **Arabic:** Modern Standard Arabic with a right-to-left layout. Fonts are Noto Naskh Arabic (body) and Cairo (headings), fully embedded. Letters join correctly, with no boxes or reversed text. English UI labels are kept in bold, because the app has no Arabic interface.
- **Screenshots:** light mode, with the mouse pointer and Chrome overlays removed. Salesperson and customer names are replaced with placeholders, and money and volume figures are disguised with a consistent hidden factor. Every screenshot matches the live build as of 26 Sep.
- **Layout:** clickable table of contents with page numbers, running headers and footers with page numbers, and the BMH logo on the cover.

## Screens to retake after the developer's fixes (you'll give the go-ahead)
1. Promotion hub cards (text "Live report, wired to the validation warehouse"): `promotion_hub.png`, `hub.png` if the text changes.
2. Tachometer breakdown, **Needs Attention** card showing "Salesperson" instead of a name: `tach_breakdown.png`. (Names are anonymised in the current shot, so the bug isn't visible, but retake to confirm.)
3. MARCOM pages ("uploaded by tester"): `marcom_filters.png`, `marcom_spending.png`, `marcom_campaigns.png`, `marcom_digital.png`, `marcom_trade.png`.

## Issues found in the app (for the developer)
- **Performance:** Customer Growth took about 3 minutes to load, and Pipeline Health more than 5 minutes. PIM Brand Performance is also slow.
- **Refresh:** a yellow bar reading "Data may be out of date - last successful refresh: Sep 26, 02:50 AM" showed during the day, so the 08:50/11:50 refreshes don't appear to have run. "Last Order Date" was still 24 Sep.
- **Product data:** Stock Velocity, Product Lifecycle and PIM Contribution use a bundled snapshot (data up to 25 Jul 2026). The manuals carry a note, to be removed once this is fixed.
- **Critical Number:** filter lists hang on "Loading…" when the page is opened directly, and keep reloading when it's opened from another report.
- **MARCOM Spending:** "No data for the selected filters" for Jan–Sep 2026, although data up to Sep 2026 is reported as uploaded. The manual screenshot uses Year 2025.
- **Minor:** after **Log out** the page stayed on "Loading..." until the sign-in page was opened manually. The "Full Pipeline" title is overlapped by its buttons. The Portfolio Movement legend labels are cut off ("N", "S.", "I…"). The salesperson's sidebar still lists **Product** (which has nothing for him).

## Needs your input
- **Arabic spelling of the support contact's name:** written as "نهلة بورويص". Please confirm or correct it.
- **Full-access test account:** if you can create a non-admin full-access test account, I can recapture the 17 screenshots whose chip was anonymised to "User".
- When the fixes are live, tell me and I'll retake the screens above and rebuild all four PDFs (the text doesn't need to change).
- If the product data becomes live, remove the "updated manually" notes (three chapters plus one row of the refresh table, in both languages).
