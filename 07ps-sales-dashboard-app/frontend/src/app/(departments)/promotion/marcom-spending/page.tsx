'use client';
import React from 'react';
import { MarcomPage } from '../../../../components/marcom/MarcomPage';
import { SpendingView } from '../../../../components/marcom/views/SpendingView';
import { t } from '../../../../lib/marcom/text';
import type { SpendingData } from '../../../../lib/marcom/types';

/** MARCOM Spending -- data from GET /marcom/kpi/spending; gated by the `marcom_spending` view permission (migration 0022). */
export default function MarcomSpendingPage() {
  return (
    <MarcomPage<SpendingData> page="spending" permissionKey="marcom_spending" title={t('page.spending')} navLabel="MARCOM Spending">
      {({ data, refreshing, filters, setFilters }) => (
        <SpendingView data={data} refreshing={refreshing} />
      )}
    </MarcomPage>
  );
}
