'use client';
import React, { useState } from 'react';
import { DataGrid, Select, type DataGridColumn } from '@07ps/ui';
import { type Row } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { Chip, Empty, Loaded, Notice, Section, fmtDate } from './ui';
import s from './PdpVisuals.module.css';

/** The current policy version read-only (older versions selectable), the scoring matrix, governance and the 5M gaps. */
export function Policy({ revision }: SectionProps) {
  const [version, setVersion] = useState<string[]>([]);
  const policy = usePdp<Row>(`/policy${version[0] ? `?version=${version[0]}` : ''}`, revision);
  const reference = usePdp<Row>('/reference', revision);

  return (
    <>
      <Loaded state={policy}>
        {(d) => (
          <Section
            title={d.version ? `${d.version.title} · v${d.version.version_label}` : 'TIKA R&D Policy'}
            actions={
              (d.versions as Row[]).length > 0 ? (
                <div style={{ width: 240 }}>
                  <Select
                    label={t.policy.version}
                    options={(d.versions as Row[]).map((v) => ({ value: String(v.version_id), label: `v${v.version_label} · ${v.status === 'published' ? `published ${fmtDate(v.published_at)}` : 'draft'}` }))}
                    value={version.length ? version : d.version ? [String(d.version.version_id)] : []}
                    onChange={(v) => setVersion(v.slice(-1))}
                  />
                </div>
              ) : undefined
            }
            testId="pdp-policy"
          >
            {!d.version ? (
              <Empty message={t.empty.policy} />
            ) : (
              <>
                {d.version.status === 'draft' && <Notice tone="watch">This is a draft: it is not the policy in force until an admin publishes it.</Notice>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
                  {(d.sections as Row[]).map((sec) => (
                    <article key={sec.section_id}>
                      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>
                        {sec.section_no}. {sec.title}
                      </h3>
                      <div dir="auto" style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.55 }}>{sec.body}</div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </Section>
        )}
      </Loaded>
      <Loaded state={reference}>
        {(r) => (
          <>
            <ScoringGuide criteria={r.criteria as Row[]} minScore={r.settings.min_score} />
            <div className={s.two}>
              <Governance roles={r.governance as Row[]} warnings={r.noApprover as string[]} />
              <Gaps gaps={r.gaps as Row[]} />
            </div>
          </>
        )}
      </Loaded>
    </>
  );
}

function ScoringGuide({ criteria, minScore }: { criteria: Row[]; minScore: number }) {
  const rows = criteria.filter((c) => c.is_active);
  const cols: DataGridColumn<Row>[] = [
    { key: 'name', header: 'Criterion', width: 170 },
    { key: 'weight', header: 'Weight', align: 'right' },
    ...[0, 1, 2, 3, 4, 5].map((n) => ({ key: `m${n}`, header: String(n), width: 150, render: (c: Row) => <span style={{ fontSize: 12.5 }}>{c.meanings[n]}</span>, rawValue: (c: Row) => c.meanings[n] })),
  ];
  return (
    <Section title={t.policy.scoring} help={{ definition: t.policy.scoringHelp, formula: `weighted = score × weight ÷ 5 · total out of 100 · minimum ${minScore}` }}>
      {rows.length ? <DataGrid columns={cols} rows={rows} getRowId={(c) => String(c.criterion_id)} enableFiltering={false} fileName="rd-scoring-matrix" maxBodyHeight={null} /> : <Empty message={t.empty.criteria} />}
    </Section>
  );
}

function Governance({ roles, warnings }: { roles: Row[]; warnings: string[] }) {
  const cols: DataGridColumn<Row>[] = [
    { key: 'label', header: 'Role', width: 140 },
    { key: 'responsibility', header: 'Responsibility', width: 260, rawValue: (r) => r.responsibility ?? '' },
    { key: 'members', header: 'Members', render: (r) => (r.members.length ? r.members.map((m: Row) => m.display_name).join(', ') : <span style={{ color: 'var(--ps-color-alert)' }}>Nobody assigned</span>), rawValue: (r) => r.members.map((m: Row) => m.display_name).join(', ') },
  ];
  return (
    <Section title={t.policy.governance}>
      {warnings.map((g) => <div key={g} style={{ marginBottom: 6 }}><Notice tone="alert">{t.noApprover} {g}. {t.noApproverHint}</Notice></div>)}
      {roles.length ? <DataGrid columns={cols} rows={roles} getRowId={(r) => r.code} enableFiltering={false} maxBodyHeight={null} /> : <Empty message={t.empty.governance} />}
    </Section>
  );
}

function Gaps({ gaps }: { gaps: Row[] }) {
  const color: Record<string, string> = { open: 'var(--ps-color-alert)', in_progress: 'var(--ps-color-gold)', done: 'var(--ps-color-success)' };
  const cols: DataGridColumn<Row>[] = [
    { key: 'category', header: '5M', render: (g) => enumLabel(g.category), rawValue: (g) => enumLabel(g.category) },
    { key: 'item', header: 'Item', width: 240, render: (g) => <span dir="auto">{g.item}</span>, rawValue: (g) => g.item },
    { key: 'owner_name', header: 'Owner', rawValue: (g) => g.owner_name ?? '' },
    { key: 'status', header: 'Status', render: (g) => <Chip color={color[g.status]}>{enumLabel(g.status)}</Chip>, rawValue: (g) => g.status },
    { key: 'due_date', header: 'Due', render: (g) => fmtDate(g.due_date), rawValue: (g) => g.due_date ?? '' },
  ];
  return (
    <Section title={t.policy.gaps} help={{ definition: 'Gap analysis from the roadmap deck (slide 9): Manpower, Machine, Materials, Methods, Measurements. Editable under Administration.' }}>
      {gaps.length ? <DataGrid columns={cols} rows={gaps} getRowId={(g) => String(g.gap_id)} fileName="rd-gap-analysis" maxBodyHeight={null} /> : <Empty message={t.empty.gaps} />}
    </Section>
  );
}
