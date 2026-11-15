'use client';
import React, { useState } from 'react';
import { Button, CollapsibleSection, DataGrid, type DataGridColumn } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { ENTRY, pdp, upload, type Row } from '../../lib/pdp/api';
import { errorText, usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel, label } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { ActionButton, Chip, Empty, FormToggle, Loaded, Notice, PdpForm, Section, fields, fmtDate } from './ui';

/**
 * Administration. Who approves what -- governance members, gate sign-offs, checklist rules, scoring criteria,
 * settings, KPI targets -- and the one-time import are Admin role only (the API enforces it too); reference lists
 * (roadmap years, gap items, drop-downs) and policy drafts need data-entry Edit.
 */
export function Admin({ options, revision, refresh }: SectionProps) {
  const { isAdmin, canEdit } = useAuth();
  const reference = usePdp<Row>('/reference', revision);
  if (!isAdmin && !canEdit(ENTRY)) return <Notice tone="alert">{t.noAccess}</Notice>;
  return (
    <Loaded state={reference}>
      {(r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="pdp-admin">
          {(r.noApprover as string[]).map((g) => <Notice key={g} tone="alert">{t.noApprover} {g}. {t.noApproverHint}</Notice>)}
          {isAdmin ? (
            <>
              <CollapsibleSection title={t.admin.import} defaultOpen={false}><ImportPanel folder={Boolean(options.importFolder)} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.governance} defaultOpen={(r.noApprover as string[]).length > 0}><GovernanceAdmin r={r} options={options} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.settings} defaultOpen={false}><SettingsAdmin settings={r.settings} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.kpiTargets} defaultOpen={false}><KpiAdmin targets={r.kpiTargets} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.criteria} defaultOpen={false}><CriteriaAdmin criteria={r.criteria} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.gateRules} defaultOpen={false}><GateRulesAdmin r={r} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.checklists} defaultOpen={false}><ChecklistAdmin r={r} refresh={refresh} /></CollapsibleSection>
            </>
          ) : (
            <Notice tone="info">Governance members, gate rules, scoring criteria, settings, KPI targets and the import are for the Admin role.</Notice>
          )}
          {canEdit(ENTRY) && (
            <>
              <CollapsibleSection title={t.admin.roadmapYears} defaultOpen={false}><YearsAdmin years={r.roadmapYears} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.gaps} defaultOpen={false}><GapsAdmin gaps={r.gaps} options={options} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.dropdowns} defaultOpen={false}><DropdownAdmin options={options} refresh={refresh} /></CollapsibleSection>
              <CollapsibleSection title={t.admin.policy} defaultOpen={false}><PolicyAdmin revision={revision} refresh={refresh} /></CollapsibleSection>
            </>
          )}
        </div>
      )}
    </Loaded>
  );
}

// ------------------------------------------------------------------------------------------------ import

