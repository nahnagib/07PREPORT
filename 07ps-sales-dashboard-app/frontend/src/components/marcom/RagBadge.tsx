import React from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, MinusCircle, XCircle } from 'lucide-react';
import type { Status } from '../../lib/marcom/types';
import { t } from '../../lib/marcom/text';
import { RAG_BG, RAG_COLOR } from '../../lib/marcom/palette';

const ICON = {
  green: CheckCircle2,
  yellow: AlertTriangle,
  red: XCircle,
  neutral: MinusCircle,
  na: HelpCircle,
} as const;

export const ragLabel = (s: Status): string => t(`rag.${s}` as 'rag.green');

/**
 * Status chip: icon + WORD + colour, so RAG never depends on colour alone. The text always uses the
 * theme's primary text colour (AA contrast on the tinted background in both themes, checked in
 * contrast.test.ts); the status colour is carried by the border and icon, which only need 3:1.
 */
export function RagBadge({ status, size = 'md', title }: { status: Status; size?: 'sm' | 'md'; title?: string }) {
  const Icon = ICON[status];
  const small = size === 'sm';
  return (
    <span
      data-testid="rag-badge"
      data-status={status}
      title={title ?? (status === 'na' ? t('rag.naReason') : undefined)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
        padding: small ? '1px 6px' : '2px 8px', borderRadius: 999,
        fontSize: small ? 11 : 12, fontWeight: 600,
        color: 'var(--ps-color-text)', background: RAG_BG[status], border: `1px solid ${RAG_COLOR[status]}`,
      }}
    >
      <Icon size={small ? 12 : 14} aria-hidden="true" style={{ color: RAG_COLOR[status], flex: 'none' }} />
      {ragLabel(status)}
    </span>
  );
}
