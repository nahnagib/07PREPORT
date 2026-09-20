import React from 'react';
import type { Freshness } from '../../lib/marcom/types';
import { fmtTimestampDate } from '../../lib/marcom/format';
import { t } from '../../lib/marcom/text';

/** "Data as of <period> — uploaded by <user> on <date>": the data is manual, so its age is always visible. */
export function MarcomFreshness({ freshness }: { freshness: Freshness | null | undefined }) {
  if (!freshness?.hasData || !freshness.latestPeriod) return null;
  return (
    <p data-testid="marcom-freshness" style={{ margin: 0, fontSize: 12.5, color: 'var(--ps-color-muted-text)' }}>
      {t('freshness.line', {
        period: freshness.latestPeriod.label,
        user: freshness.uploadedBy ?? t('freshness.unknownUser'),
        date: fmtTimestampDate(freshness.uploadedAt),
      })}
    </p>
  );
}