function ImportPanel({ folder, refresh }: { folder: boolean; refresh: () => void }) {
  const { token } = useAuth();
  const [files, setFiles] = useState<Record<string, File | null>>({ productTree: null, scoringMatrix: null, policy: null });
  const [useFolder, setUseFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Row | null>(null);
  async function run(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      for (const [k, f] of Object.entries(files)) if (f) fd.append(k, f);
      const r = await upload(`/import?${useFolder ? 'source=folder&' : ''}${commit ? 'commit=1' : ''}`, token, fd);
      setReport(r);
      if (commit) refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const input = (key: string, labelText: string, accept: string) => (
    <label className="ps-kaizen-field">
      <span>{labelText}</span>
      <input className="ps-kaizen-input" type="file" accept={accept} disabled={useFolder} onChange={(e) => setFiles((f) => ({ ...f, [key]: e.target.files?.[0] ?? null }))} />
    </label>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{t.admin.importHint}</p>
      <div className="ps-kaizen-form">
        {input('productTree', 'Product_Tree.xlsm', '.xlsm,.xlsx')}
        {input('scoringMatrix', 'RD_Scoring_Matrix.xlsx', '.xlsx')}
        {input('policy', 'R_D_Policy.docx', '.docx')}
        {folder && (
          <label className="ps-kaizen-field">
            <span>{t.admin.fromFolder}</span>
            <input type="checkbox" checked={useFolder} onChange={(e) => setUseFolder(e.target.checked)} />
          </label>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="secondary" disabled={busy} onClick={() => run(false)}>{busy ? t.saving : t.admin.preview}</Button>
        <Button disabled={busy} onClick={() => run(true)}>{t.admin.commit}</Button>
      </div>
      {error && <Notice tone="alert">{error}</Notice>}
      {report && <ImportReport r={report} />}
    </div>
  );
}

function ImportReport({ r }: { r: Row }) {
  const tables = Object.entries(r.tables as Record<string, Row>).map(([table, c]) => ({ table, ...c }));
  const tableCols: DataGridColumn<Row>[] = [{ key: 'table', header: 'Table' }, { key: 'created', header: 'Created', align: 'right' }, { key: 'updated', header: 'Updated', align: 'right' }, { key: 'skipped', header: 'Skipped', align: 'right' }];
  const corrCols: DataGridColumn<Row>[] = [{ key: 'sheet', header: 'Sheet' }, { key: 'cell', header: 'Cell' }, { key: 'field', header: 'Field' }, { key: 'from', header: 'From', render: (c) => <span dir="auto">{c.from}</span> }, { key: 'to', header: 'To', render: (c) => <span dir="auto">{c.to}</span> }];
  const matchCols: DataGridColumn<Row>[] = [
    { key: 'product', header: 'Xtreme product' },
    { key: 'candidates', header: 'Odoo candidates (confirm in the Product Tree)', width: 520, render: (m) => (m.candidates.length ? m.candidates.map((c: Row) => `${c.name} [${c.ProductKey}; ${c.match}]`).join(' · ') : 'No confident match'), rawValue: (m) => m.candidates.map((c: Row) => c.name).join(' | ') },
  ];
  return (
    <Section title={`Import report · ${r.mode === 'commit' ? 'imported' : 'preview (nothing written)'}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        <span>
          Tree: {r.tree.families} families, {r.tree.subfamilies} subfamilies, {r.tree.products} products ({Object.entries(r.tree.byStatus).map(([k, v]) => `${enumLabel(k)} ${v}`).join(', ')}); {r.tree.flexible} with a flexible launch date (as market needs).
          {r.policy && ` Policy v${r.policy.version}: ${r.policy.sections} sections (${r.policy.status}).`}
        </span>
        <DataGrid columns={tableCols} rows={tables} getRowId={(x) => x.table} enableFiltering={false} maxBodyHeight={null} />
        <strong>Spelling corrections ({(r.corrections as Row[]).length})</strong>
        {(r.corrections as Row[]).length ? <DataGrid columns={corrCols} rows={(r.corrections as Row[]).map((c, i) => ({ ...c, i }))} getRowId={(c) => String(c.i)} fileName="pdp-import-corrections" /> : <Empty message="No corrections were needed." />}
        {(r.unplaced as Row[]).length > 0 && <Notice tone="alert">Rows not placed: {(r.unplaced as Row[]).map((u) => `${u.sheet} row ${u.row} (${u.reason})`).join('; ')}</Notice>}
        {(r.scoring.problems as string[]).length > 0 && <Notice tone="alert">Scoring matrix: {(r.scoring.problems as string[]).join('; ')}</Notice>}
        {(r.warnings as string[]).map((w) => <Notice key={w} tone="watch">{w}</Notice>)}
        {(r.odooMatches as Row[]).length > 0 && <DataGrid columns={matchCols} rows={r.odooMatches} getRowId={(m) => m.product} fileName="pdp-odoo-match-proposals" />}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ governance

function GovernanceAdmin({ r, options, refresh }: { r: Row; options: Row; refresh: () => void }) {
  const { token } = useAuth();
  const cols: DataGridColumn<Row>[] = [
    { key: 'label', header: 'Role', width: 150 },
    {
      key: 'members',
      header: 'Members',
      width: 420,
      render: (role) => (role.members.length ? (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {role.members.map((m: Row) => (
            <span key={m.member_id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Chip color="var(--ps-color-accent)">{m.display_name}</Chip>
              <ActionButton variant="ghost" confirmText={`Remove ${m.display_name} from ${role.label}?`} onClick={() => pdp(`/admin/governance/${m.member_id}`, token, 'DELETE').then(refresh)}>×</ActionButton>
            </span>
          ))}
        </span>
      ) : <span style={{ color: 'var(--ps-color-alert)' }}>Nobody assigned</span>),
      rawValue: (role) => role.members.map((m: Row) => m.display_name).join(', '),
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <DataGrid columns={cols} rows={r.governance} getRowId={(x) => x.code} enableFiltering={false} maxBodyHeight={null} />
      <PdpForm spec={fields('roleCode!:select userId!:select')} options={options} submitLabel="Assign" onSaved={refresh} onSubmit={(v) => pdp('/admin/governance', token, 'POST', v)} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ settings / KPI targets

function SettingsAdmin({ settings, refresh }: { settings: Row; refresh: () => void }) {
  const { token } = useAuth();
  const keys = ['max_concurrent_projects', 'min_score', 'mix_target_planned', 'mix_target_unplanned', 'mix_target_innovation', 'fast_track_feasibility_hours', 'pilot_kg_min', 'pilot_kg_max', 'freeze_from_mmdd', 'freeze_to_mmdd'];
  return (
    <PdpForm
      spec={keys.map((k) => ({ key: k, type: k.startsWith('freeze') ? 'text' : 'number', required: !k.startsWith('freeze'), hint: k.startsWith('freeze') ? 'MM-DD; leave both empty for no freeze' : undefined }))}
      initial={settings}
      onSaved={refresh}
      onSubmit={(v) => pdp('/admin/settings', token, 'PUT', v)}
    />
  );
}

function KpiAdmin({ targets, refresh }: { targets: Row[]; refresh: () => void }) {
  const { token } = useAuth();
  const cols: DataGridColumn<Row>[] = [
    { key: 'label', header: 'KPI', width: 260 },
    { key: 'comparator', header: 'Rule', render: (k) => (k.comparator === 'gte' ? 'at least' : k.comparator === 'lte' ? 'at most' : 'exactly') },
    { key: 'target', header: 'Target', align: 'right', render: (k) => `${k.target}${k.unit === 'pct' ? '%' : k.unit === 'days' ? ' days' : ''}`, rawValue: (k) => k.target },
    {
      key: 'kpi_code',
      header: '',
      width: 260,
      render: (k) => <FormToggle label={t.edit}>{(close) => <PdpForm spec={[{ key: 'target', type: 'number', required: true }]} initial={{ target: k.target }} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/admin/kpi-targets/${k.kpi_code}`, token, 'PATCH', v)} />}</FormToggle>,
      rawValue: () => '',
    },
  ];
  return <DataGrid columns={cols} rows={targets} getRowId={(k) => k.kpi_code} enableFiltering={false} maxBodyHeight={null} />;
}

// ------------------------------------------------------------------------------------------------ scoring criteria

function CriteriaAdmin({ criteria, refresh }: { criteria: Row[]; refresh: () => void }) {
  const { token } = useAuth();
  const [draft, setDraft] = useState<Row[]>(() => criteria.map((c) => ({ ...c, meanings: [...c.meanings] })));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const total = draft.filter((c) => c.is_active).reduce((n, c) => n + Number(c.weight || 0), 0);
  const set = (i: number, patch: Row) => {
    setDraft((d) => d.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setSaved(false);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {draft.map((c, i) => (
        <div key={c.criterion_id ?? `new${i}`} className="ps-kaizen-form" style={{ borderBottom: '1px solid var(--ps-color-border)', paddingBottom: 12 }}>
          <label className="ps-kaizen-field"><span>Criterion</span><input className="ps-kaizen-input" value={c.name} onChange={(e) => set(i, { name: e.target.value })} /></label>
          <label className="ps-kaizen-field"><span>Weight</span><input className="ps-kaizen-input" type="number" min={0} max={100} value={c.weight} onChange={(e) => set(i, { weight: Number(e.target.value) })} /></label>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="ps-kaizen-field"><span>Meaning of {n}</span><input className="ps-kaizen-input" dir="auto" value={c.meanings[n]} onChange={(e) => set(i, { meanings: c.meanings.map((m: string, j: number) => (j === n ? e.target.value : m)) })} /></label>
          ))}
          <label className="ps-kaizen-field"><span>Active</span><input type="checkbox" checked={Boolean(c.is_active)} onChange={(e) => set(i, { is_active: e.target.checked })} /></label>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: total === 100 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)' }}>{t.admin.weightsTotal}: {total} / 100</span>
        <Button variant="secondary" onClick={() => setDraft((d) => [...d, { name: '', weight: 0, meanings: ['', '', '', '', '', ''], is_active: true }])}>{t.add} criterion</Button>
        <Button
          disabled={total !== 100}
          onClick={async () => {
            setError(null);
            try {
              await pdp('/admin/criteria', token, 'PUT', { criteria: draft });
              setSaved(true);
              refresh();
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          {t.save}
        </Button>
        {saved && <span role="status" style={{ color: 'var(--ps-color-success)' }}>{t.saved}</span>}
      </div>
      {error && <Notice tone="alert">{error}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ gate rules / checklist rules

function GateRulesAdmin({ r, refresh }: { r: Row; refresh: () => void }) {
  const { token } = useAuth();
  const roles = r.governance as Row[];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {(r.gateRules as Row[]).map((rule) => (
        <RuleEditor key={rule.rule_id} rule={rule} roles={roles} onSave={(v) => pdp(`/admin/gate-rules/${rule.rule_id}`, token, 'PATCH', v).then(refresh)} />
      ))}
    </div>
  );
}

function RuleEditor({ rule, roles, onSave }: { rule: Row; roles: Row[]; onSave: (v: Row) => Promise<unknown> }) {
  const [picked, setPicked] = useState<string[]>(rule.roles);
  const [mode, setMode] = useState<string>(rule.mode);
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ border: '1px solid var(--ps-color-border)', borderRadius: 10, padding: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{rule.gate} · {rule.label} {rule.appliesTo === 'UNPLANNED' && <Chip color="var(--ps-color-gold)">unplanned projects only</Chip>}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '8px 0' }}>
        {roles.map((ro) => (
          <label key={ro.code} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={picked.includes(ro.code)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, ro.code] : p.filter((x) => x !== ro.code)))} />
            {ro.label}
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="ps-kaizen-input" style={{ width: 180 }} value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode">
          <option value="ANY">{enumLabel('ANY')}</option>
          <option value="ALL">{enumLabel('ALL')}</option>
        </select>
        <ActionButton variant="primary" onClick={() => onSave({ roles: picked, mode }).catch((e) => { setError(errorText(e)); throw e; })}>{t.save}</ActionButton>
        {error && <span role="alert" style={{ color: 'var(--ps-color-alert)', fontSize: 12 }}>{error}</span>}
      </div>
    </div>
  );
}

function ChecklistAdmin({ r, refresh }: { r: Row; refresh: () => void }) {
  const { token } = useAuth();
  const cols: DataGridColumn<Row>[] = [
    { key: 'list_code', header: 'List', render: (c) => enumLabel(c.list_code), rawValue: (c) => enumLabel(c.list_code) },
    { key: 'label', header: 'Item', width: 260 },
    { key: 'owner_role_code', header: 'Owner role', rawValue: (c) => c.owner_role_code ?? '' },
    { key: 'needs_evidence', header: 'Needs file/link', render: (c) => (c.needs_evidence ? t.yes : '—'), rawValue: (c) => (c.needs_evidence ? 'Yes' : '') },
    {
      key: 'required',
      header: 'Required for the gate',
      render: (c) => (
        <ActionButton variant={c.required ? 'primary' : 'secondary'} onClick={() => pdp(`/admin/checklist-templates/${c.template_id}`, token, 'PATCH', { required: !c.required }).then(refresh)}>
          {c.required ? 'Required' : 'Optional'}
        </ActionButton>
      ),
      rawValue: (c) => (c.required ? 'Required' : 'Optional'),
    },
  ];
  return <DataGrid columns={cols} rows={r.checklistTemplates} getRowId={(c) => String(c.template_id)} fileName="pdp-checklist-rules" />;
}

// ------------------------------------------------------------------------------------------------ roadmap years / gaps / drop-downs

function YearsAdmin({ years, refresh }: { years: Row[]; refresh: () => void }) {
  const { token } = useAuth();
  const cols: DataGridColumn<Row>[] = [
    { key: 'year', header: 'Year', align: 'right' },
    { key: 'theme', header: 'Theme', width: 260, render: (y) => <span dir="auto">{y.theme}</span> },
    { key: 'notes', header: 'Notes', rawValue: (y) => y.notes ?? '' },
    {
      key: 'roadmap_year_id',
      header: '',
      width: 300,
      render: (y) => (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <FormToggle label={t.edit}>{(close) => <PdpForm spec={fields('year!:number theme! notes:textarea')} initial={y} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/admin/roadmap-years/${y.roadmap_year_id}`, token, 'PATCH', v)} />}</FormToggle>
          <ActionButton variant="ghost" confirmText={`Remove ${y.year} from the roadmap?`} onClick={() => pdp(`/admin/roadmap-years/${y.roadmap_year_id}`, token, 'DELETE').then(refresh)}>{t.remove}</ActionButton>
        </span>
      ),
      rawValue: () => '',
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <DataGrid columns={cols} rows={years} getRowId={(y) => String(y.roadmap_year_id)} enableFiltering={false} maxBodyHeight={null} />
      <FormToggle label={`${t.add} year`}>{(close) => <PdpForm spec={fields('year!:number theme! notes:textarea')} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp('/admin/roadmap-years', token, 'POST', v)} />}</FormToggle>
    </div>
  );
}

const GAP_FIELDS = 'category!:select item! ownerUserId:select status!:select dueDate:date notes:textarea';
const GAP_STATUS = { status: { options: ['open', 'in_progress', 'done'].map((v) => ({ value: v, label: enumLabel(v) })) } };

function GapsAdmin({ gaps, options, refresh }: { gaps: Row[]; options: Row; refresh: () => void }) {
  const { token } = useAuth();
  const cols: DataGridColumn<Row>[] = [
    { key: 'category', header: '5M', render: (g) => enumLabel(g.category), rawValue: (g) => enumLabel(g.category) },
    { key: 'item', header: 'Item', width: 240, render: (g) => <span dir="auto">{g.item}</span> },
    { key: 'owner_name', header: 'Owner', rawValue: (g) => g.owner_name ?? '' },
    { key: 'status', header: 'Status', render: (g) => enumLabel(g.status), rawValue: (g) => enumLabel(g.status) },
    { key: 'due_date', header: 'Due', render: (g) => fmtDate(g.due_date), rawValue: (g) => g.due_date ?? '' },
    {
      key: 'gap_id',
      header: '',
      width: 300,
      render: (g) => (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <FormToggle label={t.edit}>{(close) => <PdpForm spec={fields(GAP_FIELDS, GAP_STATUS)} options={options} initial={{ category: g.category, item: g.item, ownerUserId: g.owner_user_id, status: g.status, dueDate: g.due_date, notes: g.notes }} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/admin/gaps/${g.gap_id}`, token, 'PATCH', v)} />}</FormToggle>
          <ActionButton variant="ghost" confirmText="Remove this gap item?" onClick={() => pdp(`/admin/gaps/${g.gap_id}`, token, 'DELETE').then(refresh)}>{t.remove}</ActionButton>
        </span>
      ),
      rawValue: () => '',
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <DataGrid columns={cols} rows={gaps} getRowId={(g) => String(g.gap_id)} fileName="pdp-gaps" />
      <FormToggle label={`${t.add} gap item`}>{(close) => <PdpForm spec={fields(GAP_FIELDS, GAP_STATUS)} initial={{ status: 'open' }} options={options} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp('/admin/gaps', token, 'POST', v)} />}</FormToggle>
    </div>
  );
}

function DropdownAdmin({ options, refresh }: { options: Row; refresh: () => void }) {
  const { token } = useAuth();
  const cols: DataGridColumn<Row>[] = [
    { key: 'list_key', header: 'List', render: (v) => label(v.list_key), rawValue: (v) => label(v.list_key) },
    { key: 'label', header: 'Value', width: 260, render: (v) => <span dir="auto">{v.label}</span> },
    { key: 'is_active', header: 'Active', render: (v) => (v.is_active ? t.yes : t.no), rawValue: (v) => (v.is_active ? 'Yes' : 'No') },
    {
      key: 'value_id',
      header: '',
      width: 300,
      render: (v) => (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <FormToggle label="Rename">{(close) => <PdpForm spec={fields('label!')} initial={v} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(x) => pdp(`/admin/dropdowns/${v.value_id}`, token, 'PATCH', x)} />}</FormToggle>
          <ActionButton onClick={() => pdp(`/admin/dropdowns/${v.value_id}`, token, 'PATCH', { isActive: !v.is_active }).then(refresh)}>{v.is_active ? 'Deactivate' : 'Activate'}</ActionButton>
        </span>
      ),
      rawValue: () => '',
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <DataGrid columns={cols} rows={options.dropdowns} getRowId={(v) => String(v.value_id)} fileName="pdp-dropdowns" />
      <FormToggle label={`${t.add} value`}>{(close) => <PdpForm spec={fields('listKey!:select label!')} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp('/admin/dropdowns', token, 'POST', v)} />}</FormToggle>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ policy versions

function PolicyAdmin({ revision, refresh }: { revision: number; refresh: () => void }) {
  const { token } = useAuth();
  const policy = usePdp<Row>('/policy', revision);
  return (
    <Loaded state={policy}>
      {(d) => {
        const draft = (d.versions as Row[]).find((v) => v.status === 'draft');
        return draft ? <DraftEditor draft={draft} revision={revision} refresh={refresh} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, fontSize: 13 }}>
              In force: {d.version ? `v${d.version.version_label}, published ${fmtDate(d.version.published_at)}` : 'none'}. A new draft starts as a copy of it; published versions stay readable and are never edited.
            </p>
            <FormToggle label={t.admin.newDraft}>{(close) => <PdpForm spec={fields('versionLabel! notes:textarea', { versionLabel: { hint: 'e.g. 1.1' } })} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp('/admin/policy-versions', token, 'POST', v)} />}</FormToggle>
          </div>
        );
      }}
    </Loaded>
  );
}

