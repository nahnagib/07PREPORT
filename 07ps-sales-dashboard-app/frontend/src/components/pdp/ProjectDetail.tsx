'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, DataGrid, type DataGridColumn } from '@07ps/ui';
import { OdooLink } from '../OdooLink';
import { useAuth } from '../../lib/AuthProvider';
import { APPROVAL, BASE, download, ENTRY, pdp, upload, type Row } from '../../lib/pdp/api';
import { errorText, usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel, GATES, STATE_COLOR, STATUS_COLOR } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { ActionButton, Chip, Details, Empty, FormToggle, Loaded, Notice, PdpForm, Section, fields, fmtDate } from './ui';
import s from './PdpVisuals.module.css';

const GATE_ORDER = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'];

export function ProjectDetail({ options, revision, refresh, code }: SectionProps & { code: string }) {
  const project = usePdp<Row>(`/projects/${encodeURIComponent(code)}`, revision);
  return (
    <Loaded state={project}>
      {(d) => <ProjectBody d={d} options={options} refresh={refresh} revision={revision} />}
    </Loaded>
  );
}

function ProjectBody({ d, options, refresh, revision }: { d: Row; options: Row; refresh: () => void; revision: number }) {
  const { token, canEdit, canCreate, canDelete, isAdmin } = useAuth();
  const router = useRouter();
  const p = d.project as Row;
  const code = p.code as string;
  const readOnly = !isAdmin && ['closed', 'rejected'].includes(p.state);
  const entry = canEdit(ENTRY) && !readOnly;
  const post = (path: string, body: Row = {}) => pdp(`/projects/${code}${path}`, token, 'POST', body).then(refresh);
  const gateIdx = p.state === 'closed' ? 6 : GATE_ORDER.indexOf(p.current_gate) + (p.state === 'launched' ? 1 : 0);
  const myRoles: string[] = options.myRoles ?? [];

  return (
    <>
      <Card data-testid="pdp-project-header">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{code}</div>
            <h2 style={{ margin: '2px 0 6px', fontSize: 20 }} dir="auto">{p.title}</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Chip color={STATE_COLOR[p.state]}>{enumLabel(p.state)}</Chip>
              <Chip color="var(--ps-color-accent)">{enumLabel(p.classification)}</Chip>
              {p.fast_track && <Chip color="var(--ps-color-gold)">{t.fastTrack}</Chip>}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {entry && p.state === 'draft' && <ActionButton variant="primary" onClick={() => post('/submit')}>{t.projects.submit}</ActionButton>}
            {entry && p.state === 'active' && (
              <FormToggle label={t.projects.hold}>
                {(close) => <PdpForm spec={fields('reason!:textarea')} submitLabel={t.projects.hold} onCancel={close} onSubmit={(v) => post('/hold', v)} />}
              </FormToggle>
            )}
            {entry && p.state === 'on_hold' && (
              <FormToggle label={t.projects.resume}>
                {(close) => <PdpForm spec={fields('comment:textarea overrideReason:textarea')} submitLabel={t.projects.resume} onCancel={close} onSubmit={(v) => post('/resume', v)} />}
              </FormToggle>
            )}
            {canEdit(ENTRY) && p.state === 'launched' && (
              <FormToggle label={t.projects.close}>
                {(close) => <PdpForm spec={fields('closureReport!:textarea')} submitLabel={t.projects.close} onCancel={close} onSubmit={(v) => post('/close', v)} />}
              </FormToggle>
            )}
            {canDelete(ENTRY) && p.state === 'draft' && (
              <ActionButton variant="danger" confirmText={`Delete the draft ${code}?`} onClick={async () => { await pdp(`/projects/${code}`, token, 'DELETE'); router.push(`${BASE}/projects`); }}>
                {t.projects.delete}
              </ActionButton>
            )}
          </div>
        </div>

        <div className={s.stepper} style={{ margin: '16px 0' }} aria-label="Gates">
          {GATES.map((g, i) => (
            <div key={g.key} className={`${s.step}${i < gateIdx ? ` ${s.stepDone}` : i === gateIdx ? ` ${s.stepCurrent}` : ''}`} aria-current={i === gateIdx ? 'step' : undefined}>
              <strong>{g.key === 'closed' ? 'Closed' : g.key} · {g.name}</strong>
              <span>{g.step}</span>
              <span>{stepDate(g.key, p)}</span>
            </div>
          ))}
        </div>

        <Details
          items={[
            ['Product', d.product ? <OdooLink key="p" href={d.product.odoo_url}>{d.product.name}</OdooLink> : `${p.proposed_product_name} (new, in ${d.proposedSubfamily?.family ?? ''} › ${d.proposedSubfamily?.name ?? ''})`],
            ['Product status', d.product ? <Chip key="ps" color={STATUS_COLOR[d.product.status]}>{enumLabel(d.product.status)}</Chip> : '—'],
            ['Project type', label(options, 'project_type', p.project_type_id)],
            ['Request source', `${label(options, 'request_source', p.request_source_id)} · ${p.requested_by}`],
            ['Innovation category', p.innovation_category ? enumLabel(p.innovation_category) : '—'],
            ['Owner', (options.users as Row[] | undefined)?.find((u) => u.user_id === p.owner_user_id)?.display_name ?? (p.owner_user_id ? `User ${p.owner_user_id}` : '—')],
            ['Target launch', fmtDate(p.target_launch_date)],
            ['Objectives', p.objectives],
            ['Description', p.description],
            ...(p.closure_report ? [[t.projects.closureReport, p.closure_report] as [string, React.ReactNode]] : []),
          ]}
        />
        {entry && (
          <div style={{ marginTop: 12 }}>
            <FormToggle label={t.projects.edit}>
              {(close) => (
                <PdpForm
                  spec={fields('title! classification!:select projectTypeId!:select requestedBy! requestSourceId!:select innovationCategory:select ownerUserId:select targetLaunchDate:date fastTrack:checkbox objectives:textarea description:textarea')}
                  initial={{
                    title: p.title, classification: p.classification, projectTypeId: p.project_type_id, requestedBy: p.requested_by, requestSourceId: p.request_source_id,
                    innovationCategory: p.innovation_category, ownerUserId: p.owner_user_id, targetLaunchDate: p.target_launch_date, fastTrack: p.fast_track, objectives: p.objectives, description: p.description,
                  }}
                  options={options}
                  onCancel={close}
                  onSaved={() => { close(); refresh(); }}
                  onSubmit={(v) => pdp(`/projects/${code}`, token, 'PATCH', v)}
                />
              )}
            </FormToggle>
          </div>
        )}
      </Card>

      {(d.gate.noApprover as string[]).map((g) => (
        <Notice key={g} tone="alert">{t.noApprover} {g}. {t.noApproverHint}</Notice>
      ))}
      {p.classification === 'unplanned' && <Notice tone="watch">{t.projects.strict}</Notice>}
      {d.fastTrack && (
        <Notice tone={d.fastTrack.overdue ? 'alert' : 'info'}>
          {d.fastTrack.overdue ? t.projects.fastTrackOverdue : `${t.projects.fastTrackDeadline} ${new Date(d.fastTrack.deadline).toLocaleString('en-GB')}${d.fastTrack.feasibilityDone ? ' (done)' : ''}.`}
        </Notice>
      )}

      <GatePanel d={d} options={options} refresh={refresh} />
      <Scoring d={d} editable={entry && ['draft', 'submitted'].includes(p.state)} refresh={refresh} />
      <Team d={d} options={options} entry={entry} refresh={refresh} />
      <Checklists d={d} options={options} entry={entry} canCreate={canCreate(ENTRY) && !readOnly} refresh={refresh} />
      <Work d={d} options={options} entry={entry} myRoles={myRoles} refresh={refresh} />
      <HistoryGrids d={d} />
    </>
  );
}

