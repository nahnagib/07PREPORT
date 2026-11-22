'use client';
import React, { useState } from 'react';
import { Button } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { apiFieldError } from '../../lib/pdp/hooks';
import { trackerCall, type BlockerRow, type HealthNotice, type Options, type Product, type ProductDetail, type StageCode, type StatusUpdateRow } from '../../lib/pdt/api';
import { FieldError, type Lookup } from './common';
import s from './Pdt.module.css';

type FieldErr = { field?: string; message: string } | null;

/** One labelled form control with its error line. */
function Field({ label, field, error, full, children, hint }: { label: string; field: string; error: FieldErr; full?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <div className={full ? s.full : undefined}>
      <label className={s.fieldLabel} htmlFor={`pdt-${field}`}>
        {label}
      </label>
      {children}
      {hint && <div className={s.muted}>{hint}</div>}
      <FieldError field={field} error={error} />
    </div>
  );
}

const cls = (base: string, field: string, error: FieldErr) => `${base}${error?.field === field ? ` ${s.invalid}` : ''}`;

/** Owner as typed: an app user's name sends ownerUserId, anything else is kept as a name. */
function ownerPayload(value: string, options: Options): Record<string, unknown> {
  const user = options.users.find((u) => u.display_name.toLowerCase() === value.trim().toLowerCase());
  return user ? { ownerUserId: user.user_id } : { ownerName: value.trim() };
}

function OwnerInput({ id, value, onChange, options, error, field = 'owner' }: { id: string; value: string; onChange: (v: string) => void; options: Options; error: FieldErr; field?: string }) {
  const names = [...new Set([...options.users.map((u) => u.display_name), ...options.owners])].sort();
  return (
    <>
      <input id={id} list={`${id}-list`} className={cls(s.input, field, error)} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" placeholder="Pick a user or type a name" />
      <datalist id={`${id}-list`}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </>
  );
}

