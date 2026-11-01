"""Builds MARCOM template 2.0 (backend/assets/marcom/MARCOM_Contribution_Data_Template.xlsx) in place.

    python backend/scripts/build_marcom_template.py

Rebuilds 'P1 - MARCOM Spending', the new 'P1b - Other MARCOM Spending', 'P3 - Digital Performance' and the hidden
'Lists' sheet, refreshes the Instructions text, and points every Brand dropdown at Lists!A2:A30. P2 and P4 are kept
as they are. Safe to run again on its own output. Column positions must match backend/src/marcom/templateConfig.ts
(the parser refuses a file whose headers moved) -- change both together.

Conventions: Yellow = input (unlocked), Grey = formula (locked, sheet protected without a password), Green = example.
Header help is an input message (shown when the header cell is selected), not a cell comment: ExcelJS cannot load
the comment XML openpyxl writes.
"""
import os
import sys
from copy import copy

from openpyxl import load_workbook
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Protection, Side
from openpyxl.styles.differential import DifferentialStyle
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PATH = os.path.join(ROOT, 'assets', 'marcom', 'MARCOM_Contribution_Data_Template.xlsx')

P1, P1B, P2, P3, P4 = 'P1 - MARCOM Spending', 'P1b - Other MARCOM Spending', 'P2 - Media Campaigns', 'P3 - Digital Performance', 'P4 - Trade Marketing'

BRANDS = ['Xtreme', 'Majaal', 'Germa', 'BMH']  # BMH = group events (marcom_brand.kind = GROUP), not a brand
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
PLATFORMS = ['Facebook', 'Google', 'LinkedIn', 'Instagram', 'TikTok']
CATEGORIES = ['Uniforms', 'Printing & Printouts', 'Gifts & Giveaways', 'Events & Sponsorships', 'Branding & Signage',
              'POS / Merchandising Materials', 'Photography & Production', 'Agency / Freelancer Fees', 'Other']
BRAND_LIST = 'Lists!$A$2:$A$30'
MONTH_LIST = 'Lists!$B$2:$B$13'
PLATFORM_LIST = 'Lists!$C$2:$C$6'
CATEGORY_LIST = 'Lists!$I$2:$I$30'

NAVY, WHITE, GREYTXT = '1F3864', 'FFFFFF', '595959'
F_INPUT, F_CALC, F_EXAMPLE, F_DEF = 'FFF2CC', 'F2F2F2', 'E2EFDA', 'DDEBF7'
THIN = Side(style='thin', color='BFBFBF')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
fill = lambda c: PatternFill('solid', fgColor=c)

RAG = {
    'Green': DifferentialStyle(fill=PatternFill(bgColor='C6EFCE'), font=Font(color='006100')),
    'Yellow': DifferentialStyle(fill=PatternFill(bgColor='FFEB9C'), font=Font(color='9C6500')),
    'Red': DifferentialStyle(fill=PatternFill(bgColor='FFC7CE'), font=Font(color='9C0006')),
}
RED_DXF = DifferentialStyle(fill=PatternFill(bgColor='FFC7CE'), font=Font(color='9C0006', bold=True))


def q(sheet):
    return "'" + sheet + "'"


def v(ref):
    """Number in a cell even when it was typed/pasted as text (e.g. '2100000' + line break) -- 0 when empty."""
    return f'IFERROR(VALUE(TRIM(CLEAN({ref}))),0)'


def recreate(wb, name, index):
    if name in wb.sheetnames:
        index = wb.sheetnames.index(name)
        del wb[name]
    return wb.create_sheet(name, index)


def titles(ws, title, subtitle):
    ws['A1'] = title
    ws['A1'].font = Font(size=14, bold=True, color=NAVY)
    ws['A2'] = subtitle
    ws['A2'].font = Font(size=10, color=GREYTXT)
    ws['A3'] = 'Legend: Yellow = enter data | Grey = auto-calculated (do not edit) | Green row = example (delete before sending)'
    ws['A3'].font = Font(size=10, color=GREYTXT)
    ws.sheet_view.showGridLines = False


def table_title(ws, row, text):
    ws.cell(row, 1, text).font = Font(size=11, bold=True, color=NAVY)


