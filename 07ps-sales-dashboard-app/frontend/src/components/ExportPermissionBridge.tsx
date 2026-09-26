'use client';
import React, { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { ExportPermissionContext, setExportAuthorizer, type ExportFormat } from '@07ps/ui';
import { useAuth } from '../lib/AuthProvider';
import { pageKeyForPath } from '../lib/navItems';
import { ApiError, authorizeExport } from '../lib/api';

/**
 * Connects @07ps/ui's export permission (packages/ui/src/exportPermission.ts) to the signed-in user:
 *
 *   - provides "can the current page export?" so every Export image / PDF / CSV / Excel control in
 *     the package, and the page-level export buttons that read useCanExport(), render only when the
 *     user has Export on the page the route belongs to;
 *   - registers the authorizer every export function awaits before producing a file: it asks the
 *     backend (POST /exports/authorize), so a user without Export gets a 403 and no file, even if a
 *     button were somehow reached.
 *
 * Mounted once in app/layout.tsx inside AuthProvider.
 */
export function ExportPermissionBridge({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { token, canExport } = useAuth();
  const pageKey = pageKeyForPath(pathname);
  const allowed = pageKey !== null && canExport(pageKey);

  const latest = useRef({ token, pageKey });
  latest.current = { token, pageKey };

  useEffect(() => {
    setExportAuthorizer(async (format: ExportFormat) => {
      const { token: t, pageKey: key } = latest.current;
      if (!t || !key) return false;
      try {
        await authorizeExport(t, key, format);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          window.alert('You do not have permission to export from this page.');
        }
        return false;
      }
    });
    return () => setExportAuthorizer(null);
  }, []);

  return <ExportPermissionContext.Provider value={allowed}>{children}</ExportPermissionContext.Provider>;
}
