'use client';
import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../lib/AuthProvider';

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
  const { loading, user, token } = useAuth();
  const isPublicRoute = PUBLIC_ROUTES.has(pathname);
  const isChangePasswordRoute = pathname === '/change-password';

  useEffect(() => {
    if (loading) return;
    if (isPublicRoute) {
      if (user && pathname === '/login') router.replace('/');
      return;
    }
    if (!token || !user) {
      router.replace('/login');
      return;
    }
    if (user.mustChangePassword && !isChangePasswordRoute) {
      router.replace('/change-password');
    }
  }, [loading, isPublicRoute, isChangePasswordRoute, token, user, pathname, router]);

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
export function PermissionGuard({ pageKey, children }: { pageKey: string; children: React.ReactNode }) {
  const { canView } = useAuth();
  if (!canView(pageKey)) {
    return (
      <div
        style={{
          minHeight: '60vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: 'var(--ps-color-muted-text)',
          textAlign: 'center',
          padding: 32,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, color: 'var(--ps-color-text)' }}>Access restricted</h2>
        <p style={{ margin: 0, fontSize: 14 }}>You don&apos;t have permission to view this page.</p>
      </div>
    );
  }
  return <>{children}</>;
}