function stepDate(key: string, p: Row): string {
  if (key === 'G0') return p.submitted_at ? `Submitted ${fmtDate(p.submitted_at)}` : '';
  if (key === 'G1') return p.start_date ? `Kick-off ${fmtDate(p.start_date)}` : '';
  if (key === 'G5') return p.launched_at ? `Launched ${fmtDate(p.launched_at)}` : '';
  if (key === 'closed') return p.closed_date ? fmtDate(p.closed_date) : '';
  return '';
}

function label(options: Row, list: string, id: unknown): string {
  return (options.dropdowns as Row[]).find((v) => v.list_key === list && v.value_id === id)?.label ?? '—';
}

// ------------------------------------------------------------------------------------------------ gate decision

function GatePanel({ d, options, refresh }: { d: Row; options: Row; refresh: () => void }) {
  const { token, canEdit } = useAuth();
  const g = d.gate as Row;
  const code = d.project.code as string;
  const roleLabel = (c: string) => (options.governance as Row[]).find((r) => r.code === c)?.label ?? c;
  return (
    <Section title={`${t.projects.decide}: ${g.open ? `${g.current} (round ${g.round})` : '—'}`} help={{ definition: 'Each gate needs its sign-offs from the governance roles in Administration › Gate sign-offs. A reject ends the project; a revise keeps it at the gate and starts a new round.' }} testId="pdp-gate-panel">
      {!g.open ? (
        <Empty message={t.projects.gateClosed} />
      ) : (
        <div className={s.two}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>{t.projects.signoffs}</div>
            {(g.signoffs as Row[]).map((so) => (
              <div key={so.code} style={{ fontSize: 13 }}>
                <div>{so.label} <span style={{ color: 'var(--ps-color-muted-text)' }}>({enumLabel(so.mode)})</span></div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {(so.roles as string[]).map((r) => (
                    <Chip key={r} color={so.missing.includes(r) ? 'var(--ps-color-muted-text)' : 'var(--ps-color-success)'}>
                      {roleLabel(r)}: {so.missing.includes(r) ? 'waiting' : 'approved'}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
            {(g.preconditionErrors as Row[]).length > 0 && (
              <Notice tone="watch">
                <strong>{t.projects.preconditions}:</strong>
                <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
                  {(g.preconditionErrors as Row[]).map((e) => <li key={e.code}>{e.message}</li>)}
                </ul>
              </Notice>
            )}
          </div>
          <div>
            {!canEdit(APPROVAL) || (g.myRoles as string[]).length === 0 ? (
              <Notice tone="info">{t.projects.notApprover}</Notice>
            ) : (
              <PdpForm
                key={`${g.current}-${g.round}`}
                spec={fields('roleCode!:select decision!:select comment:textarea overrideReason:textarea', {
                  roleCode: { options: (g.myRoles as string[]).map((r) => ({ value: r, label: roleLabel(r) })), label: 'Decide as' },
                  comment: { hint: 'Required for revise and reject.' },
                  overrideReason: { hint: `Only when the kick-off would exceed ${d.capacity.max} active projects (now ${d.capacity.active}).` },
                })}
                initial={{ roleCode: g.myRoles[0], decision: 'approve' }}
                submitLabel="Record decision"
                onSaved={refresh}
                onSubmit={(v) => pdp(`/projects/${code}/decisions`, token, 'POST', v)}
              />
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ scoring

/** The six criteria with a 0-5 selector, the meaning of the chosen score, weighted points, total and PASS / BELOW. */
export function Scoring({ d, editable, refresh }: { d: Row; editable: boolean; refresh: () => void }) {
  const { token } = useAuth();
  const criteria = d.criteria as Row[];
  const latest = (d.scoreRounds as Row[])[0];
  const minScore = Number(d.settings.min_score);
  const [scores, setScores] = useState<Record<number, number | null>>(() => Object.fromEntries(criteria.map((c) => [c.criterion_id, latest?.scores.find((x: Row) => x.criterion_id === c.criterion_id)?.score ?? null])));
  const [evidence, setEvidence] = useState<Record<number, string>>(() => Object.fromEntries(criteria.map((c) => [c.criterion_id, latest?.scores.find((x: Row) => x.criterion_id === c.criterion_id)?.evidence ?? ''])));
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const weighted = (c: Row) => (scores[c.criterion_id] === null ? null : Math.round(((scores[c.criterion_id] as number) * c.weight) / 5 * 100) / 100);
  const total = Math.round(criteria.reduce((sum, c) => sum + (weighted(c) ?? 0), 0) * 100) / 100;
  const complete = criteria.every((c) => scores[c.criterion_id] !== null);
  const passed = total >= minScore;

  async function save() {
    const found: Record<number, string> = {};
    for (const c of criteria) {
      if (scores[c.criterion_id] === null) found[c.criterion_id] = 'Choose a score.';
      else if (!evidence[c.criterion_id]?.trim()) found[c.criterion_id] = 'Evidence is required.';
    }
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      await pdp(`/projects/${d.project.code}/scores`, token, 'POST', { scores: criteria.map((c) => ({ criterionId: c.criterion_id, score: scores[c.criterion_id], evidence: evidence[c.criterion_id] })) });
      refresh();
    } catch (e) {
      setFormError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const roundCols: DataGridColumn<Row>[] = [
    { key: 'round_no', header: 'Round', align: 'right' },
    { key: 'total', header: 'Total', align: 'right' },
    { key: 'passed', header: 'Result', render: (r) => <Chip color={r.passed ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}>{r.passed ? t.projects.pass : `${t.projects.below} ${r.min_score}`}</Chip>, rawValue: (r) => (r.passed ? 'PASS' : 'BELOW') },
    { key: 'scored_by_name', header: 'Scored by' },
    { key: 'scored_at', header: 'When', render: (r) => fmtDate(r.scored_at), rawValue: (r) => r.scored_at },
  ];

  return (
    <Section title={t.projects.scoring} help={{ definition: 'Score each criterion 0–5 (5 is always the most favourable). Weighted = score × weight ÷ 5; the total is out of 100.', formula: `Minimum to proceed: ${minScore}` }} testId="pdp-scoring">
      {criteria.length === 0 ? (
        <Empty message={t.empty.criteria} />
      ) : (
        <>
          <div className={s.score} role="table" aria-label={t.projects.scoring}>
            <span className={s.head}>Criterion</span>
            <span className={s.head}>Weight</span>
            <span className={`${s.head} ${s.wide}`}>Score · meaning</span>
            <span className={s.head}>Weighted</span>
            <span className={`${s.head} ${s.wide}`}>Evidence / justification</span>
            {criteria.map((c) => {
              const v = scores[c.criterion_id];
              return (
                <React.Fragment key={c.criterion_id}>
                  <strong>{c.name}</strong>
                  <span>{c.weight}</span>
                  <span className={s.wide}>
                    <span className={s.scoreButtons} role="radiogroup" aria-label={`${c.name} score`}>
                      {[0, 1, 2, 3, 4, 5].map((n) => (
                        <Button
                          key={n}
                          type="button"
                          role="radio"
                          aria-checked={v === n}
                          variant={v === n ? 'primary' : 'secondary'}
                          disabled={!editable}
                          style={{ padding: '4px 10px', minWidth: 34 }}
                          onClick={() => setScores((x) => ({ ...x, [c.criterion_id]: n }))}
                        >
                          {n}
                        </Button>
                      ))}
                    </span>
                    <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{v === null ? 'Not scored' : c.meanings[v]}</span>
                  </span>
                  <span>{weighted(c) ?? '—'}</span>
                  <span className={s.wide}>
                    <textarea
                      className="ps-kaizen-input"
                      dir="auto"
                      style={{ minHeight: 56 }}
                      value={evidence[c.criterion_id]}
                      disabled={!editable}
                      aria-label={`${c.name} evidence`}
                      aria-invalid={Boolean(errors[c.criterion_id])}
                      onChange={(e) => setEvidence((x) => ({ ...x, [c.criterion_id]: e.target.value }))}
                    />
                    {errors[c.criterion_id] && <em role="alert" style={{ fontStyle: 'normal', fontSize: 12, color: 'var(--ps-color-alert)' }}>{errors[c.criterion_id]}</em>}
                  </span>
                </React.Fragment>
              );
            })}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 14 }}>
            <span style={{ fontSize: 15 }}>
              {t.projects.total}: <strong data-testid="pdp-score-total">{total}</strong> / 100
            </span>
            {complete && <Chip color={passed ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}>{passed ? t.projects.pass : `${t.projects.below} ${minScore}`}</Chip>}
            {editable && (
              <Button style={{ marginInlineStart: 'auto' }} disabled={saving} onClick={save}>
                {saving ? t.saving : t.projects.newRound}
              </Button>
            )}
          </div>
          {formError && <p role="alert" style={{ color: 'var(--ps-color-alert)', margin: '8px 0 0' }}>{formError}</p>}
          {(d.scoreRounds as Row[]).length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{t.projects.rounds}</div>
              <DataGrid columns={roundCols} rows={d.scoreRounds} getRowId={(r) => String(r.round_no)} enableFiltering={false} maxBodyHeight={220} />
            </div>
          ) : (
            <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '10px 0 0' }}>{t.empty.scoreRounds}</p>
          )}
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ team

function Team({ d, options, entry, refresh }: { d: Row; options: Row; entry: boolean; refresh: () => void }) {
  const { token } = useAuth();
  const code = d.project.code;
  const cols: DataGridColumn<Row>[] = [
    { key: 'display_name', header: 'Member' },
    { key: 'role_label', header: 'Role in the project', render: (r) => <span dir="auto">{r.role_label}</span> },
    ...(entry ? [{ key: 'member_id' as const, header: '', render: (r: Row) => <ActionButton onClick={() => pdp(`/projects/${code}/members/${r.member_id}`, token, 'DELETE').then(refresh)}>{t.remove}</ActionButton>, rawValue: () => '' }] : []),
  ];
  return (
    <Section title={t.projects.team} actions={entry ? <FormToggle label={`${t.add} member`}>{(close) => <PdpForm spec={fields('userId!:select roleLabel!')} options={options} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/projects/${code}/members`, token, 'POST', v)} />}</FormToggle> : undefined}>
      {(d.members as Row[]).length ? <DataGrid columns={cols} rows={d.members} getRowId={(r) => String(r.member_id)} enableFiltering={false} maxBodyHeight={220} /> : <Empty message={t.empty.team} />}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ checklists

function AttachButton({ ownerType, ownerId, refresh }: { ownerType: string; ownerId: number; refresh: () => void }) {
  const { token } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <label style={{ fontSize: 12.5, color: 'var(--ps-color-accent)', cursor: 'pointer', fontWeight: 600 }} title={t.projects.attachHint}>
        {busy ? t.saving : `+ ${t.projects.attach}`}
        <input
          type="file"
          hidden
          accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            setError(null);
            try {
              const fd = new FormData();
              fd.append('ownerType', ownerType);
              fd.append('ownerId', String(ownerId));
              fd.append('file', file);
              await upload('/attachments', token, fd);
              refresh();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {error && <span role="alert" style={{ color: 'var(--ps-color-alert)', fontSize: 12 }}>{error}</span>}
    </span>
  );
}

function Files({ files }: { files: Row[] }) {
  const { token } = useAuth();
  if (!files?.length) return null;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {files.map((f) => (
        <button key={f.attachment_id} type="button" onClick={() => download(`/attachments/${f.attachment_id}`, token, f.file_name)} style={{ all: 'unset', cursor: 'pointer', color: 'var(--ps-color-accent)', textDecoration: 'underline', fontSize: 12.5 }} dir="auto">
          {f.file_name}
        </button>
      ))}
    </span>
  );
}

function Checklists({ d, options, entry, canCreate, refresh }: { d: Row; options: Row; entry: boolean; canCreate: boolean; refresh: () => void }) {
  const { token } = useAuth();
  const code = d.project.code;
  const groups = ['FEASIBILITY', 'RAW_MATERIAL', 'DOCUMENTATION'];
  const roleLabel = (c: string | null) => (c ? (options.governance as Row[]).find((r) => r.code === c)?.label ?? c : '—');
  return (
    <Section title={t.projects.checklists} help={{ definition: 'Required items must be done before their gate can be approved; documentation items also need an attachment or a link. Packaging is optional until an admin makes it required.' }} testId="pdp-checklists">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {groups.map((list) => {
          const items = (d.checklist as Row[]).filter((c) => c.template.list_code === list);
          if (!items.length) return null;
          const done = items.filter((c) => c.item?.status === 'done').length;
          const cols: DataGridColumn<Row>[] = [
            { key: 'label', header: 'Item', width: 260, render: (r) => <span><strong>{r.template.label}</strong>{' '}{!r.template.required && <em style={{ fontStyle: 'normal', color: 'var(--ps-color-muted-text)' }}>({t.optional})</em>}{r.template.hint && <span style={{ display: 'block', fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{r.template.hint}</span>}</span>, rawValue: (r) => r.template.label },
            { key: 'owner_role', header: 'Owner role', render: (r) => roleLabel(r.template.owner_role_code), rawValue: (r) => roleLabel(r.template.owner_role_code) },
            { key: 'status', header: 'Status', render: (r) => <Chip color={r.item?.status === 'done' ? 'var(--ps-color-success)' : 'var(--ps-color-muted-text)'}>{enumLabel(r.item?.status ?? 'open')}</Chip>, rawValue: (r) => r.item?.status ?? 'open' },
            { key: 'done_date', header: 'Done', render: (r) => fmtDate(r.item?.done_date), rawValue: (r) => r.item?.done_date ?? '' },
            { key: 'owner_name', header: 'Owner', rawValue: (r) => r.item?.owner_name ?? '' },
            { key: 'evidence', header: 'Evidence', width: 220, render: (r) => <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{r.item?.link_url && <a href={r.item.link_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ps-color-accent)' }}>Link</a>}<Files files={r.item?.attachments ?? []} />{canCreate && r.item && <AttachButton ownerType="checklist" ownerId={r.item.item_id} refresh={refresh} />}</span>, rawValue: (r) => r.item?.link_url ?? '' },
            ...(entry ? [{ key: 'edit', header: '', width: 120, render: (r: Row) => r.item && <ItemEdit code={code} item={r.item} options={options} refresh={refresh} token={token} />, rawValue: () => '' }] : []),
          ];
          return (
            <div key={list}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{enumLabel(list)} · {done} / {items.length} done</div>
              <DataGrid columns={cols} rows={items.map((c) => ({ ...c, id: c.template.template_id }))} getRowId={(r) => String(r.id)} enableFiltering={false} maxBodyHeight={null} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function ItemEdit({ code, item, options, refresh, token }: { code: string; item: Row; options: Row; refresh: () => void; token: string | null }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button variant="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setOpen(true)}>{t.edit}</Button>;
  return (
    <div style={{ minWidth: 300 }}>
      <PdpForm
        spec={fields('status!:select ownerUserId:select doneDate:date linkUrl note:textarea', { status: { options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] }, linkUrl: { label: 'Link (https://…)', full: true } })}
        initial={{ status: item.status, ownerUserId: item.owner_user_id, doneDate: item.done_date, linkUrl: item.link_url, note: item.note }}
        options={options}
        onCancel={() => setOpen(false)}
        onSaved={() => { setOpen(false); refresh(); }}
        onSubmit={(v) => pdp(`/projects/${code}/checklist/${item.item_id}`, token, 'PATCH', v)}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ lab / field / pilot / doc errors

function Work({ d, options, entry, myRoles, refresh }: { d: Row; options: Row; entry: boolean; myRoles: string[]; refresh: () => void }) {
  const { token, canCreate, canDelete } = useAuth();
  const code = d.project.code;
  const add = canCreate(ENTRY) && entry;
  const { pilot_kg_min: kgMin, pilot_kg_max: kgMax } = d.settings;

  const labCols: DataGridColumn<Row>[] = [
    { key: 'trial_no', header: 'Trial', align: 'right' },
    { key: 'test_date', header: 'Date', render: (r) => fmtDate(r.test_date), rawValue: (r) => r.test_date },
    { key: 'property', header: 'Property' },
    { key: 'competitor', header: 'Benchmark', rawValue: (r) => r.competitor ?? '' },
    { key: 'target', header: 'Target' },
    { key: 'result', header: 'Result', render: (r) => `${r.result}${r.unit ? ` ${r.unit}` : ''}` },
    { key: 'passed', header: 'Pass', render: (r) => <Chip color={r.passed ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}>{r.passed ? 'Pass' : 'Fail'}</Chip>, rawValue: (r) => (r.passed ? 'Pass' : 'Fail') },
    ...(canDelete(ENTRY) && entry ? [{ key: 'del', header: '', render: (r: Row) => <ActionButton variant="ghost" confirmText="Delete this lab test?" onClick={() => pdp(`/projects/${code}/lab-tests/${r.test_id}`, token, 'DELETE').then(refresh)}>{t.remove}</ActionButton>, rawValue: () => '' }] : []),
  ];
  const trialCols: DataGridColumn<Row>[] = [
    { key: 'trial_date', header: 'Date', render: (r) => fmtDate(r.trial_date), rawValue: (r) => r.trial_date },
    { key: 'site', header: 'Site', render: (r) => <span dir="auto">{r.site}</span> },
    { key: 'customer_name', header: 'Customer', render: (r) => <OdooLink href={r.customer_odoo_url}>{r.odoo_customer ?? r.customer_name ?? '—'}</OdooLink>, rawValue: (r) => r.odoo_customer ?? r.customer_name ?? '' },
    { key: 'scores', header: 'Setting / bonding / flex / coverage / satisfaction', render: (r) => [r.score_setting, r.score_bonding, r.score_flexibility, r.score_coverage, r.score_satisfaction].join(' / '), rawValue: (r) => [r.score_setting, r.score_bonding, r.score_flexibility, r.score_coverage, r.score_satisfaction].join('/') },
    { key: 'passed', header: 'Overall', render: (r) => <Chip color={r.passed ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}>{r.passed ? 'Pass' : 'Fail'}</Chip>, rawValue: (r) => (r.passed ? 'Pass' : 'Fail') },
    { key: 'ts_lead_name', header: 'TS lead' },
    { key: 'files', header: 'Photos', render: (r) => <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><Files files={r.attachments} />{add && <AttachButton ownerType="field_trial" ownerId={r.trial_id} refresh={refresh} />}</span>, rawValue: () => '' },
    ...(canDelete(ENTRY) && entry ? [{ key: 'del', header: '', render: (r: Row) => <ActionButton variant="ghost" confirmText="Delete this field trial?" onClick={() => pdp(`/projects/${code}/field-trials/${r.trial_id}`, token, 'DELETE').then(refresh)}>{t.remove}</ActionButton>, rawValue: () => '' }] : []),
  ];
  const confirm = (r: Row, kind: 'qc' | 'rnd' | 'production', role: string) =>
    r[`${kind}_ok`] ? (
      <Chip color="var(--ps-color-success)" title={`${r[`${kind}_name`] ?? ''} · ${fmtDate(r[`${kind}_at`])}`}>{t.projects.confirm[kind]}</Chip>
    ) : entry && myRoles.includes(role) ? (
      <ActionButton onClick={() => pdp(`/projects/${code}/pilot-batches/${r.batch_id}/confirm`, token, 'POST', { kind }).then(refresh)}>Confirm</ActionButton>
    ) : (
      <span style={{ color: 'var(--ps-color-muted-text)', fontSize: 12 }}>Waiting</span>
    );
  const batchCols: DataGridColumn<Row>[] = [
    { key: 'batch_no', header: 'Batch', align: 'right' },
    { key: 'batch_date', header: 'Date', render: (r) => fmtDate(r.batch_date), rawValue: (r) => r.batch_date },
    { key: 'batch_kg', header: 'kg', align: 'right', render: (r) => Number(r.batch_kg).toLocaleString('en-GB'), rawValue: (r) => Number(r.batch_kg) },
    { key: 'qc_ok', header: 'QC verifies', render: (r) => confirm(r, 'qc', 'QC_QA'), rawValue: (r) => (r.qc_ok ? 'Yes' : '') },
    { key: 'rnd_ok', header: 'R&D scale', render: (r) => confirm(r, 'rnd', 'RND'), rawValue: (r) => (r.rnd_ok ? 'Yes' : '') },
    { key: 'production_ok', header: 'Production', render: (r) => confirm(r, 'production', 'PRODUCTION'), rawValue: (r) => (r.production_ok ? 'Yes' : '') },
    ...(canDelete(ENTRY) && entry ? [{ key: 'del', header: '', render: (r: Row) => <ActionButton variant="ghost" confirmText="Delete this batch?" onClick={() => pdp(`/projects/${code}/pilot-batches/${r.batch_id}`, token, 'DELETE').then(refresh)}>{t.remove}</ActionButton>, rawValue: () => '' }] : []),
  ];
  const errCols: DataGridColumn<Row>[] = [
    { key: 'found_date', header: 'Found', render: (r) => fmtDate(r.found_date), rawValue: (r) => r.found_date },
    { key: 'document', header: 'Document' },
    { key: 'severity', header: 'Severity', render: (r) => <Chip color={r.severity === 'critical' ? 'var(--ps-color-alert)' : 'var(--ps-color-gold)'}>{enumLabel(r.severity)}</Chip>, rawValue: (r) => r.severity },
    { key: 'description', header: 'Description', width: 300, render: (r) => <span dir="auto">{r.description}</span> },
    { key: 'fixed_date', header: 'Fixed', render: (r) => fmtDate(r.fixed_date), rawValue: (r) => r.fixed_date ?? '' },
    { key: 'created_by_name', header: 'By' },
    ...(myRoles.includes('QC_QA') && canDelete(ENTRY) ? [{ key: 'del', header: '', render: (r: Row) => <ActionButton variant="ghost" confirmText="Delete this error?" onClick={() => pdp(`/projects/${code}/doc-errors/${r.error_id}`, token, 'DELETE').then(refresh)}>{t.remove}</ActionButton>, rawValue: () => '' }] : []),
  ];

  return (
    <>
      <Section title={t.projects.labTests} help={{ definition: 'Benchmarked against Sika, Mapei and Weber. First-pass lab success uses trial no. 1.' }}
        actions={add ? <FormToggle label={`${t.add} lab test`}>{(close) => <PdpForm spec={fields('trialNo!:number testDate!:date propertyId!:select competitorId:select target! result! unit passed:checkbox notes:textarea')} initial={{ trialNo: 1 }} options={options} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/projects/${code}/lab-tests`, token, 'POST', v)} />}</FormToggle> : undefined}>
        {(d.labTests as Row[]).length ? <DataGrid columns={labCols} rows={d.labTests} getRowId={(r) => String(r.test_id)} enableFiltering={false} maxBodyHeight={260} /> : <Empty message={t.empty.labTests} />}
      </Section>
      <Section title={t.projects.fieldTrials} help={{ definition: 'Led by Technical Support: setting, bonding, flexibility, coverage and customer satisfaction scored 1–5, plus an overall pass/fail.' }}
        actions={add ? <FormToggle label={`${t.add} field trial`}>{(close) => <PdpForm spec={fields('trialDate!:date site! tsLeadUserId!:select customerName scoreSetting!:number scoreBonding!:number scoreFlexibility!:number scoreCoverage!:number scoreSatisfaction!:number passed:checkbox notes:textarea', { tsLeadUserId: { hint: 'Must be a Technical Support member.' } })} options={options} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/projects/${code}/field-trials`, token, 'POST', v)} />}</FormToggle> : undefined}>
        {(d.fieldTrials as Row[]).length ? <DataGrid columns={trialCols} rows={d.fieldTrials} getRowId={(r) => String(r.trial_id)} enableFiltering={false} maxBodyHeight={260} /> : <Empty message={t.empty.fieldTrials} />}
      </Section>
      <Section title={t.projects.pilotBatches} help={{ definition: `Batches of ${kgMin}–${kgMax} kg. QC verifies, R&D approves the scale and Production confirms manufacturability; each by a member of that role.` }}
        actions={add ? <FormToggle label={`${t.add} pilot batch`}>{(close) => <PdpForm spec={fields('batchNo!:number batchDate!:date batchKg!:number notes:textarea', { batchKg: { hint: `${kgMin}–${kgMax} kg` } })} initial={{ batchNo: (d.pilotBatches as Row[]).length + 1 }} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/projects/${code}/pilot-batches`, token, 'POST', v)} />}</FormToggle> : undefined}>
        {(d.pilotBatches as Row[]).length ? <DataGrid columns={batchCols} rows={d.pilotBatches} getRowId={(r) => String(r.batch_id)} enableFiltering={false} maxBodyHeight={260} /> : <Empty message={t.empty.pilotBatches} />}
      </Section>
      <Section title={t.projects.docErrors} help={{ definition: 'Entered by QC/QA. The "critical documentation errors" KPI counts the critical ones.' }}
        actions={canCreate(ENTRY) && myRoles.includes('QC_QA') ? <FormToggle label={`${t.add} error`}>{(close) => <PdpForm spec={fields('document! severity!:select foundDate!:date description!:textarea fixedDate:date')} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp(`/projects/${code}/doc-errors`, token, 'POST', v)} />}</FormToggle> : undefined}>
        {(d.docErrors as Row[]).length ? <DataGrid columns={errCols} rows={d.docErrors} getRowId={(r) => String(r.error_id)} enableFiltering={false} maxBodyHeight={260} /> : <Empty message={t.empty.docErrors} />}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ decisions + history

function HistoryGrids({ d }: { d: Row }) {
  const decisionCols: DataGridColumn<Row>[] = [
    { key: 'decided_at', header: 'When', render: (r) => fmtDate(r.decided_at), rawValue: (r) => r.decided_at },
    { key: 'gate', header: 'Gate' },
    { key: 'gate_round', header: 'Round', align: 'right' },
    { key: 'decision', header: 'Decision', render: (r) => <Chip color={r.decision === 'approve' ? 'var(--ps-color-success)' : r.decision === 'reject' ? 'var(--ps-color-alert)' : 'var(--ps-color-gold)'}>{enumLabel(r.decision)}</Chip>, rawValue: (r) => r.decision },
    { key: 'approver_role_code', header: 'As role' },
    { key: 'approver_name', header: 'Approver' },
    { key: 'comment', header: 'Comment', width: 260, render: (r) => <span dir="auto">{r.comment ?? '—'}</span>, rawValue: (r) => r.comment ?? '' },
    { key: 'override_reason', header: 'Override reason', rawValue: (r) => r.override_reason ?? '' },
  ];
  const historyCols: DataGridColumn<Row>[] = [
    { key: 'changed_at', header: 'When', render: (r) => (r.changed_at ? new Date(r.changed_at).toLocaleString('en-GB') : '—'), rawValue: (r) => r.changed_at },
    { key: 'event', header: 'Event' },
    { key: 'from_value', header: 'From', render: (r) => <span dir="auto">{r.from_value ?? '—'}</span>, rawValue: (r) => r.from_value ?? '' },
    { key: 'to_value', header: 'To', render: (r) => <span dir="auto">{r.to_value ?? '—'}</span>, rawValue: (r) => r.to_value ?? '' },
    { key: 'comment', header: 'Comment', width: 240, render: (r) => <span dir="auto">{r.comment ?? '—'}</span>, rawValue: (r) => r.comment ?? '' },
    { key: 'changed_by_name', header: 'By' },
  ];
  return (
    <>
      <Section title={t.projects.decisions}>
        {(d.decisions as Row[]).length ? <DataGrid columns={decisionCols} rows={d.decisions} getRowId={(r) => String(r.decision_id)} fileName={`${d.project.code}-decisions`} /> : <Empty message={t.empty.decisions} />}
      </Section>
      <Section title={t.projects.history}>
        {(d.history as Row[]).length ? <DataGrid columns={historyCols} rows={d.history} getRowId={(r) => String(r.history_id)} fileName={`${d.project.code}-history`} /> : <Empty message={t.empty.history} />}
      </Section>
      <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: 0 }}>
        <Link href={`${BASE}/projects`}>← {t.tabs.projects}</Link>
      </p>
    </>
  );
}
