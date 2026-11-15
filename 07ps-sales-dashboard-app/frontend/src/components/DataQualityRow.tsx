'use client';
import React from 'react';
import { Card, SemanticBadge, VisualInfoIcons, type SemanticStatus, type VisualHelpContent } from '@07ps/ui';

/**
 * The admin-only "Data Quality" row (first on Pipeline Health; 2026-11-15 shared with the Product pages): a slim full-width
 * card under the validation bar -- title, "?", one summary line (a button when `onOpen` is given: it opens the records
 * behind it), an optional status badge and an optional line of per-issue counts. The page decides who sees it (admins).
 */
export interface DataQualityIssue {
  key: string;
  label: string;
  count: number;
}

export function DataQualityRow({
  title = 'Data Quality',
  help,
  interactions,
  summary,
  status,
  issues = [],
  onOpen,
  testId = 'data-quality-row',
}: {
  title?: string;
  help?: VisualHelpContent;
  interactions?: readonly string[];
  summary: string;
  status?: SemanticStatus;
  issues?: DataQualityIssue[];
  onOpen?: () => void;
  testId?: string;
}) {
  const withCounts = issues.filter((issue) => issue.count > 0);
  return (
    <div data-testid={testId} style={{ padding: '0 var(--ps-space-4, 24px)', marginTop: 'var(--ps-space-3, 16px)' }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>
            {(help || interactions) && <VisualInfoIcons title={title} help={help} interactions={interactions} />}
            {onOpen ? (
              <button
                type="button"
                onClick={onOpen}
                data-testid={`${testId}-open`}
                style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: 'var(--ps-color-accent)', textDecoration: 'underline', cursor: 'pointer', textAlign: 'start' }}
              >
                {summary}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{summary}</span>
            )}
          </div>
          {status && <SemanticBadge status={status} />}
        </div>
        {withCounts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 8, fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
            {withCounts.map((issue) => (
              <span key={issue.key}>
                {issue.label}: <strong style={{ color: 'var(--ps-color-text)' }}>{issue.count}</strong>
              </span>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
