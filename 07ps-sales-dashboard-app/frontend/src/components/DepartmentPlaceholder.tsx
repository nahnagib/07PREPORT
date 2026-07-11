'use client';
import React from 'react';
import { Card } from '@07ps/ui';
import type { Department } from '../lib/departments';

/** Presentational "under development" body for the 6 departments that don't have a backend yet.
 * Frontend/routing only -- no data fetching, no permission logic beyond the global AuthGuard, per
 * spec ("do not build any backend or business logic for these pages yet"). */
export function DepartmentPlaceholder({ department }: { department: Department }) {
  const Icon = department.icon;
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--ps-space-4, 24px)' }}>
      <Card
        style={{
          maxWidth: 480,
          width: '100%',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--ps-space-3, 16px)',
          padding: 'var(--ps-space-6, 40px) var(--ps-space-4, 24px)',
        }}
      >
        <div
          aria-hidden
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 72,
            height: 72,
            borderRadius: 20,
            background: `color-mix(in srgb, ${department.accent} 18%, transparent)`,
            color: department.accent,
          }}
        >
          <Icon size={34} />
        </div>

        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{department.name}</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{department.pTerm}</p>
        </div>

        <p style={{ margin: 0, fontSize: 14, color: 'var(--ps-color-muted-text)' }}>
          This dashboard is currently under development.
        </p>

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            background: 'var(--ps-color-watch-bg)',
            color: 'var(--ps-color-watch)',
            border: '1px solid var(--ps-color-watch-border)',
          }}
        >
          🚧 Coming Soon
        </span>
      </Card>
    </div>
  );
}
