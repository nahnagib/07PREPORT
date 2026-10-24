import React, { useId, useState } from 'react';
import { Cell, Pie, PieChart } from 'recharts';
import { EmptyState } from '@07ps/ui';
import { formatNumber } from '../../lib/format';
import { pct } from '../../lib/nps/view';

export interface PieItem {
  key: string;
  label: string;
  count: number;
  color: string;
  hint?: string;
}

/** A compact donut with its total in the center; detailed causes appear only on hover/focus/tap. */
export function ReasonPie({ items, ariaLabel, testId, totalLabel = 'Total' }: { items: PieItem[]; ariaLabel: string; testId: string; totalLabel?: string }) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const tooltipId = useId();
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const active = items.find((item) => item.key === activeKey);
  const share = (count: number) => pct(total > 0 ? 100 * count / total : 0);
  if (total === 0) return <EmptyState message={`No data for ${ariaLabel.toLowerCase()} in this period.`} />;

  return (
    <div className="ps-nps-pie" data-testid={testId}>
      <div className="ps-nps-pie-plot" role="img" aria-label={`${ariaLabel}. Total: ${formatNumber(total)}`}>
        <PieChart width={208} height={208}>
          <Pie data={items.filter((item) => item.count > 0)} dataKey="count" nameKey="label"
            cx="50%" cy="50%" innerRadius={64} outerRadius={94} stroke="var(--ps-card-bg)" strokeWidth={2}
            isAnimationActive={false} onMouseEnter={(item: PieItem) => setActiveKey(item.key)} onMouseLeave={() => setActiveKey(null)}>
            {items.filter((item) => item.count > 0).map((item) => <Cell key={item.key} fill={item.color} />)}
          </Pie>
        </PieChart>
        <div className="ps-nps-donut-center" aria-hidden="true">
          <strong>{formatNumber(total)}</strong>
          <span>{totalLabel}</span>
        </div>
      </div>
      <ul className="ps-nps-pie-legend" aria-label={`${ariaLabel} legend`}>
        {items.map((item) => (
          <li key={item.key} data-testid={`${testId}-${item.key}`}>
            <button type="button" className="ps-nps-pie-legend-item"
              aria-label={`${item.label}: ${formatNumber(item.count)} (${share(item.count)})`}
              aria-describedby={activeKey === item.key ? tooltipId : undefined}
              onMouseEnter={() => setActiveKey(item.key)} onMouseLeave={() => setActiveKey(null)}
              onFocus={() => setActiveKey(item.key)} onBlur={() => setActiveKey(null)}
              onClick={() => setActiveKey(item.key)}
              onKeyDown={(event) => { if (event.key === 'Escape') setActiveKey(null); }}>
              <span className="ps-nps-pie-swatch" style={{ background: item.color }} aria-hidden="true" />
              <span className="ps-nps-pie-label" dir="auto">{item.label}</span>
              <span className="ps-nps-pie-count">{formatNumber(item.count)} <span>({share(item.count)})</span></span>
            </button>
          </li>
        ))}
      </ul>
      {active && (
        <div id={tooltipId} role="tooltip" className="ps-nps-pie-tooltip">
          <strong dir="auto">{active.label}</strong>
          <div>{formatNumber(active.count)} ({share(active.count)})</div>
          {active.hint && <p dir="auto">{active.hint}</p>}
        </div>
      )}
    </div>
  );
}
