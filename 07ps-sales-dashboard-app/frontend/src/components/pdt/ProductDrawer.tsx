'use client';
import React, { useEffect, useState } from 'react';
import { Button, ConfirmDialog, LoadingSkeleton } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { ENTRY } from '../../lib/pdp/api';
import { errorText, usePdp } from '../../lib/pdp/hooks';
import { TRACKER, trackerCall, type BlockerRow, type HealthCode, type HealthNotice, type Options, type ProductDetail, type StageCode, type StatusUpdateRow } from '../../lib/pdt/api';
import { Chip, HealthChip, PriorityText, Readiness, StageChip, fmtDay, fmtStamp, type Lookup } from './common';
import { BlockerForm, ProductForm, ResolveForm, StageForm, UpdateForm } from './forms';
import s from './Pdt.module.css';

type Mode =
  | { kind: 'view' }
  | { kind: 'edit' }
  | { kind: 'stage'; to?: StageCode }
  | { kind: 'update'; existing?: StatusUpdateRow }
  | { kind: 'blocker'; existing?: BlockerRow }
  | { kind: 'resolve'; blocker: BlockerRow };

const STATUS_LABEL: Record<BlockerRow['status'], string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', RESOLVED: 'Resolved', CANCELLED: 'Cancelled' };

/**
 * One product: details, stage timeline (days per stage), status updates, blockers & decisions, "Last updated by".
 * Editable with product_development_entry Edit (Create for new updates / items, Delete to remove); read-only otherwise.
 */
