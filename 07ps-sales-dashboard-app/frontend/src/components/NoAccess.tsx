'use client';
import React from 'react';
import Link from 'next/link';
import { ShieldX } from 'lucide-react';
import { useAuth } from '../lib/AuthProvider';
import { firstAccessiblePath } from '../lib/navItems';

/**
 * The 403 "No access" page, shown in place of any page (or admin section) the signed-in user may
 * not open -- whether they followed a link or typed the URL. Purely the UI half: every API the page
 * would call is refused by the backend on its own (403), so this can't be bypassed to reach data.
 */
export function NoAccess({ message }: { message?: string }) {
  const { canView, isAdmin, logout } = useAuth();
  const home = firstAccessiblePath(canView, isAdmin);

  return (
    <div
      role="main"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--ps-space-4, 24px)',
        background: 'var(--ps-color-page-bg)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          textAlign: 'center',
          background: 'var(--ps-color-surface)',
          border: '1px solid var(--ps-color-border)',
          borderRadius: 'var(--ps-card-radius, 14px)',
          boxShadow: 'var(--ps-card-shadow)',
          padding: 'var(--ps-space-5, 32px) var(--ps-space-4, 24px)',
        }}
      >
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            margin: '0 auto 16px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--ps-color-alert-bg)',
            color: 'var(--ps-color-alert)',
          }}
        >
          <ShieldX size={28} />
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, color: 'var(--ps-color-alert)' }}>403</div>
        <h1 style={{ margin: '4px 0 8px', fontSize: 22, fontWeight: 800, color: 'var(--ps-color-text)' }}>No access</h1>
        <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, color: 'var(--ps-color-muted-text)' }}>
          {message ?? "You don't have permission to view this page. If you need it, ask an administrator to update your role."}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link
            href={home}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
              background: 'var(--ps-color-accent)',
              color: 'var(--ps-color-on-accent)',
            }}
          >
            Go to my dashboard
          </Link>
          <button
            type="button"
            onClick={logout}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              background: 'var(--ps-color-muted-bg)',
              color: 'var(--ps-color-text)',
              border: '1px solid var(--ps-color-border)',
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
