'use client';
import React from 'react';
import { AppHeader } from '../AppHeader';
import { BottomNavBar } from '../BottomNavBar';
import { PermissionGuard } from '../AuthGuard';
import { useAuth } from '../../lib/AuthProvider';
import { useMarcomData, useMarcomFilters } from '../../lib/marcom/useMarcom';
import type { PageData, PageKey } from '../../lib/marcom/types';
import { MarcomPageView } from './MarcomPageView';

export interface MarcomPageProps<T extends PageData> {
  page: PageKey;
  /** The `pages.page_key` this route is gated by (migration 0022). */
  permissionKey: string;
  title: string;
  /** Label of this page's entry in the bottom navigation. */
  navLabel: string;
  children: (ctx: { data: T; refreshing: boolean; filters: ReturnType<typeof useMarcomFilters>['filters']; setFilters: ReturnType<typeof useMarcomFilters>['setFilters'] }) => React.ReactNode;
}

function Inner<T extends PageData>(p: MarcomPageProps<T>) {
  const { token, user, logout, canView } = useAuth();
  const { filters, setFilters, reset } = useMarcomFilters();
  const state = useMarcomData<T>(p.page, token, filters);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
      <AppHeader pageTitle={p.title} anchorDate="" onAnchorDateChange={() => undefined} roleLabel={user?.role.label ?? user?.fullName} onLogout={logout} showDateInput={false} />
      <main style={{ flex: 1 }}>
        <MarcomPageView<T>
          page={p.page} title={p.title} filters={filters} onFilters={setFilters} onReset={reset}
          data={state.data} error={state.error} loading={state.loading} refreshing={state.refreshing} onRetry={state.retry}
          canUpload={canView('admin_marcom_upload')}
        >
          {(data) => p.children({ data, refreshing: state.refreshing, filters, setFilters })}
        </MarcomPageView>
      </main>
      <BottomNavBar active={p.navLabel} />
    </div>
  );
}

/** Route-level container: permission gate + filters + data + chrome. The page body is the render prop. */
export function MarcomPage<T extends PageData>(p: MarcomPageProps<T>) {
  return (
    <PermissionGuard pageKey={p.permissionKey}>
      <Inner<T> {...p} />
    </PermissionGuard>
  );
}
