/**
 * Key Observations for the Overview Report: ranks KPIs across all included sections by how far
 * off target (or off the prior period) they are. Deliberately NOT a port of the Python
 * `reporting/anomalies.py` (Z-score/IsolationForest) or `reporting/drivers.py` (SHAP) --
 * those need dozens of historical months / >=30 opportunities to mean anything, and would produce
 * statistical noise dressed up as insight on a narrow on-screen filter slice (one branch, one
 * salesperson, etc). This is a much simpler, honest substitute: rank what's actually computed.
 */
import { TargetStatus } from '../measures/classify';
import { ReportKpi, ReportSection } from './reportSections';

export interface Observation {
  sectionLabel: string;
  kpiLabel: string;
  kind: 'target_gap' | 'prior_period_move';
  magnitudePct: number; // absolute value, used for ranking
  text: string;
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function priorPeriodDelta(k: ReportKpi): number | null {
  if (k.actual === null || k.priorPeriodActual === null || k.priorPeriodActual === 0) return null;
  return (k.actual - k.priorPeriodActual) / k.priorPeriodActual;
}

export function buildObservations(sections: ReportSection[], limit = 8): Observation[] {
  const observations: Observation[] = [];

  for (const section of sections) {
    if (section.omitted) continue;
    for (const k of section.kpis) {
      if (k.variancePct !== null && k.status !== TargetStatus.NO_TARGET) {
        observations.push({
          sectionLabel: section.label,
          kpiLabel: k.label,
          kind: 'target_gap',
          magnitudePct: Math.abs(k.variancePct),
          text: `${section.label} -- ${k.label} is ${formatPct(k.variancePct)} ${k.variancePct < 0 ? 'below' : 'above'} target (${k.status.toUpperCase()}).`,
        });
      }
      const delta = priorPeriodDelta(k);
      if (delta !== null && k.priorPeriodLabel) {
        observations.push({
          sectionLabel: section.label,
          kpiLabel: k.label,
          kind: 'prior_period_move',
          magnitudePct: Math.abs(delta),
          text: `${section.label} -- ${k.label} moved ${formatPct(delta)} ${k.priorPeriodLabel} (${delta >= 0 ? 'up' : 'down'}).`,
        });
      }
    }
  }

  observations.sort((a, b) => b.magnitudePct - a.magnitudePct);
  return observations.slice(0, limit);
}

export function buildRisks(sections: ReportSection[]): string[] {
  const risks: string[] = [];
  for (const section of sections) {
    if (section.omitted) continue;
    for (const k of section.kpis) {
      if (k.status === TargetStatus.RED) {
        risks.push(`${section.label} -- ${k.label} is significantly below target (${k.variancePct !== null ? formatPct(k.variancePct) : 'n/a'}).`);
      } else if (k.status === TargetStatus.YELLOW) {
        risks.push(`${section.label} -- ${k.label} is trending below target (${k.variancePct !== null ? formatPct(k.variancePct) : 'n/a'}); worth monitoring.`);
      }
    }
    if (section.note) {
      risks.push(`${section.label} -- ${section.note}`);
    }
  }
  return risks;
}