export function ProductDrawer({ code, options, lookup, onClose, onChanged, initialStage, start }: {
  code: string;
  options: Options;
  lookup: Lookup;
  onClose: () => void;
  onChanged: () => void;
  /** Dropped on another pipeline column: open the stage change for it. */
  initialStage?: StageCode;
  /** Open straight on a form (the entry screens' "Post update" / "Add blocker"). */
  start?: 'update' | 'blocker';
}) {
  const { token, canCreate, canEdit, canDelete } = useAuth();
  const [revision, setRevision] = useState(0);
  const state = usePdp<ProductDetail>(`${TRACKER}/products/${code}`, revision);
  const [mode, setMode] = useState<Mode>(initialStage ? { kind: 'stage', to: initialStage } : start ? { kind: start } : { kind: 'view' });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; run: () => Promise<unknown> }>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const edit = canEdit(ENTRY);
  const create = canCreate(ENTRY);
  const del = canDelete(ENTRY);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const saved = (message?: string) => {
    setMode({ kind: 'view' });
    setNotice(message ?? null);
    setRevision((n) => n + 1);
    onChanged();
  };
  const blockerSaved = (r: HealthNotice) =>
    saved(r.healthForced ? 'Health set to Blocked: this product has an open Blocker.' : r.healthReviewRequired ? 'The last Blocker is closed. Choose the new health below.' : undefined);

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await fn()) as HealthNotice | undefined;
      if (r && (r.healthForced || r.healthReviewRequired)) blockerSaved(r);
      else saved(message);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const d = state.data;
  const p = d?.product;
  const today = options.today;

  return (
    <>
      <div className={s.backdrop} onClick={onClose} aria-hidden />
      <aside className={s.drawer} role="dialog" aria-modal="true" aria-label={p ? `${p.code} ${p.name}` : 'Product'} data-testid="pdt-drawer">
        <div className={s.drawerHead}>
          <div>
            <div className={s.pcode}>{code}</div>
            <h2 className={s.cardTitle} style={{ fontSize: 19 }}>{p?.name ?? '…'}</h2>
            {p && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <StageChip code={p.stage} lookup={lookup} />
                <HealthChip code={p.health} lookup={lookup} />
                {p.stale && <Chip color="var(--ps-color-alert)">No update</Chip>}
              </div>
            )}
          </div>
          <button type="button" className={s.close} onClick={onClose} aria-label="Close">×</button>
        </div>

        {state.loading && !d && <LoadingSkeleton variant="table" />}
        {state.error && <div className={s.error} role="alert">{state.error}</div>}
        {notice && <div className={s.badge} role="status" style={{ padding: '8px 10px', fontSize: 13 }}>{notice}</div>}
        {actionError && <div className={s.error} role="alert">{actionError}</div>}

        {d && p && mode.kind === 'edit' && <ProductForm options={options} lookup={lookup} detail={d} onSaved={() => saved('Saved.')} onCancel={() => setMode({ kind: 'view' })} />}
        {d && p && mode.kind === 'stage' && <StageForm product={p} lookup={lookup} initialStage={mode.to} onSaved={() => saved('Stage changed.')} onCancel={() => setMode({ kind: 'view' })} />}
        {d && p && mode.kind === 'update' && <UpdateForm detail={d} lookup={lookup} today={today} existing={mode.existing} onSaved={() => saved('Update saved. The dashboard now shows its health and readiness.')} onCancel={() => setMode({ kind: 'view' })} />}
        {d && p && mode.kind === 'blocker' && <BlockerForm options={options} productCode={p.code} existing={mode.existing} onSaved={blockerSaved} onCancel={() => setMode({ kind: 'view' })} />}
        {d && p && mode.kind === 'resolve' && <ResolveForm blocker={mode.blocker} today={today} onSaved={blockerSaved} onCancel={() => setMode({ kind: 'view' })} />}

        {d && p && mode.kind === 'view' && (
          <>
            {p.healthReviewRequired && edit && (
              <div className={s.card} style={{ padding: 14 }} role="status">
                <b>The last Blocker is closed.</b> <span className={s.muted}>Set the product&apos;s health:</span>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {lookup.health.filter((h) => h.code !== 'BLOCKED').map((h) => (
                    <Button key={h.code} variant="secondary" disabled={busy} onClick={() => run(() => trackerCall(`/products/${p.code}`, token, 'PATCH', { health: h.code as HealthCode }), `Health set to ${h.label}.`)}>
                      {h.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {(edit || create) && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {edit && <Button onClick={() => setMode({ kind: 'edit' })}>Edit</Button>}
                {edit && <Button variant="secondary" onClick={() => setMode({ kind: 'stage' })}>Change stage</Button>}
                {create && <Button variant="secondary" onClick={() => setMode({ kind: 'update' })}>Post update</Button>}
                {create && <Button variant="secondary" onClick={() => setMode({ kind: 'blocker' })}>Add blocker / decision</Button>}
                {del && (
                  <Button variant="ghost" onClick={() => setConfirm({ title: `Delete ${p.code}?`, message: `${p.name} will disappear from the dashboard and every list. Its history is kept.`, run: () => trackerCall(`/products/${p.code}`, token, 'DELETE').then(() => { onChanged(); onClose(); }) })}>
                    Delete
                  </Button>
                )}
              </div>
            )}

            <dl className={s.dl}>
              {p.flagLabel && (<><dt>Flag</dt><dd className={s.flagAlert} style={{ fontWeight: 600 }}>{p.flagLabel}</dd></>)}
              <dt>Family</dt><dd>{p.family ?? '—'}{p.subfamily ? ` › ${p.subfamily}` : ''}</dd>
              <dt>Owner</dt><dd>{p.ownerName ?? <span className={s.muted}>Not set</span>}</dd>
              <dt>Priority</dt><dd><PriorityText code={p.priority} lookup={lookup} /></dd>
              <dt>Readiness</dt><dd><Readiness pct={p.readinessPct} /></dd>
              <dt>Project type</dt><dd>{lookup.label('project_type', p.projectType) || '—'}</dd>
              <dt>Target launch</dt><dd>{fmtDay(p.targetLaunch) || '—'}</dd>
              {p.actualLaunch && (<><dt>Actual launch</dt><dd>{fmtDay(p.actualLaunch)}</dd></>)}
              {p.nextStep && (<><dt>Next step</dt><dd>{p.nextStep}{p.nextStepDue ? ` · due ${fmtDay(p.nextStepDue)}` : ''}</dd></>)}
              <dt>Last status update</dt><dd>{fmtDay(p.lastUpdateAt) || 'None yet'}</dd>
              {p.description && (<><dt>Description</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.description}</dd></>)}
              {p.comment && (<><dt>Comment</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.comment}</dd></>)}
              {p.notes && (<><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</dd></>)}
            </dl>

            <section>
              <h3 className={s.cardTitle} style={{ fontSize: 15, marginBottom: 10 }}>Blockers &amp; decisions</h3>
              {d.blockers.length === 0 && <div className={s.muted}>None.</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {d.blockers.map((b) => {
                  const open = b.status === 'OPEN' || b.status === 'IN_PROGRESS';
                  const overdue = open && b.dueDate < today;
                  return (
                    <div key={b.blockerId} className={s.card} style={{ padding: 12 }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <Chip color={b.kind === 'BLOCKER' ? 'var(--ps-color-alert)' : 'var(--ps-color-gold, #c4892f)'}>{b.kind === 'BLOCKER' ? 'Blocker' : 'Decision needed'}</Chip>
                        <Chip color={open ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)'}>{STATUS_LABEL[b.status]}</Chip>
                        {overdue && <Chip color="var(--ps-color-alert)">Overdue</Chip>}
                      </div>
                      <div className={s.itemTitle} style={{ marginTop: 6 }}>{b.title}</div>
                      <div className={s.itemMeta}>{b.externalId ? `${b.externalId} · ` : ''}{b.ownerName ?? 'No owner'} · Due {fmtDay(b.dueDate)}</div>
                      <div className={s.itemAction}>{b.requiredAction}</div>
                      {!open && b.resolutionNote && <div className={s.muted} style={{ marginTop: 4 }}>{STATUS_LABEL[b.status]} {fmtDay(b.resolvedAt)}: {b.resolutionNote}</div>}
                      <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                        {edit && open && <button type="button" className={s.linkBtn} onClick={() => setMode({ kind: 'resolve', blocker: b })}>Resolve / cancel</button>}
                        {edit && open && <button type="button" className={s.linkBtn} onClick={() => setMode({ kind: 'blocker', existing: { ...b, productCode: p.code } })}>Edit</button>}
                        {edit && !open && <button type="button" className={s.linkBtn} disabled={busy} onClick={() => run(() => trackerCall(`/blockers/${b.blockerId}`, token, 'PATCH', { status: 'OPEN' }))}>Reopen</button>}
                        {del && <button type="button" className={s.linkBtn} onClick={() => setConfirm({ title: 'Delete this item?', message: b.title, run: () => trackerCall(`/blockers/${b.blockerId}`, token, 'DELETE') })}>Delete</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section>
              <h3 className={s.cardTitle} style={{ fontSize: 15, marginBottom: 10 }}>Status updates</h3>
              {d.updates.length === 0 && <div className={s.muted}>No update posted yet.</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {d.updates.map((u, i) => (
                  <div key={u.updateId} className={s.card} style={{ padding: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <b>{fmtDay(u.updateDate)}</b>
                      <HealthChip code={u.health} lookup={lookup} />
                      <Readiness pct={u.readinessPct} />
                      {i === 0 && <span className={s.badge}>Latest</span>}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 13, whiteSpace: 'pre-wrap' }}>{u.summary}</div>
                    {u.nextStep && (
                      <div className={u.nextStepDue && !u.nextStepDoneAt && u.nextStepDue < today ? s.error : s.muted} style={{ marginTop: 6 }}>
                        Next step: {u.nextStep} · due {fmtDay(u.nextStepDue)}{u.nextStepDoneAt ? ` · done ${fmtDay(u.nextStepDoneAt)}` : ''}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                      {edit && u.nextStep && <button type="button" className={s.linkBtn} disabled={busy} onClick={() => run(() => trackerCall(`/updates/${u.updateId}`, token, 'PATCH', { nextStepDone: !u.nextStepDoneAt }))}>{u.nextStepDoneAt ? 'Mark not done' : 'Mark next step done'}</button>}
                      {edit && <button type="button" className={s.linkBtn} onClick={() => setMode({ kind: 'update', existing: u })}>Edit</button>}
                      {del && <button type="button" className={s.linkBtn} onClick={() => setConfirm({ title: 'Delete this update?', message: `${fmtDay(u.updateDate)}: ${u.summary.slice(0, 80)}`, run: () => trackerCall(`/updates/${u.updateId}`, token, 'DELETE') })}>Delete</button>}
                      {u.updatedBy && <span className={s.audit}>by {u.updatedBy}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className={s.cardTitle} style={{ fontSize: 15, marginBottom: 10 }}>Stage history</h3>
              <ol className={s.timeline} data-testid="pdt-timeline">
                {[...d.history].reverse().map((h) => (
                  <li key={h.historyId} style={{ ['--dot' as string]: lookup.of('stage', h.toStage)?.color }}>
                    <b>{lookup.label('stage', h.toStage)}</b>
                    <span className={s.muted}> · {fmtDay(h.changedOn)} · {h.days} day{h.days === 1 ? '' : 's'}{h.current ? ' so far' : ''}</span>
                    <div className={s.muted}>{h.fromStage ? `From ${lookup.label('stage', h.fromStage)}` : 'Created'}{h.changedBy ? ` by ${h.changedBy}` : ''}: {h.comment}</div>
                  </li>
                ))}
              </ol>
            </section>

            <div className={s.audit} data-testid="pdt-audit">
              Last updated{d.audit.updatedBy ? ` by ${d.audit.updatedBy}` : ''} on {fmtStamp(d.audit.updatedAt)}
              {d.audit.createdBy ? ` · created by ${d.audit.createdBy} on ${fmtStamp(d.audit.createdAt)}` : ''}
              {d.audit.excelUpdatedOn || d.audit.excelUpdatedBy
                ? ` · Excel: last updated ${fmtDay(d.audit.excelUpdatedOn) || '—'}${d.audit.excelUpdatedBy ? ` by ${d.audit.excelUpdatedBy}` : ''}`
                : ''}
            </div>
          </>
        )}
      </aside>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel="Delete"
        confirmVariant="danger"
        busy={busy}
        onConfirm={() => confirm && run(confirm.run, 'Deleted.')}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
