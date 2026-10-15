# Troubleshooting and FAQ

## Common problems

| Problem | Likely cause | What to do |
|---|---|---|
| I can't sign in: **Invalid email or password.** | Wrong email or password, Caps Lock on, or the wrong keyboard language. | Re-type carefully. After 5 wrong attempts your account is locked, so stop and contact the administrator if you are unsure. |
| **Your account is locked. Contact your administrator.** | Too many wrong passwords, or locked by the administrator. | Contact the administrator. |
| I forgot my password. | | Contact the administrator. A reset needs administrator confirmation (see *Forgotten password*). |
| The page only shows **Loading...** | Slow connection, or the session is being checked. | Wait a few seconds. Then reload the page (**F5**). If it continues, sign out and sign in again. |
<!-- only:full -->
| A report shows grey placeholder cards for a long time. | Reports that analyse a lot of data (for example **Customer Growth** or **Pipeline Health**) can take several minutes to load. | Wait. Don't reload the page repeatedly, because each reload starts again. If it still hasn't loaded after 5 minutes, contact support. |
<!-- /only -->
| A chart says **This chart could not load.** or the page says **This page could not load.** | A temporary server or network problem. | Click **Retry**, or reload the page. |
| A card shows **No rows for the current filters.** or **No data for the selected filters** | The filters are too narrow. | Click **Reset filters**<!-- only:full --> (**Reset** on MARCOM pages)<!-- /only -->, or widen the date range. |
| A filter list is greyed out with **No options** | No values exist for your other selections. | Change or reset the other filters. |
| The figures don't include today's latest sales. | The data is refreshed on a schedule. | Check the refresh times (08:50, 11:50, 14:50, 17:50, 20:50) and reload the page after the next refresh. |
| My figures differ from another report or system. | Different filters or date ranges, or data not yet refreshed. | Check both reports use the same **From/To Date**, **Company** and **Customer Group** (the default is B2B + B2C). |
<!-- only:full -->
| A report I expect isn't in the menu. | Your account has no permission for it. Reports you can't open are hidden. | Ask the administrator for access. |
| **You do not have access to this page** | You opened a link to a report you have no permission for. | Ask the administrator to grant you View permission. |
| A MARCOM page says **No MARCOM data uploaded yet** | That month's marketing workbook hasn't been uploaded. | Contact the Marketing department. |
<!-- /only -->
<!-- only:sales -->
| The filters are greyed out with **Locked to your assigned scope**. | This is normal. Salesperson accounts see their own data only. | Use **From Date** and **To Date** to change the period. |
| I see another salesperson's name, or no data at all. | Your account may not be linked to your salesperson record. | Contact the administrator. |
<!-- /only -->
| The screen is dark and hard to read. | The dashboard opens in dark mode. | Click the moon icon in the header to switch to light mode. |
| The export button does nothing. | The browser blocked the download. | Allow downloads for dashboards.benmussaholding.com in your browser settings, then try again. |
| I was signed out unexpectedly. | Your password was changed or reset, or the administrator ended your session. | Sign in again. |

## Frequently asked questions

**Is the data live?**
No. It is refreshed five times a day (08:50, 11:50, 14:50, 17:50 and 20:50), with a full rebuild every night at 02:00.

**Do I need to sign in every day?**
No. There is no automatic time-out, so you stay signed in on that browser until you click **Log out** (see *Session timeout*). Always sign out on shared computers.

**Can I use the dashboard on my phone?**
Yes. Open the same address in your phone's browser. The layout adapts to the smaller screen. You can also install it as an app on your phone (see the tip in *Opening the dashboard*).

**Is there an Arabic interface?**
Not yet. The screens are in English only.

**What does the bell icon do?**
Notifications will be available in a future release. The bell doesn't do anything yet.

**Why does the Tachometer target change every day?**
The target shown on the gauge is the **target-to-date**, the share of the period's target due by the selected date. It grows as the year or month goes on.

**Can I save my filter choices?**
Not at present. Filters stay applied while you move between reports, and go back to their defaults when you reload the page.

<!-- only:full -->
**Why do some reports ignore the Company or Branch filter?**
The MARCOM reports use marketing data with their own filters, and the product reports work on product data, where customer and salesperson filters don't apply.
<!-- /only -->
<!-- only:sales -->
**Why can't I see other salespersons or other reports?**
Salesperson accounts are limited, by design, to your own Tachometer data. This protects everyone's data.
<!-- /only -->
