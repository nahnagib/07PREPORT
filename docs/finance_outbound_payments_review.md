# Outbound customer payments in receivables: review for finance (2026-10-04)

For review only. No ETL logic was changed; every amount is Odoo's own open residual on the receivable account.

- **Source:** the receivable snapshot of 2026-10-04 (`fact_finance_receivable_snapshot`, run `17107826`).
- **Script:** `data/etl/scripts/finance/outbound_payments_review.py` (read-only).
- **Full list:** [`finance_outbound_payments_review.csv`](finance_outbound_payments_review.csv), one row per payment line.
- **Lines without a partner:** [`finance_receivable_lines_without_partner.csv`](finance_receivable_lines_without_partner.csv).

## Summary

| | Lines | Open amount |
|---|---|---|
| Outbound customer payments (Odoo: Send / Customer) | **6,643** | **53,657,983.84** |
| Inbound customer payments (Receive / Customer) | 695 | −8,295,525.19 |
| Outbound vendor payments (Send / Vendor) | 3 | 21,760.00 |
| **Whole receivable snapshot (net)** | 17,634 | 53,477,866.99 |

An outbound payment to a customer *debits* the customer's receivable, so in Odoo it is money the customer owes. The
6,643 outbound payments add up to more than the whole net balance.

**Most of them are not customer sales debt.** Their memos and partners describe:

- personal withdrawals;
- salaries;
- custody advances for projects and showrooms;
- inter-company debts;
- transport and zakat.

These were all posted as outbound customer payments from the cash and bank journals, against partners that are
staff, owners, custody accounts or the companies themselves. Only 47 lines (1.27M) look like a mispost or a missed
reconciliation (section 7).

## 1. By company and journal (top 15)

| Company | Journal | Lines | Open amount | Share |
|---|---|---|---|---|
| Majaal | Cash - عبدالهادي | 1,094 | 11,123,575.00 | 20.7% |
| Majaal | التجارة والتنمية - Majaal | 383 | 8,889,474.81 | 16.6% |
| Majaal | حسين الشيباني | 140 | 7,056,195.00 | 13.2% |
| Tika | التجارة والتنمية- Tika | 138 | 5,194,508.75 | 9.7% |
| Majaal | Ahmed Layas | 338 | 2,524,015.00 | 4.7% |
| Majaal | Cash - Hussain | 492 | 2,302,250.00 | 4.3% |
| Majaal | Cash-Center | 355 | 2,000,559.17 | 3.7% |
| Tika | خزينة رواد | 424 | 1,767,635.27 | 3.3% |
| Majaal | Cash - رواد | 271 | 1,628,490.00 | 3.0% |
| Majaal | Cash - مهند | 264 | 1,580,116.10 | 2.9% |
| Majaal | Cash - حمزة | 326 | 1,504,915.00 | 2.8% |
| Majaal | Dubai €€€€ | 17 | 928,136.33 | 1.7% |
| Majaal | Cash - Abduramad | 460 | 832,301.25 | 1.6% |
| Majaal | Dubai $$$$ | 6 | 747,640.00 | 1.4% |
| Majaal | التجارة والتنمية - الشيباني - Majaal | 5 | 557,584.00 | 1.0% |

By company: Majaal 5,466 lines (45,249,753.88, 84.3%); Tika 1,177 lines (8,408,229.96, 15.7%).

## 2. By user (who created the payment in Odoo, top 10) and by the customer's salesperson

| Created by | Lines | Open amount | Share |
|---|---|---|---|
| Yousef Abdelhadi | 1,708 | 21,085,159.03 | 39.3% |
| Rwad | 1,187 | 12,108,678.96 | 22.6% |
| Ahmed Layas | 970 | 11,491,764.41 | 21.4% |
| Hussain.elkhateb | 483 | 2,071,415.00 | 3.9% |
| hamza.gadir | 281 | 1,395,975.00 | 2.6% |
| Muhaned | 175 | 1,263,331.10 | 2.4% |
| Abdelrahman Ramad | 365 | 713,911.25 | 1.3% |
| (not readable) | 216 | 579,816.84 | 1.1% |
| Muhaned Eljahawi | 70 | 410,820.00 | 0.8% |
| Marwan Alabbar T | 91 | 391,005.00 | 0.7% |

The customer's salesperson of record is "Unassigned" for 5,574 lines (30.3M) and Ahmed Layas for 1,052 lines
(23.3M). The rest is negligible.

## 3. By year of the payment

| Year | Lines | Open amount |
|---|---|---|
| 2021 | 532 | 2,248,093.32 |
| 2022 | 964 | 3,965,065.93 |
| 2023 | 1,411 | 10,262,449.25 |
| 2024 | 1,131 | 13,874,179.44 |
| 2025 | 1,414 | 11,227,869.28 |
| 2026 | 1,191 | 12,080,326.62 |

