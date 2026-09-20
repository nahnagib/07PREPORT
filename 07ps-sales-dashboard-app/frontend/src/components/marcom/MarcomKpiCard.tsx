import React from 'react';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { Sparkline } from '@07ps/ui';
import type { Kpi, Status } from '../../lib/marcom/types';
import { deltaTone, fmtDelta, fmtKpiValue } from '../../lib/marcom/format';
import { t } from '../../lib/marcom/text';
import { RAG_COLOR } from '../../lib/marcom/palette';
import { RagBadge, ragLabel } from './RagBadge';

const SPARK_STATUS: Record<Status, 'success' | 'watch' | 'alert' | 'neutral'> = {
  green: 'success', yellow: 'watch', red: 'alert', neutral: 'neutral', na: 'neutral',
};

const TONE_COLOR = { good: 'var(--ps-color-success)', bad: 'var(--ps-color-alert)', flat: 'var(--ps-color-muted-text)', unknown: 'var(--ps-color-muted-text)' } as const;

export interface MarcomKpiCardProps {
  label: string;
  kpi?: Kpi | null;
  /** Overrides the formatted value (e.g. a headline built from several fields). */
  valueText?: string;
  /** Precision override for the value (see fmtKpiValue). */
  digits?: number;
  /** Hover text for the value (e.g. "3 min 30 s"). */
  valueTitle?: string;
  /** Small line under the value. */
  hint?: React.ReactNode;
  /** Monthly values, oldest first; drawn as a sparkline in the status colour. */
  sparkline?: (number | null)[];
  /** Hide the status chip (for cards that only carry a plain total). */
  hideStatus?: boolean;
  size?: 'md' | 'sm';
  testId?: string;
  children?: React.ReactNode;
}

/**
 * The ONE KPI tile used by all four MARCOM pages ("Box" = KPI card, never a box plot): big value,
 * label, RAG chip (icon + word), optional delta arrow whose good/bad colouring follows the API's
 * `direction`, optional sparkline. "neutral" gets the neutral chip; "na" shows "n/a" with a tooltip.
 */
export function MarcomKpiCard({ label, kpi, valueText, digits, valueTitle, hint, sparkline, hideStatus, size = 'md', testId, children }: MarcomKpiCardProps) {
  const status: Status = kpi?.status ?? 'na';
  const text = valueText ?? fmtKpiValue(kpi, digits);
  const isNa = status === 'na' || text === t('generic.na');
  const tone = deltaTone(kpi);
  const delta = fmtDelta(kpi);
  const small = size === 'sm';
  const spark = (sparkline ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const toneWord = tone === 'good' ? t('delta.better') : tone === 'bad' ? t('delta.worse') : t('delta.flat');
  const Arrow = tone === 'flat' || !kpi || typeof kpi.delta !== 'number' ? ArrowRight : kpi.delta > 0 ? ArrowUp : ArrowDown;

  return (
    <section
      data-testid={testId ?? 'kpi-card'}
      data-status={status}
      aria-label={`${label}: ${text}, ${ragLabel(status)}`}
      style={{
        background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderInlineStart: `4px solid ${RAG_COLOR[status]}`,
        borderRadius: 10, padding: small ? '10px 12px' : '14px 16px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: small ? 4 : 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: small ? 11.5 : 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>{label}</span>
        {!hideStatus && <RagBadge status={status} size="sm" />}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div
          data-testid="kpi-value"
          title={isNa ? t('rag.naReason') : valueTitle}
          style={{ fontSize: small ? 20 : 30, fontWeight: 700, lineHeight: 1.1, color: isNa ? 'var(--ps-color-muted-text)' : 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}
        >
          {text}
        </div>
        {spark.length >= 2 && !small && (
          <span aria-hidden="true"><Sparkline values={spark} status={SPARK_STATUS[status]} width={84} height={30} label={label} /></span>
        )}
      </div>

      {delta && tone && (
        <div
          data-testid="kpi-delta"
          data-tone={tone}
          title={`${delta} ${t('delta.vsPrevious')}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: TONE_COLOR[tone] }}
        >
          <Arrow size={13} aria-hidden="true" />
          <span>{delta}</span>
          <span style={{ fontWeight: 400, color: 'var(--ps-color-muted-text)' }}>{t('delta.vsPrevious')}</span>
          <span className="sr-only" style={SR_ONLY}>{toneWord}</span>
        </div>
      )}

      {hint && <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{hint}</div>}
      {children}
    </section>
  );
}

/** Visually hidden but available to screen readers (also used for the chart data tables). */
export const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
};
