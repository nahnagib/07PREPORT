'use client';
import React from 'react';
import { MarcomPage } from '../../../../components/marcom/MarcomPage';
import { TradeView } from '../../../../components/marcom/views/TradeView';
import { t } from '../../../../lib/marcom/text';
import type { TradeData } from '../../../../lib/marcom/types';

/** Trade Marketing & Retail -- data from GET /marcom/kpi/trade; gated by the `marcom_trade` view permission (migration 0022). */
export default function MarcomTradePage() {
  return (
    <MarcomPage<TradeData> page="trade" permissionKey="marcom_trade" title={t('page.trade')} navLabel="Trade Marketing & Retail">
      {({ data, refreshing, filters, setFilters }) => (
        <TradeView data={data} refreshing={refreshing} filters={filters} setFilters={setFilters} />
      )}
    </MarcomPage>
  );
}
