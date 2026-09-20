'use client';
import React from 'react';
import { MarcomPage } from '../../../../components/marcom/MarcomPage';
import { CampaignsView } from '../../../../components/marcom/views/CampaignsView';
import { t } from '../../../../lib/marcom/text';
import type { CampaignsData } from '../../../../lib/marcom/types';

/** Media Campaign Performance -- data from GET /marcom/kpi/campaigns; gated by the `marcom_media_campaigns` view permission (migration 0022). */
export default function MarcomCampaignsPage() {
  return (
    <MarcomPage<CampaignsData> page="campaigns" permissionKey="marcom_media_campaigns" title={t('page.campaigns')} navLabel="Media Campaign Performance">
      {({ data, refreshing, filters, setFilters }) => (
        <CampaignsView data={data} refreshing={refreshing} />
      )}
    </MarcomPage>
  );
}
