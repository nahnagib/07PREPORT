'use client';
import React from 'react';
import { Button } from '@07ps/ui';
import type { PeriodGranularity } from '../lib/api';
import { GRANULARITY_LABEL, PERIOD_GRANULARITIES, WINDOW_LABEL } from '../lib/periods';

/**
 * The ONE period selector of every time-trend visual: Daily | Weekly | Monthly | Yearly (lib/periods.ts). Weekly is the
 * default on every page load; the page keeps the choice in its own state (not saved across sessions). Goes in a
 * ChartPanel's headerActions; one selector per page drives every trend on it (Collections and NPS keep one per chart).
 */
export function PeriodTrendSelector({
  value,
  onChange,
  label = 'Trend period',
}: {
  value: PeriodGranularity;
  onChange: (g: PeriodGranularity) => void;
  /** the group's accessible name, e.g. "Sales Trend period" */
  label?: string;
}) {
  return (
    <div className="ps-nps-switch ps-period-selector" role="group" aria-label={label} data-testid="period-trend-selector">
      {PERIOD_GRANULARITIES.map((g) => (
        <Button
          key={g}
          variant={g === value ? 'primary' : 'secondary'}
          style={{ padding: '4px 10px', fontSize: 12 }}
          onClick={() => onChange(g)}
          aria-pressed={g === value}
          title={`${GRANULARITY_LABEL[g]}: the ${WINDOW_LABEL[g]}, the current period in progress`}
        >
          {GRANULARITY_LABEL[g]}
        </Button>
      ))}
    </div>
  );
}
