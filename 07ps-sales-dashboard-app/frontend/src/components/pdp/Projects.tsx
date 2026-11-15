'use client';
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, DataGrid, Select, TextInput, type DataGridColumn } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { BASE, ENTRY, pdp, type Row } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel, GATES, STATE_COLOR } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { Chip, Empty, ExportBar, Loaded, Notice, PdpForm, Section, fields, fmtDate, optionsFor } from './ui';
import s from './PdpVisuals.module.css';

const STATES = ['draft', 'submitted', 'active', 'on_hold', 'rejected', 'launched', 'closed'];

export function Projects({ options, revision }: SectionProps) {
  const { canCreate } = useAuth();
  const [view, setView] = useState<'board' | 'list'>('board');
  const [f, setF] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState('');
  const [fastTrack, setFastTrack] = useState(false);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v[0]) p.set(k, v[0]);
    if (search.trim()) p.set('search', search.trim());
    if (fastTrack) p.set('fastTrack', '1');
    return p.toString();
  }, [f, search, fastTrack]);
  const projects = usePdp<Row>(`/projects${query ? `?${query}` : ''}`, revision);
  const filtered = query.length > 0;
  const pick = (key: string, label: string, opts: { value: string | number; label: string }[] | undefined) => (
    <div style={{ width: 190 }}>
      <Select label={label} options={(opts ?? []).map((o) => ({ value: String(o.value), label: o.label }))} value={f[key] ?? []} onChange={(v) => setF((x) => ({ ...x, [key]: v.slice(-1) }))} placeholder="All" searchable />
    </div>
  );

  return (
    <>
      <div className={s.toolbar}>
        <div style={{ width: 220 }}>
          <TextInput label={t.search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code, title or product" />
        </div>
        {pick('classification', 'Classification', optionsFor('classification', options))}
        {pick('projectTypeId', 'Type', optionsFor('projectTypeId', options))}
        {pick('familyId', 'Family', optionsFor('familyId', options))}
        {pick('ownerUserId', 'Owner', optionsFor('ownerUserId', options))}
        {pick('state', 'State', STATES.map((v) => ({ value: v, label: enumLabel(v) })))}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, height: 38 }}>
          <input type="checkbox" checked={fastTrack} onChange={(e) => setFastTrack(e.target.checked)} /> {t.fastTrack}
        </label>
      </div>
      <Section
        title={t.tabs.projects}
        actions={
          <>
            <Button variant={view === 'board' ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setView('board')}>{t.projects.board}</Button>
            <Button variant={view === 'list' ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setView('list')}>{t.projects.list}</Button>
            <ExportBar area="projects" fileName="rd-projects.xlsx" />
            {canCreate(ENTRY) && (
              <Link href={`${BASE}/projects/new`} style={{ alignSelf: 'center', fontWeight: 700, fontSize: 13, color: 'var(--ps-color-accent)' }}>
                + {t.projects.newProject}
              </Link>
            )}
          </>
        }
        testId="pdp-projects"
      >
        <Loaded state={projects}>
          {(d) => {
            const rows = d.projects as Row[];
            if (rows.length === 0) return <Empty message={filtered ? t.empty.projectsFiltered : t.empty.projects} />;
            return view === 'board' ? <Board rows={rows} /> : <ProjectGrid rows={rows} />;
          }}
        </Loaded>
      </Section>
    </>
  );
}

