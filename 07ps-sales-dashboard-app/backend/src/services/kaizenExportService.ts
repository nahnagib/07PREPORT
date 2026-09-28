import ExcelJS from 'exceljs';
import { listCards, listDropdownValues, type KaizenFilters } from './kaizenService';

type Lang = 'en' | 'ar';

const HEADERS: Record<Lang, string[]> = {
  en: [
    'No', 'Card Creator', 'Date', 'Department', 'Card Name', 'Card Type', 'Issue', 'Root Cause', 'Impact',
    'Card Priority', 'Proposed Solution', 'Expected Date', 'Closer Date', 'Responsible Party', 'Status', 'Overdue',
  ],
  ar: [
    'الرقم', 'منشئ البطاقة', 'التاريخ', 'الإدارة', 'اسم البطاقة', 'نوع البطاقة', 'المشكلة', 'السبب الجذري', 'التأثير',
    'أهمية البطاقة', 'الحل المقترح', 'التاريخ المتوقع', 'تاريخ الإغلاق', 'الجهة المسؤولة', 'الحالة', 'متأخرة',
  ],
};

const WIDTHS = [7, 22, 12, 22, 30, 16, 45, 35, 35, 16, 40, 14, 14, 24, 12, 10];

/** The filtered cards list as an .xlsx workbook, headers and dropdown labels in `lang`. The column
 * names match what the one-time import accepts, so an export can be re-imported elsewhere. */
export async function buildKaizenExport(filters: KaizenFilters, sort: { by?: string; dir?: string }, lang: Lang): Promise<Buffer> {
  const [{ rows }, dropdowns] = await Promise.all([listCards(filters, sort), listDropdownValues()]);
  const label = new Map(dropdowns.map((d) => [d.value_id, lang === 'ar' ? d.label_ar : d.label_en]));
  const yes = lang === 'ar' ? 'نعم' : 'Yes';
  const status = (s: string) => (s === 'CLOSED' ? (lang === 'ar' ? 'تم الإغلاق' : 'Closed') : lang === 'ar' ? 'مفتوحة' : 'Open');
  const notAssigned = lang === 'ar' ? '(غير محدد)' : '(Not assigned)';

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(lang === 'ar' ? 'بطاقات كايزن' : 'Kaizen Cards', {
    views: [{ state: 'frozen', ySplit: 1, rightToLeft: lang === 'ar' }],
  });
  sheet.columns = HEADERS[lang].map((header, i) => ({ header, width: WIDTHS[i] }));
  sheet.getRow(1).font = { bold: true };
  const asDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);
  for (const c of rows) {
    sheet.addRow([
      c.card_no,
      c.creator_name,
      asDate(c.card_date),
      label.get(c.department_id) ?? '',
      c.card_name,
      label.get(c.card_type_id) ?? '',
      c.issue,
      c.root_cause ?? '',
      c.impact ?? '',
      label.get(c.priority_id) ?? '',
      c.proposed_solution ?? '',
      asDate(c.expected_date),
      asDate(c.closer_date),
      c.responsible_party ?? notAssigned,
      status(c.status),
      c.is_overdue ? yes : '',
    ]);
  }
  for (const col of [3, 12, 13]) sheet.getColumn(col).numFmt = 'yyyy-mm-dd';
  for (const col of [7, 8, 9, 11]) sheet.getColumn(col).alignment = { wrapText: true, vertical: 'top' };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS[lang].length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