The per-month breakdown is in the CSV (`month` column). Amounts are spread over every month from 2021; no single
month exceeds 3.7%.

## 4. Payment state

| Odoo state | Reconciled | Matched with a bank statement | Lines | Open amount |
|---|---|---|---|---|
| posted | – | yes | 6,626 | 53,642,802.84 |
| posted | yes | yes | 9 | 12,615.00 |
| posted | – | – | 8 | 2,566.00 |

Every one is a *posted* payment. Almost all are matched on the cash or bank side but not reconciled on the receivable
side, which is why they stay open in the Aged Receivable.

## 5. Memo / reference patterns

The memo is `account.payment.ref`. These are keyword groups, used for grouping only.

| Memo group | Lines | Open amount | Share |
|---|---|---|---|
| Personal withdrawal (مسحوبات شخصية) | 962 | 15,385,011.70 | 28.7% |
| Salary (مرتب شهر …) | 2,358 | 7,530,554.40 | 14.0% |
| Project / construction (مشروع، اعمال، تأسيس) | 71 | 5,246,697.00 | 9.8% |
| Custody / advance (عهدة، سلفة) | 391 | 2,562,366.60 | 4.8% |
| Invoice reference | 87 | 1,269,161.75 | 2.4% |
| Transport (نقل، شحن) | 607 | 736,269.00 | 1.4% |
| Zakat (زكاة) | 230 | 554,380.00 | 1.0% |
| Transfer, cash, refund, numbers, cheque | 53 | 293,117.76 | 0.5% |
| Empty | 335 | 3,810,316.59 | 7.1% |
| Other text | 1,549 | 16,270,109.04 | 30.3% |

**Most frequent memos:**

| Memo | Lines |
|---|---|
| مسحوبات شخصية (personal withdrawals) | 736 |
| (empty) | 335 |
| نقل (transport) | 129 |
| زكاة (zakat) | 112 |
| مرتب شهر مايو 2025م (salary, May 2025) | 86 |
| قيمة نقل بضائع مصراته (Misrata freight) | 77 |
| مرتب شهر فبراير 2025م (salary, February 2025) | 75 |
| مرتب شهر ابريل 2025م (salary, April 2025) | 63 |
| عهدة المعرض الرئيسي (main showroom custody) | 57 |

The salary memos repeat month by month.

## 6. Top 20 partners

| CustomerKey (Odoo partner) | Partner | Lines | Open amount | Share |
|---|---|---|---|---|
| 3576 | ahmed.benmussa | 610 | 20,826,497.45 | 38.8% |
| 4742 | مصروفات تحت التسوية (expenses under settlement) | 1,314 | 4,767,952.00 | 8.9% |
| 25104 | عهدة تأسيس معرض طريق طرابلس (showroom set-up custody) | 19 | 2,288,169.00 | 4.3% |
| 8 | Ahmed Layas | 207 | 2,147,234.49 | 4.0% |
| 5015 | عبدالرحمن الكوافي ( مؤجر ) (landlord) | 18 | 1,531,400.00 | 2.9% |
| 15907 | مديونية شركة تيكا (Tika company debt) | 46 | 1,334,970.00 | 2.5% |
| 4335 | عبدالسلام جابر المجبري | 17 | 1,291,070.00 | 2.4% |
| 3661 | محمد عزوز | 126 | 1,138,180.00 | 2.1% |
| 24478 | عهدة تأسيس المبنى الإداري (admin building custody) | 5 | 1,098,010.00 | 2.0% |
| 15905 | مديونية مجال (Majaal debt) | 14 | 960,165.00 | 1.8% |
| 3742 | احمد عزوز | 93 | 944,110.00 | 1.8% |
| 3572 | Muhaned Eljahawi | 130 | 851,950.00 | 1.6% |
| 3571 | Mohamed Eljhawi | 119 | 624,946.60 | 1.2% |
| 18837 | عهدة شحن داخلي (domestic shipping custody) | 45 | 605,860.00 | 1.1% |
| 25354 | عهدة تأسيس معرض مجال طريق طرابلس | 4 | 579,090.00 | 1.1% |
| 24349 | الاعتماد المستندي (letter of credit) | 2 | 536,056.75 | 1.0% |
| 17771 | محمد سالم رافع زيو | 3 | 500,000.00 | 0.9% |
| 3577 | mutaz.krema | 73 | 440,310.00 | 0.8% |
| 24499 | عهدة المصنع الجديد (new factory custody) | 14 | 388,205.00 | 0.7% |
| 18143 | Mostafa Abdelrazek | 23 | 383,450.00 | 0.7% |

