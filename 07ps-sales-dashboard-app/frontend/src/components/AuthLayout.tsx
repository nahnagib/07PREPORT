'use client';
import React from 'react';
import Image from 'next/image';
import { Card } from '@07ps/ui';
import { useTheme } from './ThemeProvider';
import { BASE_PATH } from '../lib/basePath';

const bmhMark = {
  light: `${BASE_PATH}/logos/bmh/bmh-mark-dark.png`,
  dark: `${BASE_PATH}/logos/bmh/bmh-mark-light.png`,
};

/** Shared centered-card scaffold for every unauthenticated auth screen (login, forgot/reset
 * password) -- same brand lockup AppHeader uses, so these screens read as part of the same
 * product rather than a bolted-on login page. */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const { theme } = useTheme();
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--ps-color-page-bg)',
        padding: 'var(--ps-space-3, 16px)',
      }}
    >
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--ps-space-4, 24px)' }}>
          <Image
            src={theme === 'dark' ? bmhMark.dark : bmhMark.light}
            alt="Ben Moussa Holding"
            width={160}
            height={38}
            style={{ objectFit: 'contain', height: 38, width: 'auto' }}
            priority
          />
        </div>
        <Card>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px', color: 'var(--ps-color-text)' }}>{title}</h1>
          {subtitle && (
            <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', margin: '0 0 20px' }}>{subtitle}</p>
          )}
          {!subtitle && <div style={{ marginBottom: 20 }} />}
          {children}
        </Card>
      </div>
    </div>
  );
}
