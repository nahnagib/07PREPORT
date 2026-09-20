/**
 * The ONE place RAG thresholds live. Pages and routes never contain a threshold number.
 *
 * A rule is `green` bound + `red` bound; anything that satisfies neither is yellow. Every boundary
 * says explicitly whether it is inclusive (gte/lte) or exclusive (gt/lt), so the template's exact
 * behaviour is data, not scattered comparisons. `value` is a decimal STRING compared exactly (see
 * rat.ts) against the KPI's native quantity:
 *   - ratios / LYD / minutes: the number itself           (ROI 1:5 -> '5', CPC 2.5 LYD -> '2.5')
 *   - percentages: the FRACTION, not percentage points     (CTR 5% -> '0.05')
 *
 * To change a threshold, edit this file only.
 */
export type Op = 'gt' | 'gte' | 'lt' | 'lte';

export interface Bound { op: Op; value: string }
export interface RagRule { green: Bound; red: Bound }

export const RAG_RULES = {
  /** ROI X in "1 : X" (Revenue / Spend). >5 green, 3..5 inclusive yellow, <3 red. */
  roi: { green: { op: 'gt', value: '5' }, red: { op: 'lt', value: '3' } },
  /** CAC as a share of the (customer-weighted) average invoice. <=3% green, (3%,5%] yellow, >5% red. */
  cacPctOfInvoice: { green: { op: 'lte', value: '0.03' }, red: { op: 'gt', value: '0.05' } },
  /** Cost per click in LYD. <2.5 green, 2.5..5 inclusive yellow, >5 red. */
  cpc: { green: { op: 'lt', value: '2.5' }, red: { op: 'gt', value: '5' } },
  /** Click-through rate. >5% green, 3%..5% inclusive yellow, <3% red. */
  ctr: { green: { op: 'gt', value: '0.05' }, red: { op: 'lt', value: '0.03' } },
  /** Engagement rate. >5% green, 3%..5% inclusive yellow, <3% red. */
  engagementRate: { green: { op: 'gt', value: '0.05' }, red: { op: 'lt', value: '0.03' } },
  /** Average session duration in minutes. >3 green, 1..3 inclusive yellow, <1 red. */
  avgSessionMinutes: { green: { op: 'gt', value: '3' }, red: { op: 'lt', value: '1' } },
  /** Compliance, giveaways stock, printed-materials stock, attendance. >90% green, 80%..90% inclusive yellow, <80% red. */
  percentOfTarget: { green: { op: 'gt', value: '0.9' }, red: { op: 'lt', value: '0.8' } },
} as const satisfies Record<string, RagRule>;

export type RagRuleKey = keyof typeof RAG_RULES;

/** KPIs that deliberately have no thresholds: they are always 'neutral' (or 'na'). */
export const NO_THRESHOLD_KPIS = ['bounceRate', 'budgetUtilization', 'brandGrowth', 'campaignRate', 'cacAbsolute'] as const;

/** Budget utilization above this share of the budget is flagged `overBudget`. */
export const OVER_BUDGET_ABOVE = '1';