There are 742 partners in all. The partners **مديونية شركة تيكا** (15907) and **مديونية مجال** (15905) are
inter-company balances under their own partners. They are not the companies' own partner records (Majaal = partner 1,
TIKA = 9313), so `is_intercompany` does not flag them (2.30M). Proposal: a configurable list of extra inter-company
partner ids. Your call.

## 7. Likely mispost or missed reconciliation

**Test.** For each outbound customer payment, the script looks for one of these, for the same customer and company,
dated within ±7 days:

- an unreconciled *inbound* payment of exactly the same amount, or
- an open *customer invoice* with exactly the same residual.

| Result | Lines | Open amount |
|---|---|---|
| matching inbound payment | 47 | 1,273,067.00 |
| matching open invoice | 1 | 3,760.00 |
| no match | 6,595 | 52,381,156.84 |

A matching inbound payment usually means a payment and its reversal (or a receipt and a pay-out) that were never
reconciled against each other. Both stay open and cancel out in the customer's net balance, but not in the line
counts or the overdue buckets. The CSV gives the matching ids (`matching_inbound_payment_ids`,
`matching_open_invoice_move_ids`).

## 8. Sample documents (Odoo ids)

Open a payment in Odoo with `/web#model=account.payment&id=<PaymentKey>&view_type=form`, and a journal entry with
`/web#model=account.move&id=<move_id>&view_type=form`.

**With a match (the 10 largest):**

| account.payment id | Payment | account.move id | Company | Journal | Date | Open amount | Partner | Memo | Matching inbound payment id |
|---|---|---|---|---|---|---|---|---|---|
| 26465 | CS11/2023/10/0026 | 127904 | Majaal | Ahmed Layas | 2023-10-25 | 350,000.00 | ahmed.benmussa | قيمة لصالح مشروع القوارشة ( ايكو هاوس ) | 26464 |
| 18922 | CSH1/2023/02/0031 | 94312 | Majaal | Cash-Center | 2023-02-22 | 300,000.00 | ahmed.benmussa | دفعة لايكو هاوس ( القوارشة ) | 18921 |
| 96905 | BNK1/2026/09/0270 | 462457 | Majaal | التجارة والتنمية - Majaal | 2026-09-20 | 175,000.00 | علي حسلوك | ترجيع قيمة | 96904 |
| 42384 | CS25/2024/08/0059 | 204256 | Majaal | Cash - عبدالهادي | 2024-08-27 | 100,000.00 | ahmed.benmussa | مسحوبات شخصية … ( دفعه رقم 33 عن مشروع الفيلات ) | 42383 |
| 92706 | CS25/2026/07/0006 | 443024 | Majaal | Cash - عبدالهادي | 2026-07-01 | 70,000.00 | مديونية شركة تيكا | (empty) | 92708 |
| 61698 | CH66 /2025/05/0043 | 301885 | Tika | CASH / عبدالسلام عمر | 2025-05-25 | 60,000.00 | طه المقصبي | دفع القيمة الي طه المقصبي | 61613 |
| 73535 | BNK1/2025/10/0015 | 350785 | Majaal | التجارة والتنمية - Majaal | 2025-10-02 | 47,850.00 | شركة محاور الخير | (empty) | 73531 |
| 73882 | BNK1/2025/09/0170 | 351892 | Majaal | التجارة والتنمية - Majaal | 2025-09-28 | 20,815.00 | Ahmed Layas | زهير امنيسي | 73193 |
| 88128 | BNK1/2026/05/0277 | 421699 | Majaal | التجارة والتنمية - Majaal | 2026-05-10 | 19,370.00 | شركة بوابة قورينا للمقاولات العامة | (empty) | 88026 |
| 85486 | BNK1/2026/04/0010 | 406893 | Majaal | التجارة والتنمية - Majaal | 2026-04-01 | 17,330.00 | عزالدين عيسى ادريس | (empty) | 85410 |

**Without a match (the 10 largest):**

