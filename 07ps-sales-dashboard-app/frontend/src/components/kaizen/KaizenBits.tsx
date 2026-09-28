'use client';
import React from 'react';
import { Card } from '@07ps/ui';
import { kt as t, type KaizenTextKey } from '../../lib/kaizen/text';
import type { KaizenCard } from '../../lib/kaizen/api';
import type { useKaizenOptions } from './useKaizenOptions';

type Options = ReturnType<typeof useKaizenOptions>;

/** Open = red, Closed = green (the draft's colours, on the theme's semantic tokens). */
export const STATUS_COLOR = { OPEN: 'var(--ps-color-alert)', CLOSED: 'var(--ps-color-success)' } as const;

export function StatusPill({ status, overdue }: { status: KaizenCard['status']; overdue?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <span className="ps-kaizen-pill" style={{ background: `color-mix(in srgb, ${STATUS_COLOR[status]} 16%, transparent)`, color: STATUS_COLOR[status] }}>
        <span className="ps-kaizen-dot" style={{ background: STATUS_COLOR[status] }} />
        {t(`kaizen.status.${status}` as KaizenTextKey)}
      </span>
      {overdue && (
        <span className="ps-kaizen-pill" title={t('kaizen.overdueHint')} style={{ background: 'var(--ps-color-alert)', color: '#fff' }}>
          {t('kaizen.overdue')}
        </span>
      )}
    </span>
  );
}

/** A dropdown value with its chart colour. */
export function ValueTag({ id, options }: { id: number; options: Options }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="ps-kaizen-dot" style={{ background: options.colorOf(id) }} />
      {options.labelOf(id)}
    </span>
  );
}

/** KPI tile: label on top, big value + unit, optional sub-line; the whole tile is a button when
 * it links somewhere. Long department/person names wrap instead of overflowing. */
export function KaizenKpi({
  label,
  value,
  unit,
  sub,
  hint,
  onClick,
  accent,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  hint?: string;
  onClick?: () => void;
  accent?: string;
}) {
  const body = (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <span dir="auto" style={{ fontSize: value.length > 14 ? 16 : value.length > 8 ? 20 : 30, fontWeight: 800, lineHeight: 1.25, overflowWrap: 'break-word', minWidth: 0, color: accent ?? 'var(--ps-color-text)' }}>
          {value}
        </span>
        {unit && <span style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{sub}</div>}
    </>
  );
  return (
    <Card
      className={onClick ? 'ps-kaizen-tile' : undefined}
      title={hint}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
      style={{ minWidth: 0, borderInlineStart: `4px solid ${accent ?? 'var(--ps-color-accent)'}` }}
    >
      {body}
    </Card>
  );
}

/** Every field of a card, read-only (details page and the entry list's View). */
export function CardDetail({ card, options }: { card: KaizenCard; options: Options }) {
  const row = (labelKey: KaizenTextKey, value: React.ReactNode, wide = false) => (
    <div className={wide ? 'ps-kaizen-full' : undefined} style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 3 }}>{t(labelKey)}</div>
      {/* dir="auto": free text keeps its own direction, so Arabic typed into a card displays correctly. */}
      <div dir="auto" style={{ fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textAlign: 'start' }}>{value === null || value === '' ? '—' : value}</div>
    </div>
  );
  return (
    <div className="ps-kaizen-form">
      {row('kaizen.f.no', `#${card.card_no}`)}
      {row('kaizen.f.status', <StatusPill status={card.status} overdue={card.is_overdue} />)}
      {row('kaizen.f.cardName', <strong>{card.card_name}</strong>, true)}
      {row('kaizen.f.creator', card.creator_name)}
      {row('kaizen.f.date', card.card_date)}
      {row('kaizen.f.department', <ValueTag id={card.department_id} options={options} />)}
      {row('kaizen.f.type', <ValueTag id={card.card_type_id} options={options} />)}
      {row('kaizen.f.priority', <ValueTag id={card.priority_id} options={options} />)}
      {row('kaizen.f.responsible', card.responsible_party ?? t('kaizen.notAssigned'))}
      {row('kaizen.f.issue', card.issue, true)}
      {row('kaizen.f.rootCause', card.root_cause, true)}
      {row('kaizen.f.impact', card.impact, true)}
      {row('kaizen.f.solution', card.proposed_solution, true)}
      {row('kaizen.f.expectedDate', card.expected_date)}
      {row('kaizen.f.closerDate', card.closer_date)}
    </div>
  );
}