def header(ws, row, labels, comments=None):
    for i, label in enumerate(labels, 1):
        c = ws.cell(row, i, label)
        c.fill = fill(NAVY)
        c.font = Font(size=10, bold=True, color=WHITE)
        c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        c.border = BORDER
        if comments and i in comments:
            # A pop-up "input message" when the header is selected -- the same help as a cell comment, but ExcelJS
            # (our parser) cannot read the comment XML openpyxl writes, so no real comments in this file.
            d = DataValidation(allow_blank=True, showInputMessage=True, promptTitle=str(label).split(' (')[0][:32], prompt=comments[i][:255])
            d.add(c.coordinate)
            ws.add_data_validation(d)
    ws.row_dimensions[row].height = 45


def style_cell(c, kind, fmt='General'):
    c.fill = fill({'input': F_INPUT, 'calc': F_CALC, 'example': F_EXAMPLE}[kind])
    c.border = BORDER
    c.font = Font(size=10)
    c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=False)
    c.number_format = fmt
    c.protection = Protection(locked=(kind == 'calc'))


def body(ws, first, last, n_input, formulas, formats, example=None):
    """Rows first..last: columns 1..n_input yellow inputs, then grey formulas (callables of the row number)."""
    for r in range(first, last + 1):
        is_ex = example is not None and r == first
        for col in range(1, n_input + 1):
            c = ws.cell(r, col)
            if is_ex and col - 1 < len(example):
                c.value = example[col - 1]
            style_cell(c, 'example' if is_ex else 'input', formats.get(col, 'General'))
        for i, f in enumerate(formulas):
            col = n_input + 1 + i
            c = ws.cell(r, col, f(r))
            style_cell(c, 'example' if is_ex else 'calc', formats.get(col, 'General'))
        ws.row_dimensions[r].height = 18


def rag(ws, rng):
    for word, dxf in RAG.items():
        rule = CellIsRule(operator='equal', formula=[f'"{word}"'])
        rule.dxf = dxf
        ws.conditional_formatting.add(rng, rule)


def dv_list(ws, rng, src, title, msg):
    d = DataValidation(type='list', formula1=f'={src}', allow_blank=True, showErrorMessage=True, errorTitle=title, error=msg)
    d.add(rng)
    ws.add_data_validation(d)


def dv_number(ws, rng, whole=False):
    d = DataValidation(type='whole' if whole else 'decimal', operator='greaterThanOrEqual', formula1='0', allow_blank=True,
                       showErrorMessage=True, errorTitle='Number only',
                       error='Type a number only (no text, no spaces, no line breaks). Use 0 if there was none.')
    d.add(rng)
    ws.add_data_validation(d)


def dv_year(ws, rng):
    d = DataValidation(type='whole', operator='between', formula1='2020', formula2='2100', allow_blank=True,
                       showErrorMessage=True, errorTitle='Year', error='Enter a year like 2026.')
    d.add(rng)
    ws.add_data_validation(d)


def protect(ws):
    p = ws.protection
    p.sheet = True
    p.formatColumns = False
    p.formatRows = False
    p.formatCells = False
    p.sort = False
    p.autoFilter = False
    p.insertRows = True
    p.deleteRows = True


def widths(ws, w):
    for col, width in w.items():
        ws.column_dimensions[col].width = width


def status3(ref, green, yellow, higher_better=True):
    if higher_better:
        return f'=IFERROR(IF(ISNUMBER({ref}),IF({ref}>{green},"Green",IF({ref}>={yellow},"Yellow","Red")),""),"")'
    return f'=IFERROR(IF(ISNUMBER({ref}),IF({ref}<={green},"Green",IF({ref}<={yellow},"Yellow","Red")),""),"")'


# ------------------------------------------------------------------------------------------------ P1
P1_HEADER, P1_FIRST, P1_LAST = 13, 14, 114
P1B_FIRST, P1B_LAST = 7, 306  # data rows (row 6 = example, left out of every grey total)
P2_FIRST, P2_LAST = 7, 25