| account.payment id | Payment | account.move id | Company | Journal | Date | Open amount | Partner | Memo |
|---|---|---|---|---|---|---|---|---|
| 21405 | CSH1 /2023/06/0004 | 106047 | Majaal | حسين الشيباني | 2023-06-07 | 500,000.00 | ahmed.benmussa | دفعة لموقع القوارشة |
| 84867 | BNK1/2026/02/0363 | 404378 | Majaal | التجارة والتنمية - Majaal | 2026-02-14 | 434,000.00 | عهدة تأسيس المبنى الإداري | الدفعة الثانية من اعمال تأسيس المبنى الاداري |
| 84661 | BNK1/2026/01/0349 | 403620 | Majaal | التجارة والتنمية - Majaal | 2026-01-26 | 426,000.00 | عهدة تأسيس المبنى الإداري | الدفعة الاولى من اعمال تأسيس المبنى الاداري |
| 89527 | BNK1/2026/05/0496 | 427667 | Tika | التجارة والتنمية- Tika | 2026-05-30 | 400,000.00 | عهدة تأسيس معرض طريق طرابلس | دفعة الخامسة لاعمال الانشائية للمعرض |
| 39534 | BD$1/2024/05/0008 | 190706 | Majaal | Dubai $$$$ | 2024-05-28 | 358,400.00 | ahmed.benmussa | ارباح رافت الجربي 2023 م |
| 73893 | BNK1/2025/10/0045 | 351923 | Majaal | التجارة والتنمية - Majaal | 2025-10-01 | 350,000.00 | ahmed.benmussa | اقفال قيمة مشروع فيلات القوارشة |
| 46142 | CSH1 /2024/10/0001 | 221145 | Majaal | حسين الشيباني | 2024-10-12 | 324,650.00 | ahmed.benmussa | الدفعة رقم 36 لمشروع القوارشة |
| 94408 | BNK1/2026/07/0480 | 450919 | Tika | التجارة والتنمية- Tika | 2026-07-12 | 303,338.09 | الاعتماد المستندي | اقفال حساب فاتورة كريسماكم رقم1 |
| 41608 | CSH1 /2024/08/0001 | 200243 | Majaal | حسين الشيباني | 2024-08-13 | 300,000.00 | ahmed.benmussa | مسحوبات شخصية … ( دفعه رقم 31 عن مشروع الفيلات ) |
| 42300 | CS25/2024/08/0057 | 203757 | Majaal | Cash - عبدالهادي | 2024-08-26 | 300,000.00 | ahmed.benmussa | مسحوبات شخصية … ( دفعه رقم 32 عن مشروع الفيلات ) |

## 9. Receivable lines without a partner (42 lines, −66,279.38)

All 42 are journal entries (`move_type = entry`). They sit on customer `-1` (Unknown) in the snapshot. The full list
with Odoo ids is in [`finance_receivable_lines_without_partner.csv`](finance_receivable_lines_without_partner.csv).

| Company | Journal | Lines | Amount | First | Last |
|---|---|---|---|---|---|
| Majaal | Cash - الطرابلسي | 3 | 230.00 | 2025-01-27 | 2026-08-23 |
| Majaal | Cash - مهند | 1 | 7,500.00 | 2021-04-05 | 2021-04-05 |
| Majaal | Daily transfers | 2 | −7,500.00 | 2023-11-16 | 2026-03-11 |
| Majaal | تسوية المصروفات اليومية | 3 | −27,010.28 | 2024-02-07 | 2025-02-17 |
| Majaal | جاري الموظفين | 1 | 890.00 | 2023-03-08 | 2023-03-08 |
| Tika | CASH / اشرف | 5 | 460.00 | 2025-05-03 | 2025-11-12 |
| Tika | CASH / بلعيد | 4 | 4,230.00 | 2024-12-19 | 2025-12-07 |
| Tika | CASH / عبدالسلام عمر | 3 | 180.00 | 2025-10-02 | 2026-02-14 |
| Tika | CASH / مفتاح | 5 | 1,750.00 | 2024-01-25 | 2025-09-15 |
| Tika | CASH / مكي | 8 | 1,225.00 | 2024-10-19 | 2026-07-18 |
| Tika | CASH / يوسف | 5 | 590.00 | 2024-07-17 | 2025-09-27 |
| Tika | يومية الاصول الثابتة والمصاريف المقدمة ( تيكا ) | 1 | −28,674.10 | 2026-05-31 | 2026-05-31 |
| Tika | يومية الموظفين | 1 | −20,150.00 | 2025-02-28 | 2025-02-28 |

The largest single lines:

- `Dytf/2026/03/0002`: −57,500.00 (line 1360451, move 403311);
- `Dytf/2023/11/0008`: +50,000.00 (line 456675, move 131716);
- `MIS2 /2026/05/0034`: −28,674.10 (line 1432627, move 454342);
- `ExpD/2024/11/0092`: −22,170.28 (line 827277, move 251182);
- `MIS4/2025/02/0001`: −20,150.00 (line 927212, move 283173).

## 10. What this means for the Debt page

**No ETL change was made.** The snapshot reports exactly what Odoo's Aged Receivable reports.

These choices are for finance and you:

- Clean up in Odoo: reclassify staff, owner, custody and inter-company items to their own accounts, and reconcile
  the matched pairs.
- Or let the page separate them: payment lines carry `payment_type` and `partner_type`, so the page can split
  "Send / Customer" from customer invoices without any invented label.
