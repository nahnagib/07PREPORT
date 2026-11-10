import type { CriticalNumberOverview } from './api';

/**
 * The line under the Daily Critical Number: which share of the group's base value the active filters get, and from
 * which year of Input/sales_targets.xlsx (backend measures/criticalNumber.ts computeTargetShare). `note` is set when
 * the share is not the anchor year's own (fallback year, or factor 1 because there are no targets / they could not be
 * read).
 */
export function criticalNumberShareLabel(
  data: Pick<CriticalNumberOverview, 'anchorDate' | 'share' | 'shareYear' | 'shareSource'>,
): { text: string; note: string | null } | null {
  if (data.share == null || data.shareSource == null) return null; // an older backend: no share in the response
  const year = Number(data.anchorDate.slice(0, 4));
  const pct = `${(data.share * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  switch (data.shareSource) {
    case 'current':
      return { text: `${pct} of group target · from sales_targets.xlsx ${data.shareYear}`, note: null };
    case 'fallback':
      return {
        text: `${pct} of group target · from sales_targets.xlsx ${data.shareYear}`,
        note: `sales_targets.xlsx has no ${year} targets yet, so the ${data.shareYear} shares are used.`,
      };
    case 'missing':
      return { text: 'Group value (100%)', note: `sales_targets.xlsx has no targets for ${year}: the filters do not split the value.` };
    case 'error':
      return { text: 'Group value (100%)', note: 'The targets could not be read: the filters do not split the value.' };
    default:
      return null;
  }
}
