'use client';
import { useEffect, useRef } from 'react';
import { setPdfExportContextProvider } from '@07ps/ui';
import { useAuth } from '../lib/AuthProvider';
import { useFilterOptions } from '../lib/hooks';
import { useFilterState } from './FilterProvider';

/**
 * Registers the app-wide PDF export context (see packages/ui/src/pdfExportContext.ts) so every
 * client-side PDF -- exportRowsAsPdf, exportPerformanceTablePdf, DataGrid's Export as PDF -- lists
 * the active filters (resolved to names, never raw keys/counts) and "Exported by <signed-in email>"
 * without each page building its own. The email is the authenticated session's user, not a value
 * any page supplies. Mounted once in app/layout.tsx inside AuthProvider + FilterProvider.
 */
export function PdfExportContextBridge() {
  const { user, token, error: authError, retryAuth } = useAuth();
  const { effectiveFilters: f, dateFromDate, dateToDate } = useFilterState();
  const options = useFilterOptions(token, authError, retryAuth, f);

  // The provider closure reads the latest render's values via a ref, so a stale closure can never
  // export yesterday's filters.
  const latest = useRef({ user, f, dateFromDate, dateToDate, options });
  latest.current = { user, f, dateFromDate, dateToDate, options };

  useEffect(() => {
    setPdfExportContextProvider(() => {
      const { user: u, f: filters, dateFromDate: from, dateToDate: to, options: o } = latest.current;
      const parts: string[] = [];
      if (from && to) parts.push(from === to ? `Date: ${from}` : `Date Range: ${from} to ${to}`);

      // Resolve each selected key to its name; if an option list hasn't loaded, say how many are
      // selected rather than silently omitting an active filter.
      const add = (label: string, keys: (string | number)[] | undefined, names: (string | null | undefined)[] | undefined) => {
        if (!keys?.length) return;
        const resolved = (names ?? []).filter((n): n is string => !!n);
        parts.push(`${label}: ${resolved.length ? resolved.join(', ') : `${keys.length} selected`}`);
      };
      add('Company', filters.companyKeys, o.businessUnits.data?.filter((b) => filters.companyKeys!.includes(b.company_key as number)).map((b) => b.company_name as string));
      add('Customer Group', filters.segmentKeys, o.customerGroups.data?.filter((s) => filters.segmentKeys!.includes(s.segment_key as number)).map((s) => s.segment_name as string));
      add('Distribution Channel', filters.channelKeys, o.distributionChannels.data?.filter((c) => filters.channelKeys!.includes(c.channel_key as number)).map((c) => c.channel_name as string));
      add('Branch', filters.salesTeamKeys, o.branches.data?.filter((b) => filters.salesTeamKeys!.includes(b.sales_team_key as string)).map((b) => b.sales_team_name as string));
      add('Salesperson', filters.salespersonKeys, o.salespersons.data?.filter((s) => filters.salespersonKeys!.includes(s.salesperson_key as number)).map((s) => s.salesperson_name as string));

      return { filterParts: parts, exportedByEmail: u?.email ?? null };
    });
    return () => setPdfExportContextProvider(null);
  }, []);

  return null;
}
