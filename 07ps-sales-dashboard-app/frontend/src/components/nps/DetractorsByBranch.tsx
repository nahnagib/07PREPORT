import { vh } from '../../lib/visualHelp';
import React, { useState } from 'react';
import { Button, ChartPanel, EmptyState, ErrorState, LoadingSkeleton, exportRowsAsPdf, exportShareBarAsImage } from '@07ps/ui';
import type { NpsDetractorsByBranch } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { CATEGORICAL_14, UNKNOWN_GREY } from '../../lib/marcom/palette';
import { ShareBar, type ShareBarItem } from '../ShareBar';

type State = { data: NpsDetractorsByBranch | null; loading: boolean; error: string | null; retry: () => void };

const pct1 = (count: number, total: number) => `${(total ? (100 * count) / total : 0).toFixed(1)}%`;
/** "9 (19.6%)": the branch's detractors and its share of all detractors (the Detractors card). */
export const branchLabel = (count: number, total: number) => `${formatNumber(count)} (${pct1(count, total)})`;

/** The bar's parts: biggest branch first, left to right; neighbours in clearly different colours; "Unknown" grey. */
export function branchItems(data: NpsDetractorsByBranch): ShareBarItem[] {
  const sorted = [...data.branches].filter((b) => b.count > 0).sort((a, b) => b.count - a.count || a.branch.localeCompare(b.branch));
  let next = 0;
  return sorted.map((b) => {
    const unknown = b.key === null || b.branch === 'Unknown';
    return {
      key: b.key ?? `unknown-${b.branch}`,
      label: b.branch,
      detail: branchLabel(b.count, data.total),
      share: data.total ? b.count / data.total : 0,
      color: unknown ? UNKNOWN_GREY : CATEGORICAL_14[next++ % CATEGORICAL_14.length],
      title: `${b.branch}: ${formatNumber(b.count)} detractors (${pct1(b.count, data.total)} of detractors)`,
    };
  });
}

/**
 * Detractors by Branch (2026-11-15, round 4): one stacked bar = every detractor of the Detractors card (same filters and
 * dates), one segment per branch (effective sales team) sized by its share, biggest first; the legend under it wraps.
 * The segments add up to the card (the API groups the card's own rows).
 */
export function DetractorsByBranch({ state, cardTotal }: { state: State; cardTotal: number }) {
  const [downloading, setDownloading] = useState<'pdf' | 'image' | null>(null);
  const data = state.data;
  const total = data?.total ?? cardTotal;
  const items = data ? branchItems(data) : [];
  const title = `Detractors by Branch (${formatNumber(total)})`;
  const run = async (kind: 'pdf' | 'image', fn: () => Promise<void>) => {
    setDownloading(kind);
    try { await fn(); } finally { setDownloading(null); }
  };
  const exportImage = () => run('image', () => exportShareBarAsImage({
    title, subtitle: `${formatNumber(total)} detractors · share of each branch`, fileName: 'nps-detractors-by-branch',
    items: items.map((i) => ({ label: i.label, detail: i.detail, share: i.share, color: i.color })),
  }));
  const exportPdf = () => run('pdf', () => exportRowsAsPdf({
    title: 'Detractors by Branch',
    subtitle: `${formatNumber(total)} detractors`,
    columns: [{ header: 'Branch' }, { header: 'Detractors', align: 'right' }, { header: '% of detractors', align: 'right' }],
    rows: (data?.branches ? [...data.branches].sort((a, b) => b.count - a.count) : []).map((b) => [b.branch, formatNumber(b.count), pct1(b.count, total)]),
    fileName: 'nps-detractors-by-branch',
  }));
  return (
    <ChartPanel {...vh('process.npsScore.detractorsByBranch')} title={title} wrapHeader
      headerActions={items.length > 0 ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={exportImage} disabled={downloading !== null}>{downloading === 'image' ? 'Exporting…' : 'Export image'}</Button>
          <Button variant="secondary" onClick={exportPdf} disabled={downloading !== null}>{downloading === 'pdf' ? 'Exporting…' : 'Export as PDF'}</Button>
        </div>
      ) : undefined}>
      {state.error ? <ErrorState message={state.error} onRetry={state.retry} />
        : !data || state.loading ? <LoadingSkeleton variant="kpi" />
          : items.length === 0 ? <EmptyState message="No detractors for these filters and dates." />
            : (
              <ShareBar testId="nps-detractors-by-branch" items={items}
                ariaLabel={`Detractors by branch: ${items.map((i) => `${i.label} ${i.detail}`).join(', ')}`} />
            )}
    </ChartPanel>
  );
}
