import type { DataScopeOperator, DataScopeValue } from './api';

/**
 * Pure helpers of the Roles page's data-scope rules (2026-10-15): { dimension, operator: in | not_in, values }, one
 * rule per dimension, rules combined with AND. Enforced by the backend (services/dataScopeService.ts); these only
 * word and lay out what the admin edits.
 */

/** The operator as the rule row reads: "Company is A or B" / "Company is not X". */
export const OPERATOR_LABEL: Record<DataScopeOperator, string> = { in: 'is', not_in: 'is not' };
/** The operator spelled out (tooltips, screen readers). */
export const OPERATOR_HINT: Record<DataScopeOperator, string> = {
  in: 'is any of: users see ONLY the selected values',
  not_in: 'is none of: users see everything EXCEPT the selected values (values added later included)',
};

/** "A", "A or B", "A, B or C". */
export function joinOr(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/** One rule in plain words: "Company is Majaal or Tika", "Company is not X", "Branch is none of A, B or C". */
export function describeRule(dimensionLabel: string, operator: DataScopeOperator, valueLabels: string[]): string {
  if (operator === 'in') return `${dimensionLabel} is ${joinOr(valueLabels)}`;
  return valueLabels.length === 1 ? `${dimensionLabel} is not ${valueLabels[0]}` : `${dimensionLabel} is none of ${joinOr(valueLabels)}`;
}

/** The role's whole scope in one line, rules joined by " · " (AND). Rules without a value are left out (they cannot
 * be saved). */
export function scopeSummary(rules: { dimensionLabel: string; operator: DataScopeOperator; valueLabels: string[] }[]): string {
  const parts = rules.filter((r) => r.valueLabels.length > 0).map((r) => describeRule(r.dimensionLabel, r.operator, r.valueLabels));
  return parts.length === 0 ? 'Users with this role see: all data (no restrictions)' : `Users with this role see: ${parts.join(' · ')}`;
}

/**
 * Any list of dimension values as { value, label }: plain strings / numbers, { value, label }, { id, name },
 * { key, label }, or the filter endpoints' { company_key, company_name }-style rows. Items without a usable key are
 * dropped; a missing label falls back to the key; duplicates keep their first label.
 */
export function normalizeDimensionValues(raw: unknown): DataScopeValue[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { values?: unknown }).values) ? (raw as { values: unknown[] }).values : [];
  const out = new Map<string, string>();
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  for (const item of list) {
    let value = '';
    let label = '';
    if (typeof item === 'string' || typeof item === 'number') value = label = text(item);
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const keyField = Object.keys(o).find((k) => /_key$/.test(k));
      const nameField = Object.keys(o).find((k) => /_name$/.test(k));
      value = text(o.value ?? o.id ?? o.key ?? (keyField ? o[keyField] : undefined));
      label = text(o.label ?? o.name ?? (nameField ? o[nameField] : undefined));
    }
    if (value !== '' && !out.has(value)) out.set(value, label || value);
  }
  return [...out].map(([value, label]) => ({ value, label }));
}

/** Search text, normalised so a search finds Arabic as well as Latin names: lower case, no Arabic diacritics or
 * tatweel, and the usual letter variants unified (أ إ آ -> ا, ى -> ي, ة -> ه). Null-safe. */
export function normalizeSearch(text: string | null | undefined): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

/** The options matching a search: every option for an empty query, else a match on the label or the exact key. */
export function filterOptions(options: DataScopeValue[], query: string | null | undefined): DataScopeValue[] {
  const q = normalizeSearch(query);
  if (!q) return options;
  return options.filter((o) => normalizeSearch(o.label).includes(q) || normalizeSearch(o.value) === q);
}

/** The chips a field shows: the first `max` values, the rest collapsed into "+N more". */
export function visibleChips<T>(values: T[], max = 3): { shown: T[]; more: number } {
  return values.length <= max ? { shown: values, more: 0 } : { shown: values.slice(0, max), more: values.length - max };
}