def build_p1(wb):
    ws = recreate(wb, P1, 1)
    titles(ws, 'Page 1 — MARCOM Spending',
           'One row per Month per Brand — monthly figures only, never YTD. Non-campaign spend goes on the '
           "'P1b - Other MARCOM Spending' tab. Grey columns (N onward) calculate automatically.")
    ws.cell(4, 1, 'Definitions — what goes in each yellow column').font = Font(size=11, bold=True, color=NAVY)
    defs = [
        ('Brand Revenue – Current Month', "Sales of THIS brand's products only, for that month (e.g. Xtreme ≈ 3,000,000 — not Tika's 8,000,000 company total)."),
        ('Brand Revenue – Same Month Last Year', 'The same figure (this brand only) for the same month one year earlier.'),
        ('Revenue Attributed to Marketing', 'The part of Brand Revenue that came from marketing (campaign codes, promo sales, tracked leads). Never more than Brand Revenue.'),
        ('Company Total Revenue (optional)', "The whole company's sales that month (e.g. Tika 8,000,000). Only used for Brand Share %. Leave empty if not needed."),
        ('Finance Booked MARCOM Total (optional)', 'Total MARCOM cost finance booked for this brand and month. Compared with Campaign + Other spend: the difference shows as Unallocated (red when not 0).'),
        ('No YTD, no totals', 'Never type YTD or Total MARCOM Spend: the dashboard adds the months up, and Total = Campaign Spend (P2, split by days) + Other Spend (P1b).'),
        ('BMH rows', 'BMH = group events, not a brand: enter spend-related columns only and leave the three revenue columns empty.'),
    ]
    for i, (term, text) in enumerate(defs):
        r = 5 + i
        ws.cell(r, 1, term).font = Font(size=10, bold=True)
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
        ws.cell(r, 4, text).font = Font(size=10)
        ws.merge_cells(start_row=r, start_column=4, end_row=r, end_column=13)
        for col in range(1, 14):
            ws.cell(r, col).fill = fill(F_DEF)
        ws.cell(r, 1).alignment = Alignment(vertical='center', wrap_text=True)
        ws.cell(r, 4).alignment = Alignment(vertical='center', wrap_text=True)
        ws.row_dimensions[r].height = 30

    labels = ['Year', 'Month', 'Brand',
              'Brand Revenue – Current Month (LYD)', 'Brand Revenue – Same Month Last Year (LYD)', 'Revenue Attributed to Marketing (LYD)',
              'Company Total Revenue – Current Month (LYD, optional)', 'Budget Allocated (LYD)', 'Finance Booked MARCOM Total (LYD, optional)',
              '# of New Customers', 'Avg Sales per Invoice (LYD)', 'Total Cost of Social Media Posts (LYD)', 'Total Clicks (#)',
              'Campaign Spend (LYD)', 'Other MARCOM Spend (LYD)', 'Total MARCOM Spend (LYD)', 'Unallocated (LYD)',
              'ROI Ratio (Revenue : Spend)', 'ROI Status', 'Budget Utilization %', 'Brand Growth % (YoY)', 'Marketing-Attributed %',
              'Brand Share of Company %', 'CAC (LYD)', 'CAC % of Sales/Invoice', 'CAC Status', 'CPC (LYD)', 'CPC Status']
    comments = {
        3: 'Pick the brand from the list. BMH = group events (not a brand).',
        4: "Sales of THIS brand's products only, this month. Not the company total, not YTD.",
        5: 'This brand only, same month last year. Not YTD.',
        6: 'Part of Brand Revenue that came from marketing (campaign codes, promo sales, tracked leads). Must be <= Brand Revenue.',
        7: "Optional. The whole company's sales this month (e.g. Tika). Used only for Brand Share %.",
        8: 'Planned MARCOM budget for this brand and month.',
        9: 'Optional. MARCOM total booked by finance for this brand/month. Unallocated = this - (Campaign + Other).',
        14: 'Calculated: P2 campaign spend of this brand, split over the months each campaign runs (by days).',
        15: "Calculated: sum of this brand's lines on the P1b tab for this month.",
        16: 'Calculated: Campaign Spend + Other MARCOM Spend. Used for ROI, budget utilization and CAC.',
        17: 'Calculated: Finance Booked Total - Total MARCOM Spend. Red = spend not explained yet.',
    }
    header(ws, P1_HEADER, labels, comments)

    p2 = q(P2)
    rng = lambda col: f"{p2}!${col}${P2_FIRST}:${col}${P2_LAST}"
    B, S, E, Fs = rng('B'), rng('C'), rng('D'), rng('F')

    def campaign(r):
        ms = f'DATE($A{r},MATCH($B{r},{MONTH_LIST},0),1)'
        me = f'EOMONTH({ms},0)'
        lo = f'({S}+({ms}-{S})*({ms}>{S}))'
        hi = f'({E}+({me}-{E})*({me}<{E}))'
        return (f'=IF(OR($A{r}="",$B{r}="",$C{r}=""),"",IFERROR(SUMPRODUCT(({B}=$C{r})*({S}<>"")*({E}<>"")*{Fs}'
                f'*({hi}-{lo}+1)*(({hi}-{lo})>=0)/({E}-{S}+1)),"check P2"))')

    p1b = q(P1B)
    o = lambda col: f'{p1b}!${col}${P1B_FIRST}:${col}${P1B_LAST}'
    formulas = [
        campaign,
        lambda r: f'=IF(OR($A{r}="",$B{r}="",$C{r}=""),"",SUMIFS({o("G")},{o("A")},$A{r},{o("B")},$B{r},{o("C")},$C{r}))',
        lambda r: f'=IF($C{r}="","",N($N{r})+N($O{r}))',
        lambda r: f'=IF(OR($C{r}="",$I{r}=""),"",$I{r}-$P{r})',
        lambda r: f'=IFERROR(IF($P{r}>0,$F{r}/$P{r},""),"")',
        lambda r: status3(f'R{r}', 5, 3),
        lambda r: f'=IFERROR(IF($H{r}>0,$P{r}/$H{r},""),"")',
        lambda r: f'=IFERROR(($D{r}-$E{r})/$E{r},"")',
        lambda r: f'=IFERROR($F{r}/$D{r},"")',
        lambda r: f'=IF($G{r}="","",IFERROR($D{r}/$G{r},""))',
        lambda r: f'=IFERROR(IF(AND($J{r}>0,N($P{r})>0),$P{r}/$J{r},""),"")',
        lambda r: f'=IFERROR($X{r}/$K{r},"")',
        lambda r: status3(f'Y{r}', 0.03, 0.05, higher_better=False),
        lambda r: f'=IFERROR($L{r}/$M{r},"")',
        lambda r: f'=IFERROR(IF(ISNUMBER(AA{r}),IF(AA{r}<2.5,"Green",IF(AA{r}<=5,"Yellow","Red")),""),"")',
    ]
    money = '#,##0'
    pct = '0.0%'
    formats = {4: money, 5: money, 6: money, 7: money, 8: money, 9: money, 10: '#,##0', 11: money, 12: money, 13: '#,##0',
               14: money, 15: money, 16: money, 17: money, 18: '0.0', 20: pct, 21: pct, 22: pct, 23: pct, 24: '#,##0.00', 25: pct, 27: '#,##0.00'}
    example = [2026, 'September', 'Xtreme', 3000000, 2600000, 450000, 8000000, 120000, None, 150, 7500, 500, 60000]
    body(ws, P1_FIRST, P1_LAST, 13, formulas, formats, example)

    rag(ws, f'S{P1_FIRST}:S{P1_LAST}')
    rag(ws, f'Z{P1_FIRST}:Z{P1_LAST}')
    rag(ws, f'AB{P1_FIRST}:AB{P1_LAST}')
    ws.conditional_formatting.add(f'Q{P1_FIRST}:Q{P1_LAST}', FormulaRule(formula=[f'AND(ISNUMBER(Q{P1_FIRST}),ABS(Q{P1_FIRST})>=0.005)'], stopIfTrue=True, font=RED_DXF.font, fill=RED_DXF.fill))

    data = f'{P1_FIRST}:{P1_LAST}'
    dv_year(ws, f'A{P1_FIRST}:A{P1_LAST}')
    dv_list(ws, f'B{P1_FIRST}:B{P1_LAST}', MONTH_LIST, 'Month', 'Pick a month from the list.')
    dv_list(ws, f'C{P1_FIRST}:C{P1_LAST}', BRAND_LIST, 'Brand', 'Pick a brand from the list.')
    for col in 'DEGHIKL':
        dv_number(ws, f'{col}{P1_FIRST}:{col}{P1_LAST}')
    for col in 'JM':
        dv_number(ws, f'{col}{P1_FIRST}:{col}{P1_LAST}', whole=True)
    d = DataValidation(type='custom', formula1=f'=OR(F{P1_FIRST}="",D{P1_FIRST}="",AND(ISNUMBER(F{P1_FIRST}),F{P1_FIRST}>=0,F{P1_FIRST}<=D{P1_FIRST}))',
                       allow_blank=True, showErrorMessage=True, errorTitle='Revenue Attributed to Marketing',
                       error='Must be a number and not more than Brand Revenue – Current Month (it is the part of Brand Revenue that came from marketing).')
    d.add(f'F{P1_FIRST}:F{P1_LAST}')
    ws.add_data_validation(d)
    del data

    widths(ws, {'A': 8, 'B': 12, 'C': 12, 'D': 17, 'E': 17, 'F': 17, 'G': 17, 'H': 14, 'I': 16, 'J': 11, 'K': 13, 'L': 15, 'M': 12,
                'N': 15, 'O': 15, 'P': 15, 'Q': 15, 'R': 11, 'S': 10, 'T': 12, 'U': 12, 'V': 13, 'W': 13, 'X': 11, 'Y': 12, 'Z': 10, 'AA': 9, 'AB': 10})
    ws.freeze_panes = f'D{P1_FIRST}'
    protect(ws)


