/**
 * Renders the Overview Report to PDF: builds a self-contained HTML string (no client bundle, no
 * external assets) and prints it via headless Chromium (puppeteer-core). Charts are hand-rolled
 * inline SVG fed directly by each section's `trend` points -- there's no need to pull a full chart
 * library into the server process for two small line charts.
 */
import puppeteer from 'puppeteer-core';
import { TargetStatus } from '../measures/classify';
import { Observation } from './reportObservations';
import { ReportKpi, ReportSection, TrendPoint, Unit } from './reportSections';

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

/** Hard cap on KPI rows per PDF page, mirroring @07ps/ui's packages/ui/src/pdfPagination.ts
 * (PDF_TABLE_ROWS_PER_PAGE) exactly -- kept as a local copy rather than an import because this
 * package's tsc build (`rootDir: "src"`, see backend/tsconfig.json) can't compile a sibling
 * workspace package's raw TS source without restructuring its dist output layout, and this is a
 * three-line pure function, not worth a compiled shared package for. If PDF_TABLE_ROWS_PER_PAGE
 * ever changes there, change it here too. */
const PDF_TABLE_ROWS_PER_PAGE = 18;

/** Splits `rows` into fixed-size pages of at most `pageSize` rows (default
 * PDF_TABLE_ROWS_PER_PAGE); the last chunk holds the remainder, never padded. Same semantics as
 * packages/ui/src/pdfPagination.ts's chunkRows. */
function chunkRows<T>(rows: T[], pageSize: number = PDF_TABLE_ROWS_PER_PAGE): T[][] {
  if (rows.length === 0) return [];
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += pageSize) {
    pages.push(rows.slice(i, i + pageSize));
  }
  return pages;
}

function kpiRowHtml(k: ReportKpi): string {
  return `
      <tr>
        <td>${escapeHtml(k.label)}</td>
        <td>${formatValue(k.actual, k.unit)}</td>
        <td>${k.target !== null ? formatValue(k.target, k.unit) : '--'}</td>
        <td>${k.variancePct !== null ? `${(k.variancePct * 100).toFixed(1)}%` : '--'}</td>
        <td>${k.priorPeriodActual !== null ? `${formatValue(k.priorPeriodActual, k.unit)} (${k.priorPeriodLabel})` : '--'}</td>
        <td><span class="status-dot" style="background:${STATUS_COLOR[k.status]}"></span>${k.status.replace('_', ' ').toUpperCase()}</td>
      </tr>`;
}

/**
 * A section's KPI rows are chunked into fixed PDF_TABLE_ROWS_PER_PAGE-row pages up front, each
 * rendered as its own `<table>` (with its own `<thead>`, so the column header repeats on every
 * page) inside its own `.section` block; every page after the first carries an explicit
 * `page-break` class (`page-break-before: always`) rather than leaving where it lands up to
 * Puppeteer's own flow layout. This is the primary pagination mechanism -- not a fallback -- so a
 * section's rows can never be split across a page boundary at all, regardless of row height or
 * content length. (Every section here has well under 18 KPI rows today, so in practice this still
 * renders as a single page per section; the chunking applies uniformly anyway so a future section
 * with more rows -- e.g. Pipeline Health's per-transition stage benchmarks -- inherits the same
 * guarantee automatically instead of silently relying on `tr { page-break-inside: avoid }`, which
 * is now only a defensive backstop for an unusually tall single row, not the pagination logic.)
 */
function renderKpiTable(section: ReportSection): string {
  const kpiChunks = chunkRows(section.kpis);
  return kpiChunks
    .map((kpisForPage, pageIndex) => {
      const isFirst = pageIndex === 0;
      const isLast = pageIndex === kpiChunks.length - 1;
      const heading =
        kpiChunks.length > 1
          ? `${escapeHtml(section.label)} (page ${pageIndex + 1} of ${kpiChunks.length})`
          : escapeHtml(section.label);
      return `
    <div class="section${isFirst ? '' : ' page-break'}">
      <h3>${heading}</h3>
      ${isFirst && section.note ? `<div class="note">${escapeHtml(section.note)}</div>` : ''}
      <table>
        <thead><tr><th>KPI</th><th>Actual</th><th>Target</th><th>Variance vs Target</th><th>Prior Period</th><th>Status</th></tr></thead>
        <tbody>${kpisForPage.map(kpiRowHtml).join('')}</tbody>
      </table>
      ${isLast && section.trend ? renderLineChart(section.trend.seriesLabel, section.trend.points) : ''}
    </div>`;
    })
    .join('');
}

/** `filterSummaryParts` is pre-resolved to human-readable "Dimension: Name, Name" strings by the
 * route handler (see routes/reports.ts's resolveFilterSummaryParts) -- this module only formats
 * and escapes them, the same "Company: Majaal"-style labels the per-table PerformanceReportTable
 * PDF export already shows, rather than the old raw filter-key counts. */
function describeFiltersShort(parts: string[]): string {
  return parts.length ? parts.join(' | ') : 'No filters applied (all data)';
}

export interface OverviewReportPayload {
  anchorDate: string;
  generatedAt: string;
  filterSummaryParts: string[];
  exportedByEmail: string;
  sections: ReportSection[];
  omittedPageKeys: string[];
  executiveSummary: string;
  observations: Observation[];
  risks: string[];
}

function buildHtml(payload: OverviewReportPayload): string {
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
  .cover .filters-box ul { margin: 6px 0 0; padding-left: 18px; }
  .cover .filters-box li { margin-bottom: 4px; }
  .section { margin-bottom: 20px; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  thead { display: table-header-group; }
  /* NOT the pagination mechanism -- renderKpiTable (see reportPdf.ts) hard-caps every table to
     PDF_TABLE_ROWS_PER_PAGE rows and inserts an explicit .page-break before each subsequent chunk,
     so a table's rows can never straddle a page boundary by construction, independent of Puppeteer's
     own flow layout. This is only a defensive backstop for an edge case that hard cap doesn't cover
     -- an unusually tall single row (long wrapped text, etc.) that alone doesn't fit in the
     remaining space on a page -- so it's pushed whole rather than split. */
  tr { page-break-inside: avoid; break-inside: avoid; }
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
    <div class="subtitle">Exported by: ${escapeHtml(payload.exportedByEmail)} on ${escapeHtml(formatGeneratedAt(payload.generatedAt))}</div>
    <div class="filters-box">
      <strong>Filters applied:</strong>
      ${
        payload.filterSummaryParts.length
          ? `<ul>${payload.filterSummaryParts.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
          : '<div>No filters applied.</div>'
      }
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
    const filterFooter = describeFiltersShort(payload.filterSummaryParts);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '18mm', left: '15mm', right: '15mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="font-size:9px; color:#57606a; width:100%; padding:0 15mm; display:flex; justify-content:space-between;">
          <span>${escapeHtml(filterFooter)} &middot; Exported by: ${escapeHtml(payload.exportedByEmail)}</span>
          <span class="pageNumber"></span>&nbsp;/&nbsp;<span class="totalPages"></span>
        </div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