function Board({ rows }: { rows: Row[] }) {
  return (
    <div className={s.board} data-testid="pdp-board">
      {GATES.map((g) => {
        const here = rows.filter((r) => (g.key === 'closed' ? r.state === 'closed' : r.state !== 'closed' && r.current_gate === g.key));
        return (
          <div key={g.key} className={s.column}>
            <div className={s.columnHead}>
              <span>
                {g.key === 'closed' ? 'Closed' : `${g.key} · ${g.name}`}
                <small>{g.step}</small>
              </span>
              <span>{here.length}</span>
            </div>
            {here.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{t.empty.gateColumn}</span>
            ) : (
              here.map((p) => (
                <Link key={p.code} href={`${BASE}/projects/${p.code}`} className={s.ticket}>
                  <strong>{p.code}</strong>
                  <div dir="auto" style={{ margin: '2px 0 6px' }}>{p.title}</div>
                  <div dir="auto" style={{ color: 'var(--ps-color-muted-text)', fontSize: 12 }}>{p.product_name ?? `${p.proposed_product_name} (new)`}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    <Chip color={STATE_COLOR[p.state]}>{enumLabel(p.state)}</Chip>
                    {p.fast_track && <Chip color="var(--ps-color-gold)">{t.fastTrack}</Chip>}
                    {p.late && <Chip color="var(--ps-color-alert)">{t.late}</Chip>}
                  </div>
                </Link>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProjectGrid({ rows }: { rows: Row[] }) {
  const columns: DataGridColumn<Row>[] = [
    { key: 'code', header: 'Code', width: 120, render: (r) => <Link href={`${BASE}/projects/${r.code}`}>{r.code}</Link>, rawValue: (r) => r.code },
    { key: 'title', header: 'Title', width: 240, render: (r) => <span dir="auto">{r.title}</span>, rawValue: (r) => r.title },
    { key: 'product_name', header: 'Product', render: (r) => <span dir="auto">{r.product_name ?? `${r.proposed_product_name} (new)`}</span>, rawValue: (r) => r.product_name ?? r.proposed_product_name ?? '' },
    { key: 'family_name', header: 'Family', rawValue: (r) => r.family_name ?? '' },
    { key: 'classification', header: 'Classification', render: (r) => enumLabel(r.classification), rawValue: (r) => enumLabel(r.classification) },
    { key: 'project_type', header: 'Type' },
    { key: 'owner_name', header: 'Owner', rawValue: (r) => r.owner_name ?? '' },
    { key: 'current_gate', header: 'Gate', filterOptions: GATES.slice(0, 6).map((g) => ({ value: g.key, label: g.key })) },
    { key: 'state', header: 'State', render: (r) => <Chip color={STATE_COLOR[r.state]}>{enumLabel(r.state)}</Chip>, rawValue: (r) => enumLabel(r.state), filterOptions: STATES.map((v) => ({ value: enumLabel(v), label: enumLabel(v) })) },
    { key: 'latest_score', header: 'Score', align: 'right', rawValue: (r) => r.latest_score ?? '' },
    { key: 'fast_track', header: 'Fast-track', render: (r) => (r.fast_track ? t.yes : '—'), rawValue: (r) => (r.fast_track ? t.yes : '') },
    { key: 'target_launch_date', header: 'Target launch', render: (r) => <span style={{ color: r.late ? 'var(--ps-color-alert)' : undefined }}>{fmtDate(r.target_launch_date)}</span>, rawValue: (r) => r.target_launch_date ?? '' },
  ];
  return <DataGrid columns={columns} rows={rows} getRowId={(r) => r.code} fileName="rd-projects" />;
}

/** New R&D request: linked to a Product Tree product, or proposing a new product in a subfamily (rule 1). */
export function NewProject({ options }: SectionProps) {
  const { token, canCreate } = useAuth();
  const router = useRouter();
  if (!canCreate(ENTRY)) return <Notice tone="alert">{t.noAccess}</Notice>;
  return (
    <Card style={{ maxWidth: 980 }}>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>{t.projects.newProject}</div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
        Link the request to an existing Product Tree product, or propose a new product with its subfamily. The project starts as a draft at G0; submitting it moves it to G1.
      </p>
      <PdpForm
        spec={fields('title! classification!:select projectTypeId!:select requestedBy! requestSourceId!:select productId:select proposedProductName proposedSubfamilyId:select innovationCategory:select ownerUserId:select targetLaunchDate:date fastTrack:checkbox objectives:textarea description:textarea', {
          productId: { hint: 'An existing product — or leave empty and fill the two "new product" fields.' },
          innovationCategory: { hint: 'Innovation projects only.' },
          ownerUserId: { hint: 'Defaults to the Technical Manager when exactly one is assigned.' },
        })}
        initial={{ classification: 'planned' }}
        options={options}
        submitLabel="Create draft"
        onCancel={() => router.push(`${BASE}/projects`)}
        onSubmit={async (v) => {
          const r = await pdp('/projects', token, 'POST', v);
          router.push(`${BASE}/projects/${r.code}`);
        }}
      />
    </Card>
  );
}
