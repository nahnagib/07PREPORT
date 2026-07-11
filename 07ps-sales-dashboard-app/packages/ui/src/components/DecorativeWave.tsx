import React from 'react';
import type { SemanticStatus } from './KpiTile';

const waveColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

/**
 * Modernization pass: a subtle, status-tinted decorative wave sitting behind a card's
 * reference-metric row (purely visual - `aria-hidden`, `pointer-events: none`, and low opacity so
 * it never competes with the actual numbers for attention or fails a contrast check, since the
 * text in front of it already meets contrast against the plain card background alone). Shared by
 * GaugeCard and StatCard rather than duplicated inline, since any future compact KPI card gets the
 * same cohesive "tinted by its own status" treatment for free.
 */
export function DecorativeWave({ status }: { status: SemanticStatus }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 200 60"
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        opacity: 0.1,
        pointerEvents: 'none',
      }}
    >
      <path
        d="M0,42 C35,15 55,55 95,32 C135,10 155,52 200,28 L200,60 L0,60 Z"
        fill={waveColorVar[status]}
      />
    </svg>
  );
}