function DraftEditor({ draft, revision, refresh }: { draft: Row; revision: number; refresh: () => void }) {
  const { token } = useAuth();
  const sections = usePdp<Row>(`/policy?version=${draft.version_id}`, revision);
  const id = draft.version_id;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Notice tone="watch">Draft v{draft.version_label}: not in force until published.</Notice>
      <Loaded state={sections}>
        {(d) => (
          <>
            {(d.sections as Row[]).map((sec) => (
              <FormToggle key={sec.section_id} label={`${sec.section_no}. ${sec.title}`}>
                {(close) => (
                  <PdpForm
                    spec={fields('sectionNo!:number title! body!:textarea')}
                    initial={{ sectionNo: sec.section_no, title: sec.title, body: sec.body }}
                    onCancel={close}
                    onSaved={() => { close(); refresh(); }}
                    onSubmit={(v) => pdp(`/admin/policy-versions/${id}/sections/${sec.section_id}`, token, 'PATCH', v)}
                    extraActions={<ActionButton variant="danger" confirmText="Delete this section from the draft?" onClick={() => pdp(`/admin/policy-versions/${id}/sections/${sec.section_id}`, token, 'DELETE').then(refresh)}>{t.remove}</ActionButton>}
                  />
                )}
              </FormToggle>
            ))}
          </>
        )}
      </Loaded>
      <FormToggle label={t.admin.addSection}>{(close) => <PdpForm spec={fields('sectionNo!:number title! body!:textarea')} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/admin/policy-versions/${id}/sections`, token, 'POST', v)} />}</FormToggle>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <ActionButton variant="primary" confirmText={`Publish v${draft.version_label}? It becomes the policy in force and can no longer be edited.`} onClick={() => pdp(`/admin/policy-versions/${id}/publish`, token, 'POST').then(refresh)}>{t.admin.publish}</ActionButton>
        <ActionButton variant="danger" confirmText="Discard this draft?" onClick={() => pdp(`/admin/policy-versions/${id}`, token, 'DELETE').then(refresh)}>{t.admin.discard}</ActionButton>
      </div>
    </div>
  );
}
