'use client';
import React from 'react';
import Link from 'next/link';
import { Lock, Upload } from 'lucide-react';
import { EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import type { MarcomFilters } from '../../lib/marcom/filters';
import type { MarcomKpiError } from '../../lib/marcom/api';
import type { PageData, PageKey } from '../../lib/marcom/types';
import { t } from '../../lib/marcom/text';
import { MarcomFilterBar } from './MarcomFilterBar';
import { MarcomFreshness } from './MarcomFreshness';
import { GHOST_BTN } from './MarcomChartCard';

export interface MarcomPageViewProps<T extends PageData> {
  page: PageKey;
  title: string;
  filters: MarcomFilters;
  onFilters: (next: MarcomFilters) => void;
  onReset: () => void;
  data: T | null;
  error: MarcomKpiError | null;
  loading: boolean;
  refreshing: boolean;
  onRetry: () => void;
  /** The viewer holds admin_marcom_upload: show the upload link. */
  canUpload: boolean;
  children: (data: T) => React.ReactNode;
}

const UPLOAD_HREF = '/admin/marcom-upload';

function UploadLink({ label }: { label: string }) {
  return (
    <Link href={UPLOAD_HREF} data-testid="upload-link" style={{ ...GHOST_BTN, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <Upload size={13} aria-hidden="true" />
      {label}
    </Link>
  );
}

export function NoAccess() {
  return (
    <div role="alert" data-testid="no-access" style={{ minHeight: '40vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--ps-color-muted-text)', textAlign: 'center' }}>
      <Lock size={28} aria-hidden="true" />
      <h2 style={{ margin: 0, fontSize: 18, color: 'var(--ps-color-text)' }}>{t('state.noAccess')}</h2>
      <p style={{ margin: 0, fontSize: 13 }}>{t('state.noAccessHint')}</p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div data-testid="page-loading" aria-busy="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
      {Array.from({ length: 6 }, (_, i) => <div key={i} style={{ background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderRadius: 12, padding: 16, minHeight: 200 }}><LoadingSkeleton /></div>)}
    </div>
  );
}

/**
 * The frame every MARCOM page shares: title, freshness line, upload link (admins only), filter bar,
 * and the page-level states -- loading skeletons, no access (403), API error with Retry, "no data
 * uploaded yet" (with the upload link for admins), and "no data for these filters". Everything else
 * is delegated to the page's own view via `children(data)`.
 */
export function MarcomPageView<T extends PageData>(p: MarcomPageViewProps<T>) {
  const { data, error } = p;
  let body: React.ReactNode;

  if (error && error.status === 403) body = <NoAccess />;
  else if (p.loading) body = <SkeletonGrid />;
  else if (error && !data) body = <ErrorState message={error.status === 400 ? error.message : t('state.error')} onRetry={p.onRetry} />;
  else if (data && !data.freshness.hasData && !data.hasData) {
    body = (
      <div data-testid="no-data-uploaded" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '48px 16px', textAlign: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{t('state.noData')}</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{t('state.noDataHint')}</p>
        {p.canUpload && <UploadLink label={t('state.noDataAdmin')} />}
      </div>
    );
  } else if (data && !data.hasData) {
    body = <div data-testid="no-data-filters"><EmptyState message={t('state.empty')} onResetFilters={p.onReset} /></div>;
  } else if (data) {
    body = (
      <>
        {error && <div style={{ marginBottom: 12 }}><ErrorState message={t('state.error')} onRetry={p.onRetry} /></div>}
        {p.children(data)}
      </>
    );
  }

  const showFilters = !!data && !(error && error.status === 403) && !(data && !data.freshness.hasData && !data.hasData);

  return (
    <div data-testid="marcom-page" data-page={p.page} style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 'var(--ps-space-4, 24px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>{p.title}</h1>
          <MarcomFreshness freshness={data?.freshness} />
        </div>
        {p.canUpload && data && <UploadLink label={t('header.upload')} />}
      </div>
      {showFilters && data && (
        <MarcomFilterBar page={p.page} filters={p.filters} options={data.options} applied={data.filters} refreshing={p.refreshing} onChange={p.onFilters} onReset={p.onReset} />
      )}
      {body}
    </div>
  );
}