function useSubmit<T>(fn: () => Promise<T>, onDone: (r: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldErr>(null);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      const f = apiFieldError(err);
      setError({ field: f.field, message: f.message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function GeneralError({ error, fields }: { error: FieldErr; fields: string[] }) {
  if (!error || (error.field && fields.includes(error.field))) return null;
  return (
    <div className={`${s.error} ${s.full}`} role="alert">
      {error.message}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Product (create / edit)
// ---------------------------------------------------------------------------------------------------------------------

const PRODUCT_FIELDS = ['name', 'familyId', 'subfamily', 'owner', 'priority', 'stage', 'health', 'readinessPct', 'targetLaunch', 'actualLaunch', 'projectType', 'nextStep', 'nextStepDue', 'description', 'comment', 'notes'];

/** Blank = "not set" for the optional lists (health, priority, project type), as in the Excel file. */
const NOT_SET_OPTION = <option value="">Not set</option>;

export function ProductForm({ options, lookup, detail, onSaved, onCancel }: { options: Options; lookup: Lookup; detail?: ProductDetail; onSaved: (d: ProductDetail) => void; onCancel: () => void }) {
  const { token } = useAuth();
  const p = detail?.product;
  const [v, setV] = useState({
    name: p?.name ?? '',
    familyId: p?.familyId ? String(p.familyId) : '',
    subfamily: p?.subfamily ?? '',
    owner: p?.ownerName ?? '',
    priority: p?.priority ?? '',
    stage: (p?.stage ?? 'IDEA') as StageCode,
    health: p?.health ?? '',
    readinessPct: p?.readinessPct === null || p?.readinessPct === undefined ? '' : String(p.readinessPct),
    targetLaunch: p?.targetLaunch ?? '',
    actualLaunch: p?.actualLaunch ?? '',
    projectType: p?.projectType ?? 'PLANNED',
    nextStep: p?.nextStep ?? '',
    nextStepDue: p?.nextStepDue ?? '',
    description: p?.description ?? '',
    comment: p?.comment ?? '',
    notes: p?.notes ?? '',
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const blockedByBlocker = Boolean(p && p.health === 'BLOCKED' && detail?.blockers.some((b) => b.kind === 'BLOCKER' && (b.status === 'OPEN' || b.status === 'IN_PROGRESS')));
  const subfamilies = [...new Set(options.subfamilies.filter((x) => !v.familyId || String(x.familyId) === v.familyId).map((x) => x.subfamily))].sort();
  const { busy, error, submit } = useSubmit(
    () => {
      const body: Record<string, unknown> = {
        name: v.name, familyId: v.familyId || null, subfamily: v.subfamily, ...ownerPayload(v.owner, options), priority: v.priority || null,
        readinessPct: v.readinessPct === '' ? null : Number(v.readinessPct), targetLaunch: v.targetLaunch || null, actualLaunch: v.actualLaunch || null,
        projectType: v.projectType || null, nextStep: v.nextStep, nextStepDue: v.nextStepDue || null, description: v.description, comment: v.comment, notes: v.notes,
      };
      if (!blockedByBlocker) body.health = v.health || null;
      if (!p) body.stage = v.stage;
      return p ? trackerCall<ProductDetail>(`/products/${p.code}`, token, 'PATCH', body) : trackerCall<ProductDetail>('/products', token, 'POST', body);
    },
    onSaved,
  );
  const stage = p?.stage ?? v.stage;
  return (
    <form className={s.form} onSubmit={submit} noValidate data-testid="pdt-product-form">
      <Field label="Code" field="code" error={null}>
        <input className={s.input} value={p?.code ?? 'Next XT code, given on save'} readOnly aria-readonly />
      </Field>
      <Field label="Product name" field="name" error={error}>
        <input id="pdt-name" className={cls(s.input, 'name', error)} value={v.name} onChange={set('name')} maxLength={150} required />
      </Field>
      <Field label="Family" field="familyId" error={error}>
        <select id="pdt-familyId" className={cls(s.select, 'familyId', error)} value={v.familyId} onChange={set('familyId')}>
          <option value="">Not set</option>
          {lookup.families.filter((f) => f.is_active || String(f.value_id) === v.familyId).map((f) => (
            <option key={f.value_id} value={f.value_id}>{f.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Subfamily" field="subfamily" error={error}>
        <input id="pdt-subfamily" list="pdt-subfamily-list" className={cls(s.input, 'subfamily', error)} value={v.subfamily} onChange={set('subfamily')} maxLength={100} autoComplete="off" />
        <datalist id="pdt-subfamily-list">{subfamilies.map((x) => <option key={x} value={x} />)}</datalist>
      </Field>
      <Field label="Stage" field="stage" error={error} hint={p ? 'Use "Change stage" to move the product.' : undefined}>
        <select id="pdt-stage" className={s.select} value={stage} onChange={set('stage')} disabled={Boolean(p)}>
          {lookup.stages.map((x) => <option key={x.code} value={x.code ?? ''}>{x.label}</option>)}
        </select>
      </Field>
      <Field label="Health" field="health" error={error} hint={blockedByBlocker ? 'Blocked while a Blocker is open.' : 'Blocked is set by adding a Blocker.'}>
        <select id="pdt-health" className={s.select} value={blockedByBlocker ? 'BLOCKED' : v.health} onChange={set('health')} disabled={blockedByBlocker}>
          {!blockedByBlocker && NOT_SET_OPTION}
          {lookup.health.filter((x) => x.code !== 'BLOCKED' || blockedByBlocker || v.health === 'BLOCKED').map((x) => <option key={x.code} value={x.code ?? ''}>{x.label}</option>)}
        </select>
      </Field>
      <Field label="Owner" field="owner" error={error}>
        <OwnerInput id="pdt-owner" value={v.owner} onChange={(o) => setV({ ...v, owner: o })} options={options} error={error} />
      </Field>
      <Field label="Priority" field="priority" error={error}>
        <select id="pdt-priority" className={s.select} value={v.priority} onChange={set('priority')}>
          {NOT_SET_OPTION}
          {lookup.priorities.map((x) => <option key={x.code} value={x.code ?? ''}>{x.label}</option>)}
        </select>
      </Field>
      <Field label="Readiness %" field="readinessPct" error={error} hint="0–100, estimated by the owner. 100% only in Launch ready or Launched.">
        <input id="pdt-readinessPct" className={cls(s.input, 'readinessPct', error)} type="number" min={0} max={100} step={1} value={v.readinessPct} onChange={set('readinessPct')} />
      </Field>
      <Field label="Project type" field="projectType" error={error}>
        <select id="pdt-projectType" className={s.select} value={v.projectType} onChange={set('projectType')}>
          {NOT_SET_OPTION}
          {lookup.projectTypes.map((x) => <option key={x.code} value={x.code ?? ''}>{x.label}</option>)}
        </select>
      </Field>
      <Field label={stage === 'IDEA' ? 'Target launch (optional)' : stage === 'LAUNCHED' ? 'Target launch (optional)' : 'Target launch'} field="targetLaunch" error={error}>
        <input id="pdt-targetLaunch" className={cls(s.input, 'targetLaunch', error)} type="date" value={v.targetLaunch} onChange={set('targetLaunch')} />
      </Field>
      {stage === 'LAUNCHED' && (
        <Field label="Actual launch" field="actualLaunch" error={error}>
          <input id="pdt-actualLaunch" className={cls(s.input, 'actualLaunch', error)} type="date" value={v.actualLaunch} onChange={set('actualLaunch')} />
        </Field>
      )}
      <Field label="Next step" field="nextStep" error={error}>
        <input id="pdt-nextStep" className={cls(s.input, 'nextStep', error)} value={v.nextStep} onChange={set('nextStep')} maxLength={300} />
      </Field>
      <Field label="Next step due" field="nextStepDue" error={error}>
        <input id="pdt-nextStepDue" className={cls(s.input, 'nextStepDue', error)} type="date" value={v.nextStepDue} onChange={set('nextStepDue')} />
      </Field>
      <Field label="Description" field="description" error={error} full>
        <textarea id="pdt-description" className={s.textarea} value={v.description} onChange={set('description')} />
      </Field>
      <Field label="Comment" field="comment" error={error} full>
        <textarea id="pdt-comment" className={s.textarea} value={v.comment} onChange={set('comment')} />
      </Field>
      <Field label="Notes" field="notes" error={error} full>
        <textarea id="pdt-notes" className={s.textarea} value={v.notes} onChange={set('notes')} />
      </Field>
      <GeneralError error={error} fields={PRODUCT_FIELDS} />
      <div className={s.formActions}>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : p ? 'Save changes' : 'Create product'}</Button>
      </div>
    </form>
  );
}
// ---------------------------------------------------------------------------------------------------------------------
// Stage change
// ---------------------------------------------------------------------------------------------------------------------

export function StageForm({ product, lookup, initialStage, onSaved, onCancel }: { product: Product; lookup: Lookup; initialStage?: StageCode; onSaved: (d: ProductDetail) => void; onCancel: () => void }) {
  const { token } = useAuth();
  const first = lookup.stages.find((x) => x.code !== product.stage)?.code as StageCode;
  const [to, setTo] = useState<StageCode>(initialStage && initialStage !== product.stage ? initialStage : first);
  const [comment, setComment] = useState('');
  const [actual, setActual] = useState(product.actualLaunch ?? '');
  const [target, setTarget] = useState(product.targetLaunch ?? '');
  const needsTarget = !product.targetLaunch && ['RESEARCH', 'DEVELOPMENT', 'TESTING', 'LAUNCH_READY'].includes(to);
  const { busy, error, submit } = useSubmit(
    () => trackerCall<ProductDetail>(`/products/${product.code}/stage`, token, 'POST', { toStage: to, comment, ...(to === 'LAUNCHED' ? { actualLaunch: actual || null } : {}), ...(needsTarget ? { targetLaunch: target || null } : {}) }),
    onSaved,
  );
  return (
    <form className={s.form} onSubmit={submit} noValidate data-testid="pdt-stage-form">
      <Field label={`From ${lookup.label('stage', product.stage)} to`} field="toStage" error={error}>
        <select id="pdt-toStage" className={s.select} value={to} onChange={(e) => setTo(e.target.value as StageCode)}>
          {lookup.stages.filter((x) => x.code !== product.stage).map((x) => <option key={x.code} value={x.code ?? ''}>{x.label}</option>)}
        </select>
      </Field>
      {to === 'LAUNCHED' && (
        <Field label="Actual launch" field="actualLaunch" error={error}>
          <input id="pdt-actualLaunch" className={cls(s.input, 'actualLaunch', error)} type="date" value={actual} onChange={(e) => setActual(e.target.value)} />
        </Field>
      )}
      {needsTarget && (
        <Field label="Target launch" field="targetLaunch" error={error}>
          <input id="pdt-targetLaunch" className={cls(s.input, 'targetLaunch', error)} type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
      )}
      <Field label="Comment (why the move)" field="comment" error={error} full>
        <textarea id="pdt-comment" className={cls(s.textarea, 'comment', error)} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} required />
      </Field>
      <GeneralError error={error} fields={['toStage', 'comment', 'actualLaunch', 'targetLaunch']} />
      <div className={s.formActions}>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change stage'}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Status update
// ---------------------------------------------------------------------------------------------------------------------

export function UpdateForm({ detail, lookup, today, existing, onSaved, onCancel }: { detail: ProductDetail; lookup: Lookup; today: string; existing?: StatusUpdateRow; onSaved: (d: ProductDetail) => void; onCancel: () => void }) {
  const { token } = useAuth();
  const p = detail.product;
  const forced = detail.blockers.some((b) => b.kind === 'BLOCKER' && (b.status === 'OPEN' || b.status === 'IN_PROGRESS'));
  const [v, setV] = useState({
    updateDate: existing?.updateDate ?? today,
    health: existing ? (existing.health ?? '') : forced ? 'BLOCKED' : p.health === 'BLOCKED' ? 'AT_RISK' : (p.health ?? ''),
    readinessPct: String((existing ? existing.readinessPct : p.readinessPct) ?? ''),
    summary: existing?.summary ?? '',
    nextStep: existing?.nextStep ?? '',
    nextStepDue: existing?.nextStepDue ?? '',
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const { busy, error, submit } = useSubmit(() => {
    const body = { ...v, health: v.health || null, readinessPct: v.readinessPct === '' ? null : Number(v.readinessPct), nextStep: v.nextStep || null, nextStepDue: v.nextStepDue || null };
    return existing ? trackerCall<ProductDetail>(`/updates/${existing.updateId}`, token, 'PATCH', body) : trackerCall<ProductDetail>(`/products/${p.code}/updates`, token, 'POST', body);
  }, onSaved);
  return (
    <form className={s.form} onSubmit={submit} noValidate data-testid="pdt-update-form">
      <Field label="Update date" field="updateDate" error={error}>
        <input id="pdt-updateDate" className={cls(s.input, 'updateDate', error)} type="date" max={today} value={v.updateDate} onChange={set('updateDate')} />
      </Field>
      <Field label="Health" field="health" error={error} hint={forced ? 'Blocked while a Blocker is open.' : undefined}>
        <select id="pdt-health" className={cls(s.select, 'health', error)} value={v.health} onChange={set('health')} disabled={forced}>
          {!forced && NOT_SET_OPTION}
          {lookup.health.filter((x) => (forced ? x.code === 'BLOCKED' : x.code !== 'BLOCKED')).map((x) => <option key={x.code} value={x.code ?? ''}>{x.label}</option>)}
        </select>
      </Field>
      <Field label="Readiness %" field="readinessPct" error={error}>
        <input id="pdt-readinessPct" className={cls(s.input, 'readinessPct', error)} type="number" min={0} max={100} value={v.readinessPct} onChange={set('readinessPct')} />
      </Field>
      <div />
      <Field label="Progress summary" field="summary" error={error} full>
        <textarea id="pdt-summary" className={cls(s.textarea, 'summary', error)} value={v.summary} onChange={set('summary')} required />
      </Field>
      <Field label="Next step" field="nextStep" error={error}>
        <input id="pdt-nextStep" className={cls(s.input, 'nextStep', error)} value={v.nextStep} onChange={set('nextStep')} maxLength={300} />
      </Field>
      <Field label="Next step due" field="nextStepDue" error={error}>
        <input id="pdt-nextStepDue" className={cls(s.input, 'nextStepDue', error)} type="date" value={v.nextStepDue} onChange={set('nextStepDue')} />
      </Field>
      <GeneralError error={error} fields={['updateDate', 'health', 'readinessPct', 'summary', 'nextStep', 'nextStepDue']} />
      <div className={s.formActions}>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save update' : 'Post update'}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Blockers & decisions
// ---------------------------------------------------------------------------------------------------------------------

export function BlockerForm({ options, products, productCode, existing, onSaved, onCancel }: {
  options: Options;
  products?: { code: string; name: string }[];
  productCode?: string;
  existing?: BlockerRow;
  onSaved: (r: { blocker: BlockerRow } & HealthNotice) => void;
  onCancel: () => void;
}) {
  const { token } = useAuth();
  const [v, setV] = useState({
    productCode: productCode ?? existing?.productCode ?? products?.[0]?.code ?? '',
    kind: existing?.kind ?? 'BLOCKER',
    title: existing?.title ?? '',
    requiredAction: existing?.requiredAction ?? '',
    owner: existing?.ownerName ?? '',
    dueDate: existing?.dueDate ?? '',
    status: existing && (existing.status === 'OPEN' || existing.status === 'IN_PROGRESS') ? existing.status : 'OPEN',
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const { busy, error, submit } = useSubmit(() => {
    const body = { productCode: v.productCode, kind: v.kind, title: v.title, requiredAction: v.requiredAction, ...ownerPayload(v.owner, options), dueDate: v.dueDate || null, status: v.status };
    return existing
      ? trackerCall<{ blocker: BlockerRow } & HealthNotice>(`/blockers/${existing.blockerId}`, token, 'PATCH', body)
      : trackerCall<{ blocker: BlockerRow } & HealthNotice>('/blockers', token, 'POST', body);
  }, onSaved);
  return (
    <form className={s.form} onSubmit={submit} noValidate data-testid="pdt-blocker-form">
      {!productCode && !existing && products && (
        <Field label="Product" field="productCode" error={error} full>
          <select id="pdt-productCode" className={cls(s.select, 'productCode', error)} value={v.productCode} onChange={set('productCode')}>
            {products.map((p) => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Type" field="kind" error={error} hint={v.kind === 'BLOCKER' ? 'An open Blocker sets the product to Blocked.' : 'A decision does not change the health.'}>
        <select id="pdt-kind" className={s.select} value={v.kind} onChange={set('kind')}>
          <option value="BLOCKER">Blocker</option>
          <option value="DECISION">Decision needed</option>
        </select>
      </Field>
      <Field label="Status" field="status" error={error}>
        <select id="pdt-status" className={s.select} value={v.status} onChange={set('status')}>
          <option value="OPEN">Open</option>
          <option value="IN_PROGRESS">In progress</option>
        </select>
      </Field>
      <Field label="Title" field="title" error={error} full>
        <input id="pdt-title" className={cls(s.input, 'title', error)} value={v.title} onChange={set('title')} maxLength={200} />
      </Field>
      <Field label="Required action" field="requiredAction" error={error} full>
        <textarea id="pdt-requiredAction" className={cls(s.textarea, 'requiredAction', error)} value={v.requiredAction} onChange={set('requiredAction')} maxLength={500} />
      </Field>
      <Field label="Owner" field="owner" error={error}>
        <OwnerInput id="pdt-blocker-owner" value={v.owner} onChange={(o) => setV({ ...v, owner: o })} options={options} error={error} />
      </Field>
      <Field label="Due date" field="dueDate" error={error}>
        <input id="pdt-dueDate" className={cls(s.input, 'dueDate', error)} type="date" value={v.dueDate} onChange={set('dueDate')} />
      </Field>
      <GeneralError error={error} fields={['productCode', 'kind', 'status', 'title', 'requiredAction', 'owner', 'dueDate']} />
      <div className={s.formActions}>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save' : 'Add'}</Button>
      </div>
    </form>
  );
}

export function ResolveForm({ blocker, today, onSaved, onCancel }: { blocker: BlockerRow; today: string; onSaved: (r: { blocker: BlockerRow } & HealthNotice) => void; onCancel: () => void }) {
  const { token } = useAuth();
  const [status, setStatus] = useState<'RESOLVED' | 'CANCELLED'>('RESOLVED');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today);
  const { busy, error, submit } = useSubmit(
    () => trackerCall<{ blocker: BlockerRow } & HealthNotice>(`/blockers/${blocker.blockerId}/resolve`, token, 'POST', { status, resolutionNote: note, resolvedAt: date }),
    onSaved,
  );
  return (
    <form className={s.form} onSubmit={submit} noValidate data-testid="pdt-resolve-form">
      <Field label="Outcome" field="status" error={error}>
        <select id="pdt-outcome" className={s.select} value={status} onChange={(e) => setStatus(e.target.value as 'RESOLVED' | 'CANCELLED')}>
          <option value="RESOLVED">Resolved</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
      </Field>
      <Field label="Date" field="resolvedAt" error={error}>
        <input id="pdt-resolvedAt" className={cls(s.input, 'resolvedAt', error)} type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label={status === 'RESOLVED' ? 'Resolution note (required)' : 'Note (optional)'} field="resolutionNote" error={error} full>
        <textarea id="pdt-resolutionNote" className={cls(s.textarea, 'resolutionNote', error)} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>
      <GeneralError error={error} fields={['status', 'resolvedAt', 'resolutionNote']} />
      <div className={s.formActions}>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : status === 'RESOLVED' ? 'Resolve' : 'Cancel item'}</Button>
      </div>
    </form>
  );
}