# ------------------------------------------------------------------------------------------------ P1b
def build_p1b(wb):
    ws = recreate(wb, P1B, wb.sheetnames.index(P1) + 1)
    titles(ws, 'Page 1b — Other MARCOM Spending (non-campaign)',
           'One row per expense line that is NOT part of a campaign: uniforms, printouts, gifts, sponsorships … '
           'P1 adds these up per Year + Month + Brand (column O) and compares Campaign + Other with the finance-booked total.')
    table_title(ws, 4, 'Table — Other MARCOM Spending (Non-Campaign)')
    header(ws, 5, ['Year', 'Month', 'Brand', 'Category', 'Description', 'Vendor / Supplier (optional)', 'Amount (LYD)', 'Notes (optional)'],
           {4: 'Pick from the list (edit the list on the Lists tab, column I, and in the dashboard admin).',
            5: 'What was bought, e.g. "Staff polo shirts – showroom team". Make it unique within the month, brand and category.',
            7: 'Amount in LYD for this line.'})
    example = [2026, 'September', 'Xtreme', 'Uniforms', 'Staff polo shirts – showroom team', 'Al-Nour Textiles', 25000, 'Q3 batch']
    body(ws, 6, P1B_LAST, 8, [], {7: '#,##0'}, example)
    for r in range(6, P1B_LAST + 1):
        for col in (5, 6, 8):
            ws.cell(r, col).alignment = Alignment(horizontal='left', vertical='center')
    dv_year(ws, f'A6:A{P1B_LAST}')
    dv_list(ws, f'B6:B{P1B_LAST}', MONTH_LIST, 'Month', 'Pick a month from the list.')
    dv_list(ws, f'C6:C{P1B_LAST}', BRAND_LIST, 'Brand', 'Pick a brand from the list.')
    dv_list(ws, f'D6:D{P1B_LAST}', CATEGORY_LIST, 'Category', 'Pick a category from the list.')
    dv_number(ws, f'G6:G{P1B_LAST}')
    widths(ws, {'A': 8, 'B': 12, 'C': 12, 'D': 26, 'E': 40, 'F': 24, 'G': 14, 'H': 30})
    ws.freeze_panes = 'A6'
    protect(ws)


