'use client';
import React from 'react';
import { MarcomPage } from '../../../../components/marcom/MarcomPage';
import { DigitalView } from '../../../../components/marcom/views/DigitalView';
import { t } from '../../../../lib/marcom/text';
import type { DigitalData } from '../../../../lib/marcom/types';

/** Digital Performance -- data from GET /marcom/kpi/digital; gated by the `marcom_digital` view permission (migration 0022). */
export default function MarcomDigitalPage() {
  return (
    <MarcomPage<DigitalData> page="digital" permissionKey="marcom_digital" title={t('page.digital')} navLabel="Digital Performance">
      {({ data, refreshing, filters, setFilters }) => (
        <DigitalView data={data} refreshing={refreshing} />
      )}
    </MarcomPage>
  );
}
