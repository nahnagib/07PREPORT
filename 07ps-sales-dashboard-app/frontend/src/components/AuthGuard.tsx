'use client';
import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../lib/AuthProvider';
import type { PermissionAction } from '../lib/api';
import { firstAccessiblePath } from '../lib/navItems';
import { NoAccess } from './NoAccess';

const PUBLIC_ROUTES = new Set(['/login', '/forgot-password', '/reset-password']);

/**
 * Global session gate, mounted once in app/layout.tsx around every page. This is UX only --
 * "hide the page, redirect, show Unauthorized" -- the real enforcement is always server-side
 * (requireAuth/requirePasswordChangeCleared/requirePermission on the backend); a user who
 * defeated this guard client-side would still get a clean 401/403 from every API call.
 *
 * Enforces, in order:
 *   1. Public routes (login/forgot-password/reset-password) always render, no session needed.
 *   2. No session -> redirect to /login.
 *   3. Session exists but mustChangePassword -> redirect to /change-password, and nothing else is
 *      reachable until that flow completes (matches the backend's requirePasswordChangeCleared
 *      allowlist exactly: /auth/me, /auth/change-password, /auth/logout).
 *   4. Otherwise render children -- per-page View permission is enforced by <PermissionGuard>,
 *      not here, since only the page itself knows which pageKey it needs.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { loading, user, token, canView, isAdmin } = useAuth();
  const isPublicRoute = PUBLIC_ROUTES.has(pathname);
  const isChangePasswordRoute = pathname === '/change-password';

  useEffect(() => {
    if (loading) return;
    if (isPublicRoute) {
      // Signed in: start on the first page this user can actually open, not a fixed page.
      if (user && pathname === '/login') router.replace(firstAccessiblePath(canView, isAdmin));
      return;
    }
    if (!token || !user) {
      router.replace('/login');
      return;
    }
    if (user.mustChangePassword && !isChangePasswordRoute) {
      router.replace('/change-password');
    }
  }, [loading, isPublicRoute, isChangePasswordRoute, token, user, pathname, router, canView, isAdmin]);

  if (isPublicRoute) return <>{children}</>;

  if (loading || !token || !user || (user.mustChangePassword && !isChangePasswordRoute)) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ps-color-muted-text)',
          fontSize: 14,
        }}
      >
        Loading...
      </div>
    );
  }

  return <>{children}</>;
}

/** Per-page View-permission gate. Wrap a page's content with this once its pageKey is known --
 * hides the page and shows a clean Unauthorized state rather than a blank/broken screen, and
 * (per the spec) also prevents direct-URL access to a page the user can't view, not just hiding
 * it from navigation. Every API call the page then makes is still independently 403'd server-side
 * if permissions were somehow bypassed here. */
export function PermissionGuard({
  pageKey,
  action = 'view',
  children,
}: {
  pageKey: string;
  action?: PermissionAction;
  children: React.ReactNode;
}) {
  const { can } = useAuth();
  if (!can(pageKey, 'view') || !can(pageKey, action)) return <NoAccess />;
  return <>{children}</>;
}

/** Gate for the Admin-role-only sections (ETL Control Center, Audit Log). */
export function AdminOnlyGuard({ children }: { children: React.ReactNode }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return null;
  if (!isAdmin) return <NoAccess message="This section is available to the Admin role only." />;
  return <>{children}</>;
}