# ------------------------------------------------------------------------------------------------ P3
P3A_FIRST, P3A_LAST = 6, 255
P3B_HEADER, P3B_FIRST, P3B_LAST = 259, 260, 320


def build_p3(wb):
    ws = recreate(wb, P3, wb.sheetnames.index(P2) + 1)
    titles(ws, 'Page 3 — Digital Performance',
           'Table A: one row per Year + Month + Brand + Platform (fill Account / Page Name only when a brand has more than one page '
           f'on the same platform). Table B (row {P3B_HEADER - 1}): website traffic, one row per Year + Month + Brand.')
    table_title(ws, 4, 'Table A — Social Media Monthly')
    header(ws, 5, ['Year', 'Month', 'Brand', 'Platform', 'Account / Page Name (optional)', 'Followers / Likes (#)', 'Impressions (#)', 'Clicks (#)',
                   'Paid Engagement - Likes+Comments+Shares+Saves+Clicks (#)', 'Organic (Free) Engagement - same (#)',
                   'Total Engagement (#)', 'CTR %', 'CTR Status', 'Engagement Rate %', 'Engagement Status'],
           {3: "Whose page is it? Xtreme and Majaal each have their own Facebook / Instagram.",
            5: 'Only needed when the same brand has two pages on one platform, e.g. "Xtreme Libya FB".',
            6: 'Followers at the END of the month (a snapshot, not new followers).',
            9: 'Interactions on paid (boosted / sponsored) posts. Type 0 only if there really were none.',
            10: 'Interactions on organic (free) posts.'})
    v_ = lambda col, r: v(f'{col}{r}')
    formulas = [
        lambda r: f'=IF(AND(I{r}="",J{r}=""),"",{v_("I", r)}+{v_("J", r)})',
        lambda r: f'=IF(G{r}="","",IFERROR({v_("H", r)}/{v_("G", r)},""))',
        lambda r: status3(f'L{r}', 0.05, 0.03),
        lambda r: f'=IF(OR(G{r}="",K{r}=""),"",IFERROR(K{r}/{v_("G", r)},""))',
        lambda r: status3(f'N{r}', 0.05, 0.03),
    ]
    num = '#,##0'
    formats = {6: num, 7: num, 8: num, 9: num, 10: num, 11: num, 12: '0.00%', 14: '0.00%'}
    body(ws, P3A_FIRST, P3A_LAST, 10, formulas, formats, [2026, 'September', 'Xtreme', 'Instagram', 'Xtreme Libya IG', 52000, 180000, 9500, 4200, 3100])
    for r in range(P3A_FIRST, P3A_LAST + 1):
        ws.cell(r, 5).alignment = Alignment(horizontal='left', vertical='center')
    rag(ws, f'M{P3A_FIRST}:M{P3A_LAST}')
    rag(ws, f'O{P3A_FIRST}:O{P3A_LAST}')
    dv_year(ws, f'A{P3A_FIRST}:A{P3A_LAST}')
    dv_list(ws, f'B{P3A_FIRST}:B{P3A_LAST}', MONTH_LIST, 'Month', 'Pick a month from the list.')
    dv_list(ws, f'C{P3A_FIRST}:C{P3A_LAST}', BRAND_LIST, 'Brand', 'Pick a brand from the list.')
    dv_list(ws, f'D{P3A_FIRST}:D{P3A_LAST}', PLATFORM_LIST, 'Platform', 'Pick a platform from the list.')
    dv_number(ws, f'F{P3A_FIRST}:J{P3A_LAST}', whole=True)

    table_title(ws, P3B_HEADER - 1, 'Table B — Website Traffic Monthly (one row per brand website)')
    header(ws, P3B_HEADER, ['Year', 'Month', 'Brand', 'Single-Page (Bounce) Visitors (#)', 'Total Visitors (#)', 'Total Sessions (#)',
                            'Total Time Spent by All Visitors (Minutes)', 'Bounce Rate %', 'Avg Session Duration (min)', 'Session Duration Status'],
           {3: "Each brand has its own website: one row per brand per month."})
    wformulas = [
        lambda r: f'=IF(E{r}="","",IFERROR({v_("D", r)}/{v_("E", r)},""))',
        lambda r: f'=IF(F{r}="","",IFERROR({v_("G", r)}/{v_("F", r)},""))',
        lambda r: status3(f'I{r}', 3, 1),
    ]
    body(ws, P3B_FIRST, P3B_LAST, 7, wformulas, {4: num, 5: num, 6: num, 7: num, 8: '0.0%', 9: '0.0'}, [2026, 'September', 'Xtreme', 3400, 12000, 15500, 54250])
    rag(ws, f'J{P3B_FIRST}:J{P3B_LAST}')
    dv_year(ws, f'A{P3B_FIRST}:A{P3B_LAST}')
    dv_list(ws, f'B{P3B_FIRST}:B{P3B_LAST}', MONTH_LIST, 'Month', 'Pick a month from the list.')
    dv_list(ws, f'C{P3B_FIRST}:C{P3B_LAST}', BRAND_LIST, 'Brand', 'Pick a brand from the list.')
    dv_number(ws, f'D{P3B_FIRST}:F{P3B_LAST}', whole=True)
    dv_number(ws, f'G{P3B_FIRST}:G{P3B_LAST}')

    # Wide enough for 9-digit impressions in one line (the clipping seen in the 1.x file came from values pasted as
    # text with line breaks; number-only validation now blocks that).
    widths(ws, {'A': 8, 'B': 12, 'C': 12, 'D': 13, 'E': 22, 'F': 15, 'G': 16, 'H': 13, 'I': 20, 'J': 18, 'K': 15, 'L': 9, 'M': 10, 'N': 12, 'O': 12})
    ws.freeze_panes = 'E6'
    protect(ws)


