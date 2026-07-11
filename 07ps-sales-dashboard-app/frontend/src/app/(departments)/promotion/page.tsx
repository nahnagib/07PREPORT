'use client';
import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AppHeader } from '../../../components/AppHeader';
import { Card } from '@07ps/ui';
import { useAuth } from '../../../lib/AuthProvider';
import { NAV_ITEMS } from '../../../lib/navItems';

/**
 * Promotion department mini-hub -- the "Promotion Dashboard" landing page
 * (bmh.com.ly/Dashboard/promotion), one level below the 7Ps Dashboard Hub and one level above the
 * actual Tachometer report (bmh.com.ly/Dashboard/promotion/tachometer). Lists every report this
 * department has, reusing the existing `NAV_ITEMS` single-source-of-truth list (same permission
 * gate `canView(pageKey)` as `BottomNavBar`) so a future Promotion report just needs an entry added
 * there and it appears here automatically. Only Tachometer is built today; the rest render as
 * disabled "coming soon" cards, exactly like `BottomNavBar` already treats them.
 */
export default function PromotionHubPage() {
  const { user, canView, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const items = NAV_ITEMS.filter((item) => canView(item.pageKey));

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppHeader
        pageTitle="Promotion — Sales Department"
        anchorDate=""
        onAnchorDateChange={() => {}}
        roleLabel={roleLabel}
        onLogout={logout}
        showDateInput={false}
      />

      <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
        <p style={{ margin: '0 0 var(--ps-space-4, 24px)', fontSize: 14, color: 'var(--ps-color-muted-text)' }}>
          Reports available in the Promotion (Sales) department.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 'var(--ps-space-3, 16px)',
          }}
        >
          {items.map(({ label, icon: Icon, href }) => {
            const live = Boolean(href);
            const content = (
              <Card
                className={live ? 'ps-hub-card' : ''}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  height: '100%',
                  opacity: live ? 1 : 0.55,
                  cursor: live ? 'pointer' : 'not-allowed',
                }}
              >
                <div
                  aria-hidden
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: 'var(--ps-color-accent-bg)',
                    color: 'var(--ps-color-accent)',
                  }}
                >
                  <Icon size={22} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{label}</div>
                <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', flex: 1 }}>
                  {live ? 'Live report, wired to the validation warehouse.' : 'Not built yet.'}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: live ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)',
                  }}
                >
                  {live ? 'Open report' : 'Coming Soon'}
                  {live && <ArrowRight size={14} />}
                </div>
              </Card>
            );

            return href ? (
              <Link key={label} href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
                {content}
              </Link>
            ) : (
              <div key={label} aria-disabled title={`${label} — not built yet`}>
                {content}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
