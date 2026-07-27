/**
 * Rule-based Executive Summary text for the Overview Report -- plain Python^H^H^H^HTypeScript
 * string templates, no external LLM call. Same "reuse the style, not the code" relationship to
 * `reporting/narrative.py` described in routes/reports.ts's header comment: that module operates
 * on Python dataclasses that don't exist here, so this is a fresh implementation against this
 * payload's actual shape, matching its plain-business-language tone.
 */
import { Filters } from '../measures/filters';
import { TargetStatus } from '../measures/classify';
import { Observation } from './reportObservations';
import { ReportSection } from './reportSections';

function describeFilters(filters: Filters): string {
  const parts: string[] = [];
  if (filters.companyKeys?.length) parts.push(`${filters.companyKeys.length} compan${filters.companyKeys.length === 1 ? 'y' : 'ies'}`);
  if (filters.segmentKeys?.length) parts.push(`${filters.segmentKeys.length} customer group(s)`);
  if (filters.channelKeys?.length) parts.push(`${filters.channelKeys.length} distribution channel(s)`);
  if (filters.salesTeamKeys?.length) parts.push(`${filters.salesTeamKeys.length} branch(es)`);
  if (filters.salespersonKeys?.length) parts.push(`${filters.salespersonKeys.length} salesperson/people`);
  return parts.length ? `filtered to ${parts.join(', ')}` : 'across the full sales organization (no filters applied)';
}

export function executiveSummary(sections: ReportSection[], filters: Filters, topObservation: Observation | null): string {
  const sentences: string[] = [];
  const included = sections.filter((s) => !s.omitted);
  sentences.push(`This report covers current sales performance ${describeFilters(filters)}.`);

  const redCount = included.reduce((n, s) => n + s.kpis.filter((k) => k.status === TargetStatus.RED).length, 0);
  const greenCount = included.reduce((n, s) => n + s.kpis.filter((k) => k.status === TargetStatus.GREEN).length, 0);
  if (redCount === 0 && greenCount > 0) {
    sentences.push('Overall, tracked KPIs are meeting or exceeding target for this slice.');
  } else if (redCount > 0) {
    sentences.push(`${redCount} KPI${redCount === 1 ? ' is' : 's are'} significantly below target and need attention.`);
  }

  if (topObservation) {
    sentences.push(`The most notable finding is: ${topObservation.text}`);
  }

  const omitted = sections.filter((s) => s.omitted);
  if (omitted.length) {
    sentences.push(`${omitted.length} section(s) were omitted from this report due to export permissions on this account.`);
  }

  return sentences.join(' ');
}
