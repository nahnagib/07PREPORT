/**
 * Renders the Overview Report to PDF: builds a self-contained HTML string (no client bundle, no
 * external assets) and prints it via headless Chromium (puppeteer-core). Charts are hand-rolled
 * inline SVG fed directly by each section's `trend` points -- there's no need to pull a full chart
 * library into the server process for two small line charts.
 */
import puppeteer from 'puppeteer-core';
import { Filters } from '../measures/filters';
import { TargetStatus } from '../measures/classify';
import { Observation } from './reportObservations';
import { ReportSection, TrendPoint, Unit } from './reportSections';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** payload.generatedAt is `new Date().toISOString()` -- an already-correct absolute instant (UTC),
 * not a naive DB value, so this just needs to be *displayed* in Libya time for a Libya-based
 * report, the same IANA-pinned rule as frontend/src/lib/format.ts's formatTimestamp. */
function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    timeZone: 'Africa/Tripoli',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatValue(v: number | null, unit: Unit): string {
  if (v === null || Number.isNaN(v)) return '--';
  switch (unit) {
    case 'currency':
      return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    case 'percent':
      // Every *Pct/*Ratio field this report consumes (retentionRatePct, winRatePct,
      // lostDealsRatio, stageBenchmark actualPct/targetPct, ...) is a 0-1 fraction despite the
      // "Pct" name -- same convention as classify.ts's own variancePct ("-0.10 means 10% below
      // target"). Multiply by 100 here, once, rather than at every call site.
      return `${(v * 100).toFixed(1)}%`;
    case 'volume':
      return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    default:
      return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
}

const STATUS_COLOR: Record<TargetStatus, string> = {
  [TargetStatus.GREEN]: '#1a7f37',
  [TargetStatus.YELLOW]: '#9a6700',
  [TargetStatus.RED]: '#cf222e',
  [TargetStatus.NO_TARGET]: '#6e7781',
};

function renderLineChart(title: string, points: TrendPoint[], width = 720, height = 220): string {
  if (!points.length) return `<div class="chart-empty">${escapeHtml(title)}: no data available.</div>`;
  const padding = 32;
  const values = points.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(...values) || 1;
  const xStep = (width - padding * 2) / Math.max(points.length - 1, 1);
  const scaleY = (v: number) => height - padding - ((v - min) / (max - min || 1)) * (height - padding * 2);
  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${padding + i * xStep} ${scaleY(p.value)}`)
    .join(' ');
  const labelEvery = Math.ceil(points.length / 8) || 1;
  const labels = points
    .map((p, i) =>
      i % labelEvery === 0
        ? `<text x="${padding + i * xStep}" y="${height - 8}" font-size="9" text-anchor="middle" fill="#57606a">${escapeHtml(p.label)}</text>`
        : ''
    )
    .join('');

  return `
    <div class="chart-block">
      <div class="chart-title">${escapeHtml(title)}</div>
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <line x1="${padding}" y1="${scaleY(0)}" x2="${width - padding}" y2="${scaleY(0)}" stroke="#d0d7de" stroke-width="1" />
        <path d="${pathD}" fill="none" stroke="#2c6e9e" stroke-width="2" />
        ${labels}
      </svg>
    </div>`;
}

function renderKpiTable(section: ReportSection): string {
  const rows = section.kpis
    .map(
      (k) => `
      <tr>
        <td>${escapeHtml(k.label)}</td>
        <td>${formatValue(k.actual, k.unit)}</td>
        <td>${k.target !== null ? formatValue(k.target, k.unit) : '--'}</td>
        <td>${k.variancePct !== null ? `${(k.variancePct * 100).toFixed(1)}%` : '--'}</td>
        <td>${k.priorPeriodActual !== null ? `${formatValue(k.priorPeriodActual, k.unit)} (${k.priorPeriodLabel})` : '--'}</td>
        <td><span class="status-dot" style="background:${STATUS_COLOR[k.status]}"></span>${k.status.replace('_', ' ').toUpperCase()}</td>
      </tr>`
    )
    .join('');

  return `
    <div class="section">
      <h3>${escapeHtml(section.label)}</h3>
      ${section.note ? `<div class="note">${escapeHtml(section.note)}</div>` : ''}
      <table>
        <thead><tr><th>KPI</th><th>Actual</th><th>Target</th><th>Variance vs Target</th><th>Prior Period</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${section.trend ? renderLineChart(section.trend.seriesLabel, section.trend.points) : ''}
    </div>`;
}

function describeFiltersShort(filters: Filters): string {
  const parts: string[] = [];
  if (filters.companyKeys?.length) parts.push(`Company: ${filters.companyKeys.length}`);
  if (filters.segmentKeys?.length) parts.push(`Customer Group: ${filters.segmentKeys.length}`);
  if (filters.channelKeys?.length) parts.push(`Channel: ${filters.channelKeys.length}`);
  if (filters.salesTeamKeys?.length) parts.push(`Branch: ${filters.salesTeamKeys.length}`);
  if (filters.salespersonKeys?.length) parts.push(`Salesperson: ${filters.salespersonKeys.length}`);
  return parts.length ? parts.join(' | ') : 'No filters applied (all data)';
}

export interface OverviewReportPayload {
  anchorDate: string;
  generatedAt: string;
  filters: Filters;
  sections: ReportSection[];
  omittedPageKeys: string[];
  executiveSummary: string;
  observations: Observation[];
  risks: string[];
}

function buildHtml(payload: OverviewReportPayload): string {
  const filterSummary = describeFiltersShort(payload.filters);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1f2328; margin: 0; padding: 32px; font-size: 12px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; border-bottom: 2px solid #1f2328; padding-bottom: 4px; margin-top: 28px; }
  h3 { font-size: 13px; margin-bottom: 6px; }
  .cover { text-align: center; padding-top: 120px; }
  .cover .subtitle { font-size: 13px; color: #57606a; margin-top: 8px; }
  .cover .filters-box { margin: 32px auto 0; max-width: 480px; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px; text-align: left; font-size: 12px; }
  .section { margin-bottom: 20px; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid #d0d7de; padding: 5px 8px; text-align: left; font-size: 11px; }
  th { background: #f6f8fa; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  ul.obs-list, ul.risks-list { padding-left: 18px; }
  ul.obs-list li, ul.risks-list li { margin-bottom: 6px; }
  .note { font-size: 11px; color: #57606a; font-style: italic; margin: 4px 0; }
  .chart-block { margin-top: 8px; }
  .chart-title { font-size: 11px; color: #57606a; margin-bottom: 4px; }
  .chart-empty { font-size: 11px; color: #57606a; font-style: italic; }
  .page-break { page-break-before: always; }
</style>
</head>
<body>
  <div class="cover">
    <h1>Promotion Dashboard &mdash; Overview Report</h1>
    <div class="subtitle">Generated ${escapeHtml(formatGeneratedAt(payload.generatedAt))} &middot; Anchor date ${escapeHtml(payload.anchorDate)}</div>
    <div class="filters-box">
      <strong>Applied Filters</strong><br/>
      ${escapeHtml(filterSummary)}
    </div>
  </div>

  <div class="page-break"></div>
  <h2>Executive Summary</h2>
  <p>${escapeHtml(payload.executiveSummary)}</p>

  <h2>Key Observations</h2>
  <ul class="obs-list">
    ${payload.observations.map((o) => `<li>${escapeHtml(o.text)}</li>`).join('') || '<li>No notable observations for this filtered slice.</li>'}
  </ul>

  <h2>KPI Scorecard</h2>
  ${payload.sections.filter((s) => !s.omitted).map(renderKpiTable).join('')}

  <h2>Risks / Areas Needing Attention</h2>
  <ul class="risks-list">
    ${payload.risks.map((r) => `<li>${escapeHtml(r)}</li>`).join('') || '<li>No significant risks flagged for this filtered slice.</li>'}
  </ul>

  ${payload.omittedPageKeys.length ? `<h2>Omitted Sections</h2><p>${payload.omittedPageKeys.length} section(s) omitted -- insufficient export permission on this account: ${escapeHtml(payload.omittedPageKeys.join(', '))}</p>` : ''}
</body>
</html>`;
}

function resolveExecutablePath(): string | undefined {
  return process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
}

export async function renderOverviewReportPdf(payload: OverviewReportPayload): Promise<Buffer> {
  const executablePath = resolveExecutablePath();
  if (!executablePath) {
    throw new Error(
      'PUPPETEER_EXECUTABLE_PATH is not set. Point it at a local Chrome/Chromium install for dev, ' +
        'or at the apk-installed chromium binary in Docker (see backend/Dockerfile).',
    );
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const html = buildHtml(payload);
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const filterFooter = describeFiltersShort(payload.filters);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '18mm', left: '15mm', right: '15mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="font-size:9px; color:#57606a; width:100%; padding:0 15mm; display:flex; justify-content:space-between;">
          <span>${escapeHtml(filterFooter)}</span>
          <span class="pageNumber"></span>&nbsp;/&nbsp;<span class="totalPages"></span>
        </div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