# ------------------------------------------------------------------------------------------------ Lists / others
def build_lists(wb):
    ws = wb['Lists']
    cols = {'A': ('Brand', BRANDS), 'I': ('Spend_Category', CATEGORIES)}
    for col, (head, values) in cols.items():
        for r in range(1, 31):
            ws[f'{col}{r}'] = None
        ws[f'{col}1'] = head
        for i, val in enumerate(values, 2):
            ws[f'{col}{i}'] = val
    ws['I1'].font = copy(ws['A1'].font)
    ws.column_dimensions['I'].width = 30
    ws.sheet_state = 'hidden'


def repoint_brand_dropdowns(wb):
    for name in (P2, P4):
        for d in wb[name].data_validations.dataValidation:
            if d.formula1 and d.formula1.replace('=', '') == 'Lists!$A$2:$A$5':
                d.formula1 = BRAND_LIST


def build_instructions(wb):
    ws = wb['Instructions']
    ws['B2'] = 'MARCOM CONTRIBUTION — Data Collection Template (version 2.0)'
    ws['C9'] = ('Enter one row per Month / Brand / Campaign / Platform / Event as indicated in each table. Monthly figures only — '
                'never YTD: the dashboard adds the months up itself.')
    defs = {
        25: ('ROI Ratio (Revenue : Spend)', 'Revenue Attributed to Marketing ÷ Total MARCOM Spend (Campaign + Other), shown as "1 : X". Green if X > 5 · Yellow if 3 ≤ X ≤ 5 · Red if X < 3.'),
        26: ('Budget Utilization %', 'Total MARCOM Spend (Campaign + Other) ÷ Budget Allocated, by Brand.'),
        27: ('Brand Growth %', '(Brand Revenue – Current Month − Brand Revenue – Same Month Last Year) ÷ Brand Revenue – Same Month Last Year. Brand-level, never the company total.'),
        28: ('CAC (Customer Acquisition Cost)', 'Total MARCOM Spend ÷ # of New Customers, then compared as a % of Average Sales per Invoice (LYD). Green if CAC ≤ 3% of Sales/Invoice · Yellow if 3%–5% · Red if > 5%.'),
    }
    for r, (k, text) in defs.items():
        ws.cell(r, 2, k)
        ws.cell(r, 3, text)
    tabs = [
        ('P1 - MARCOM Spending', 'Monthly brand revenue, budget and CAC/CPC inputs by Brand; Campaign / Other / Total MARCOM spend and Unallocated are calculated.'),
        ('P1b - Other MARCOM Spending', 'Non-campaign MARCOM spend, one row per expense line (uniforms, printouts, gifts, sponsorships …).'),
        ('P2 - Media Campaigns', 'Campaign-level spend/revenue, timeline, and OOH (out-of-home) coverage & cost by media type and city (Table B: one row per campaign, media type and city).'),
        ('P3 - Digital Performance', 'Monthly social media per Brand + Platform, and website traffic per Brand.'),
        ('P4 - Trade Marketing', 'Monthly compliance/stock/attendance KPIs and the events log.'),
    ]
    for i, (k, text) in enumerate(tabs):
        ws.cell(37 + i, 2, k).font = copy(ws.cell(37, 2).font)
        ws.cell(37 + i, 3, text).font = copy(ws.cell(37, 3).font)
        ws.cell(37 + i, 3).alignment = copy(ws.cell(37, 3).alignment)


def main():
    wb = load_workbook(PATH)
    build_p1(wb)
    build_p1b(wb)
    build_p3(wb)
    build_lists(wb)
    repoint_brand_dropdowns(wb)
    build_instructions(wb)
    wb.active = 0
    wb.save(PATH)
    print('wrote', PATH)


if __name__ == '__main__':
    sys.exit(main())
