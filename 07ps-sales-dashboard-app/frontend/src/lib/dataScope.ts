import type { DataScopeOperator, DataScopeValue } from './api';

/**
 * Pure helpers of the Roles page's data-scope rules (2026-10-15): { dimension, operator: in | not_in, values }; several
 * rules per dimension since 2026-10-21, every rule combined with AND (same dimension or not), values in a rule OR'd. Enforced by the backend (services/dataScopeService.ts); these only
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

// ---------------------------------------------------------------------------------------------------------------------
// Several rules on one dimension (2026-10-21): every rule applies (AND). Mirrors the backend's
// measures/filters.ts combineDimensionRules -- the server enforces it and refuses a save that matches no data; these
// only warn and block the Save button early.
// ---------------------------------------------------------------------------------------------------------------------

export interface RuleValues {
  operator: DataScopeOperator;
  values: string[];
}

/** The values a dimension's rules allow together: the values every "is" rule lists, minus every value an "is not"
 * rule excludes. With no "is" rule the start is `domain` (every value of the dimension); null when that is not known
 * (yet). */
export function combineRules(rules: RuleValues[], domain: string[] | null): string[] | null {
  const inRules = rules.filter((r) => r.operator === 'in');
  const excluded = new Set(rules.filter((r) => r.operator === 'not_in').flatMap((r) => r.values));
  let allowed: string[];
  if (inRules.length > 0) {
    allowed = [...new Set(inRules[0].values)];
    for (const r of inRules.slice(1)) allowed = allowed.filter((v) => r.values.includes(v));
  } else {
    if (!domain) return null;
    allowed = [...new Set(domain)];
  }
  return allowed.filter((v) => !excluded.has(v));
}

/** True when two or more rules (each with a value) together match no value -- "is [A]" AND "is not [A]", or two
 * "is" rules with no shared value. A single rule never counts (one "is none of" everything is allowed on its own).
 * False when it cannot be known yet (only "is not" rules, dimension values not loaded). */
export function matchesNoData(rules: RuleValues[], domain: string[] | null): boolean {
  const complete = rules.filter((r) => r.values.length > 0);
  if (complete.length < 2) return false;
  const allowed = combineRules(complete, domain);
  return allowed !== null && allowed.length === 0;
}

/**
 * Two rules with the same operator as ONE rule that means the same: "is" AND "is" -> "is" the values both list;
 * "is not" AND "is not" -> "is not" the values of either. Null for different operators, or two "is" rules with no
 * shared value (that pair matches no data -- see matchesNoData).
 */
export function mergeRules(a: RuleValues, b: RuleValues): RuleValues | null {
  if (a.operator !== b.operator) return null;
  if (a.operator === 'in') {
    const values = a.values.filter((v) => b.values.includes(v));
    return values.length > 0 ? { operator: 'in', values } : null;
  }
  return { operator: 'not_in', values: [...new Set([...a.values, ...b.values])] };
}

/** The first pair of rules (by position) that mergeRules can turn into one, or null. */
export function findMergeablePair<T extends RuleValues>(rules: T[]): [T, T] | null {
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      if (rules[i].values.length > 0 && rules[j].values.length > 0 && mergeRules(rules[i], rules[j])) return [rules[i], rules[j]];
    }
  }
  return null;
}

/** Rules grouped by dimension, the groups in `dimensionOrder` (unknown dimensions last), each group's rules in the
 * given order. */
export function groupByDimension<T extends { dimension: string }>(rules: T[], dimensionOrder: string[]): { dimension: string; rules: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const r of rules) groups.set(r.dimension, [...(groups.get(r.dimension) ?? []), r]);
  const rank = (d: string) => (dimensionOrder.includes(d) ? dimensionOrder.indexOf(d) : dimensionOrder.length);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b)).map(([dimension, rs]) => ({ dimension, rules: rs }));
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
