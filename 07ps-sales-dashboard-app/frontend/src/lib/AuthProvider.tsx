'use client';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  EffectivePermissions,
  PublicUser,
  changePassword as apiChangePassword,
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
} from './api';

const TOKEN_STORAGE_KEY = 'ps_auth_token';

interface AuthContextValue {
  token: string | null;
  user: PublicUser | null;
  permissions: EffectivePermissions;
  /** True only while the stored token is being validated on first mount. */
  loading: boolean;
  /** Session-level error (token invalid/expired, backend unreachable) -- distinct from a single
   * login attempt's error, which login() returns/throws directly to the caller. */
  error: string | null;
  isSalesperson: boolean;
  salespersonKey: number | null;
  login: (email: string, password: string) => Promise<PublicUser>;
  logout: () => Promise<void>;
  /** Changes the password, then re-issues a fresh session from the new token (the backend
   * invalidates tokens issued before password_changed_at, so re-hydrating here is what keeps the
   * caller signed in through their own voluntary change instead of being bounced to /login). */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Re-validates the current token against /auth/me -- used after a password change re-issues a
   * token, or as the "Retry" action when the initial session hydration failed. */
  refreshMe: (nextToken?: string) => Promise<void>;
  retryAuth: () => void;
  canView: (pageKey: string) => boolean;
  canExport: (pageKey: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Real session provider, replacing DevAuthProvider (dev-only role switcher; see that file's own
 * header -- it always described itself as a stand-in for exactly this). Holds the JWT in
 * localStorage + a Bearer header on every API call (same pattern lib/api.ts's `request()` already
 * used throughout this codebase), NOT an httpOnly cookie -- a stronger option for XSS resistance,
 * but one that would require rewriting every existing api.ts call site to send credentials plus
 * CORS/cookie config across the separate frontend/backend ports. Documented here as a real
 * trade-off, not an oversight: worth revisiting if this app's threat model changes.
 *
 * Every route's actual protection is server-side (requireAuth/requirePermission on the backend)
 * regardless of what this provider does -- this is UX (redirect to /login, hide nav, show
 * Unauthorized), never the real enforcement boundary.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [permissions, setPermissions] = useState<EffectivePermissions>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hydrated = useRef(false);

  const applySession = useCallback((nextToken: string, nextUser: PublicUser, nextPermissions: EffectivePermissions) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setPermissions(nextPermissions);
    setError(null);
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
    setPermissions({});
  }, []);

  const refreshMe = useCallback(
    async (nextToken?: string) => {
      const useToken = nextToken ?? token ?? localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!useToken) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const { user: freshUser, permissions: freshPermissions } = await fetchMe(useToken);
        applySession(useToken, freshUser, freshPermissions);
      } catch (err) {
        clearSession();
        const message = err instanceof Error ? err.message : 'Your session has expired.';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [token, applySession, clearSession],
  );

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) {
      refreshMe(stored);
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await apiLogin(email, password);
      applySession(result.token, result.user, result.permissions);
      return result.user;
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    if (token) {
      try {
        await apiLogout(token);
      } catch {
        // Best-effort -- still clear the local session even if the revoke call itself fails
        // (e.g. token already expired), so the user is never stuck unable to sign out locally.
      }
    }
    clearSession();
    router.push('/login');
  }, [token, clearSession, router]);

  const changePasswordAndRehydrate = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!token) throw new Error('Not authenticated.');
      const { token: nextToken } = await apiChangePassword(token, currentPassword, newPassword);
      await refreshMe(nextToken);
    },
    [token, refreshMe],
  );

  const canView = useCallback((pageKey: string) => Boolean(permissions[pageKey]?.canView), [permissions]);
  const canExport = useCallback((pageKey: string) => Boolean(permissions[pageKey]?.canExport), [permissions]);

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        permissions,
        loading,
        error,
        isSalesperson: user?.isSalesperson ?? false,
        salespersonKey: user?.salespersonKey ?? null,
        login,
        logout,
        changePassword: changePasswordAndRehydrate,
        refreshMe,
        retryAuth: () => refreshMe(),
        canView,
        canExport,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
