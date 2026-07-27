'use client';
import React from 'react';
import Image from 'next/image';
import { RefreshCw, Download, Bell } from 'lucide-react';
import { useBusinessUnit } from './BusinessUnitProvider';
import { useTheme } from './ThemeProvider';
import { BASE_PATH } from '../lib/basePath';

/**
 * Logo asset note: the source BMH files ("BenMussa Black.png" / "BenMussa White.png") are named
 * for their intended background, but their pixel content is swapped relative to that name
 * ("...White.png" actually contains black ink; "...Black.png" actually contains white ink).
 * Re-copied here under content-accurate names (bmh-mark-dark = dark ink for light backgrounds,
 * bmh-mark-light = light ink for dark backgrounds) so this component never has to guess.
 */
const bmhMark = {
  light: `${BASE_PATH}/logos/bmh/bmh-mark-dark.png`, // dark-ink mark, used on the light theme
  dark: `${BASE_PATH}/logos/bmh/bmh-mark-light.png`, // light-ink mark, used on the dark theme
};

const buLogo: Record<string, { light: string; dark: string; alt: string } | null> = {
  all: null,
  majaal: {
    light: `${BASE_PATH}/logos/majaal/majaal-mark-dark.png`,
    dark: `${BASE_PATH}/logos/majaal/majaal-mark-light.jpg`,
    alt: 'Majaal',
  },
  tika: { light: `${BASE_PATH}/logos/tika/tikalogo.png`, dark: `${BASE_PATH}/logos/tika/tikalogo.png`, alt: 'Tika' },
};

/**
 * Standards Section 3.2 - Header Design.
 * Left: BMH group logo always present; secondary BU logo (Majaal/Tika) appears when a single
 * business unit is selected (Section 3.12). Right: partner badge row + global action cluster
 * (refresh indicator, export, notifications). Fixed height 64px desktop / 56px mobile (Section 3.2).
 */
export function Header({ pageTitle }: { pageTitle: string }) {
  const { businessUnit } = useBusinessUnit();
  const { theme, toggle } = useTheme();
  const secondary = buLogo[businessUnit];

  return (
    <header
      className="flex items-center justify-between border-b"
      style={{
        height: 64,
        padding: '0 16px',
        background: 'var(--ps-color-surface)',
        borderColor: 'var(--ps-color-border)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      <div className="flex items-center gap-3">
        <Image
          src={theme === 'dark' ? bmhMark.dark : bmhMark.light}
          alt="Ben Moussa Holding"
          width={120}
          height={28}
          style={{ objectFit: 'contain', height: 28, width: 'auto' }}
          priority
        />
        {secondary && (
          <>
            <span aria-hidden style={{ color: 'var(--ps-color-border)' }}>
              |
            </span>
            <Image
              src={theme === 'dark' ? secondary.dark : secondary.light}
              alt={secondary.alt}
              width={80}
              height={24}
              style={{ objectFit: 'contain', height: 24, width: 'auto' }}
            />
          </>
        )}
        <h1 style={{ fontSize: 20, fontWeight: 700, marginLeft: 12 }}>{pageTitle}</h1>
      </div>

      <div className="flex items-center gap-4">
        {/* Partner badge row - Section 3.12: retained as a fixed brand strip, not user-configurable.
            Athens/SMG source image files were not provided in this session; slots are text-stubbed. */}
        <div className="hidden md:flex items-center gap-2" aria-label="Partner logos" style={{ opacity: 0.7 }}>
          <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>ATHENS</span>
          <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>SMG</span>
        </div>
        <button
          onClick={toggle}
          aria-label="Toggle dark mode"
          style={{
            border: '1px solid var(--ps-color-border)',
            borderRadius: 6,
            padding: '4px 10px',
            background: 'transparent',
            color: 'var(--ps-color-text)',
            fontSize: 12,
          }}
        >
          {theme === 'light' ? 'Dark mode' : 'Light mode'}
        </button>
        <button
          aria-label="Refresh"
          title="Refresh indicator"
          style={{
            display: 'flex',
            background: 'none',
            border: 'none',
            color: 'var(--ps-color-muted-text)',
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={18} />
        </button>
        <button
          aria-label="Notifications"
          title="Notifications"
          style={{
            display: 'flex',
            background: 'none',
            border: 'none',
            color: 'var(--ps-color-muted-text)',
            cursor: 'pointer',
          }}
        >
          <Bell size={18} />
        </button>
        {/* Modernization pass: Export is now a filled pill button (matches the reference mockup)
            instead of a bare icon - still a visual stub, no export logic wired up in this pass. */}
        <button
          aria-label="Export"
          title="Export (PDF / Excel / CSV)"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 999,
            border: 'none',
            background: 'var(--ps-color-nav-rail-bg)',
            color: '#ffffff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Download size={14} />
          Export
        </button>
      </div>
    </header>
  );
}
