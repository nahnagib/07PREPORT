'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, DateField, ErrorState } from '@07ps/ui';
import { NoAccess } from '../NoAccess';
import { KaizenShell, KAIZEN_BASE } from './KaizenShell';
import { CloseCardDialog } from './CloseCardDialog';
import { useKaizenOptions } from './useKaizenOptions';
import { useAuth } from '../../lib/AuthProvider';
import { errorText, kt as t, type KaizenTextKey } from '../../lib/kaizen/text';
import { ApiError } from '../../lib/api';
import { errorCode, kaizenApi, todayIso, type KaizenCard, type KaizenCardInput, type KaizenListKey } from '../../lib/kaizen/api';

type Field = keyof KaizenCardInput;

function emptyInput(): KaizenCardInput {
  return {
    creatorName: '',
    cardDate: todayIso(),
    departmentId: '',
    cardName: '',
    cardTypeId: '',
    issue: '',
    rootCause: '',
    impact: '',
    priorityId: '',
    proposedSolution: '',
    expectedDate: '',
    closerDate: '',
    responsibleParty: '',
    status: 'OPEN',
  };
}

function fromCard(c: KaizenCard): KaizenCardInput {
  return {
    creatorName: c.creator_name,
    cardDate: c.card_date,
    departmentId: c.department_id,
    cardName: c.card_name,
    cardTypeId: c.card_type_id,
    issue: c.issue,
    rootCause: c.root_cause ?? '',
    impact: c.impact ?? '',
    priorityId: c.priority_id,
    proposedSolution: c.proposed_solution ?? '',
    expectedDate: c.expected_date ?? '',
    closerDate: c.closer_date ?? '',
    responsibleParty: c.responsible_party ?? '',
    status: c.status,
  };
}

/** The same rules the API enforces (kaizenService.validateCardValues), checked before sending so
 * the user sees them at once; the server remains the authority. Returns field -> error code. */
export function validateKaizenInput(v: KaizenCardInput): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  if (!v.creatorName.trim()) e.creatorName = 'card.creatorRequired';
  if (!v.cardDate) e.cardDate = 'card.dateRequired';
  if (!v.departmentId) e.departmentId = 'card.departmentRequired';
  if (!v.cardName.trim()) e.cardName = 'card.nameRequired';
  if (!v.cardTypeId) e.cardTypeId = 'card.typeRequired';
  if (!v.issue.trim()) e.issue = 'card.issueRequired';
  if (!v.priorityId) e.priorityId = 'card.priorityRequired';
  if (v.expectedDate && v.cardDate && v.expectedDate < v.cardDate) e.expectedDate = 'card.expectedBeforeDate';
  if (v.status === 'CLOSED' && !v.closerDate) e.closerDate = 'card.closerRequired';
  if (v.status === 'OPEN' && v.closerDate) e.closerDate = 'card.closerOnlyWhenClosed';
  if (v.closerDate && v.cardDate && v.closerDate < v.cardDate) e.closerDate = 'card.closerBeforeDate';
  return e;
}

/** Add card (no `cardNo`) or edit card #cardNo. Needs Kaizen Cards Create / Edit respectively. */
export function KaizenCardForm({ cardNo }: { cardNo?: number }) {
  const { can } = useAuth();
  const mode = cardNo === undefined ? 'create' : 'edit';
  if (!can('kaizen_cards', 'view') || !can('kaizen_cards', mode)) return <NoAccess />;
  return (
    <KaizenShell titleKey={mode === 'create' ? 'kaizen.newCard' : 'kaizen.editCard'} titleVars={{ no: cardNo ?? '' }}>
      <FormBody cardNo={cardNo} />
    </KaizenShell>
  );
}

function FormBody({ cardNo }: { cardNo?: number }) {
  const { token, canEdit } = useAuth();
  const router = useRouter();
  const options = useKaizenOptions();
  const [original, setOriginal] = useState<KaizenCard | null | undefined>(cardNo === undefined ? null : undefined);
  const [values, setValues] = useState<KaizenCardInput>(emptyInput);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (cardNo === undefined || !token) return;
    kaizenApi
      .getCard(token, cardNo)
      .then(({ card }) => {
        setOriginal(card);
        setValues(fromCard(card));
      })
      .catch(() => setLoadError(true));
  }, [cardNo, token]);

  if (loadError) return <ErrorState message={t('kaizen.notFound')} />;
  if (original === undefined || options.loading) return <p style={{ color: 'var(--ps-color-muted-text)' }}>{t('kaizen.loading')}</p>;

  const set = <K extends Field>(field: K, value: KaizenCardInput[K]) => {
    setValues((v) => {
      const next = { ...v, [field]: value };
      // Status drives Closer Date: closing pre-fills today, reopening clears it.
      if (field === 'status') next.closerDate = value === 'CLOSED' ? v.closerDate || todayIso() : '';
      return next;
    });
    setErrors((e) => ({ ...e, [field]: undefined, ...(field === 'status' ? { closerDate: undefined } : {}) }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    const found = validateKaizenInput(values);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      const { card } = cardNo === undefined ? await kaizenApi.createCard(token, values) : await kaizenApi.updateCard(token, cardNo, values);
      router.push(`${KAIZEN_BASE}/manage?no=${card.card_no}`);
    } catch (err) {
      const code = errorCode(err);
      const field = err instanceof ApiError && err.body && typeof err.body === 'object' ? (err.body as { field?: Field }).field : undefined;
      if (code && field) setErrors({ [field]: code });
      else setFormError(errorText(code) ?? (err instanceof ApiError ? err.message : t('err.generic')));
    } finally {
      setSaving(false);
    }
  }

  const errText = (field: Field) => (errors[field] ? errorText(errors[field]) ?? t('err.generic') : null);
  const label = (key: KaizenTextKey, required: boolean) => (
    <span>
      {t(key)} {required ? <span style={{ color: 'var(--ps-color-alert)' }} aria-hidden>*</span> : <em style={{ fontStyle: 'normal', opacity: 0.7 }}>({t('kaizen.optional')})</em>}
    </span>
  );
  const fieldWrap = (field: Field, labelKey: KaizenTextKey, required: boolean, control: React.ReactNode, full = false, hint?: string) => (
    <label className={`ps-kaizen-field${full ? ' ps-kaizen-full' : ''}`}>
      {label(labelKey, required)}
      {control}
      {errText(field) ? (
        <em role="alert" style={{ fontStyle: 'normal', fontSize: 12, color: 'var(--ps-color-alert)' }}>{errText(field)}</em>
      ) : hint ? (
        <em style={{ fontStyle: 'normal', fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{hint}</em>
      ) : null}
    </label>
  );
  const text = (field: Field, max?: number, listId?: string) => (
    <input
      className="ps-kaizen-input"
      dir="auto"
      value={values[field] as string}
      maxLength={max}
      list={listId}
      aria-invalid={Boolean(errors[field])}
      onChange={(e) => set(field, e.target.value as never)}
    />
  );
  const area = (field: Field) => (
    <textarea className="ps-kaizen-input" dir="auto" value={values[field] as string} aria-invalid={Boolean(errors[field])} onChange={(e) => set(field, e.target.value as never)} />
  );
  // "01 Jan 2026" whatever the browser's locale; optional dates can be cleared.
  const date = (field: Field, extra: { min?: string; disabled?: boolean } = {}) => (
    <DateField
      className="ps-kaizen-input"
      value={values[field] as string}
      aria-invalid={Boolean(errors[field])}
      onChange={(v) => set(field, v as never)}
      clearable={field !== 'cardDate'}
      style={errors[field] ? { borderColor: 'var(--ps-color-alert)' } : undefined}
      {...extra}
    />
  );
  // Active values only -- plus the card's current value if it has since been deactivated.
  const select = (field: 'departmentId' | 'cardTypeId' | 'priorityId', list: KaizenListKey) => {
    const current = values[field];
    const choices = options.listValues(list).filter((d) => d.is_active || d.value_id === current);
    return (
      <select className="ps-kaizen-input" value={current} aria-invalid={Boolean(errors[field])} onChange={(e) => set(field, e.target.value ? Number(e.target.value) : '')}>
        <option value="">{t('kaizen.choose')}</option>
        {choices.map((d) => (
          <option key={d.value_id} value={d.value_id}>
            {d.label}
            {d.is_active ? '' : ` (${t('kaizen.inactive')})`}
          </option>
        ))}
      </select>
    );
  };

  return (
    <Card style={{ maxWidth: 980 }}>
      <form onSubmit={submit} noValidate className="ps-kaizen-form">
        {original && <div className="ps-kaizen-full" style={{ fontSize: 22, fontWeight: 800, color: 'var(--ps-color-muted-text)' }}>#{original.card_no}</div>}
        {fieldWrap('cardName', 'kaizen.f.cardName', true, text('cardName', 200), true)}
        {fieldWrap('creatorName', 'kaizen.f.creator', true, text('creatorName', 150, 'kaizen-creators'))}
        {fieldWrap('cardDate', 'kaizen.f.date', true, date('cardDate'))}
        {fieldWrap('departmentId', 'kaizen.f.department', true, select('departmentId', 'department'))}
        {fieldWrap('cardTypeId', 'kaizen.f.type', true, select('cardTypeId', 'card_type'))}
        {fieldWrap('priorityId', 'kaizen.f.priority', true, select('priorityId', 'card_priority'))}
        {fieldWrap('responsibleParty', 'kaizen.f.responsible', false, text('responsibleParty', 150, 'kaizen-responsible'), false, t('kaizen.responsibleHint'))}
        {fieldWrap('issue', 'kaizen.f.issue', true, area('issue'), true)}
        {fieldWrap('rootCause', 'kaizen.f.rootCause', false, area('rootCause'), true)}
        {fieldWrap('impact', 'kaizen.f.impact', false, area('impact'), true)}
        {fieldWrap('proposedSolution', 'kaizen.f.solution', false, area('proposedSolution'), true)}
        {fieldWrap('expectedDate', 'kaizen.f.expectedDate', false, date('expectedDate', { min: values.cardDate || undefined }))}
        {fieldWrap(
          'status',
          'kaizen.f.status',
          true,
          <select className="ps-kaizen-input" value={values.status} onChange={(e) => set('status', e.target.value as KaizenCardInput['status'])}>
            <option value="OPEN">{t('kaizen.status.OPEN')}</option>
            <option value="CLOSED">{t('kaizen.status.CLOSED')}</option>
          </select>,
        )}
        {fieldWrap(
          'closerDate',
          'kaizen.f.closerDate',
          values.status === 'CLOSED',
          date('closerDate', { min: values.cardDate || undefined, disabled: values.status !== 'CLOSED' }),
          false,
          t('kaizen.closerHint'),
        )}

        <datalist id="kaizen-creators">
          {options.options?.creators.map((n) => <option key={n} value={n} />)}
        </datalist>
        <datalist id="kaizen-responsible">
          {options.options?.responsibleParties.map((n) => <option key={n} value={n} />)}
        </datalist>

        {formError && <p role="alert" className="ps-kaizen-full" style={{ margin: 0, color: 'var(--ps-color-alert)' }}>{formError}</p>}
        <div className="ps-kaizen-full" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {original && original.status === 'OPEN' && canEdit('kaizen_cards') && (
            <Button type="button" variant="secondary" style={{ color: 'var(--ps-color-success)', marginInlineEnd: 'auto' }} onClick={() => setClosing(true)} disabled={saving}>
              {t('kaizen.close')}
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={() => router.back()} disabled={saving}>{t('kaizen.cancel')}</Button>
          <Button type="submit" disabled={saving}>{saving ? t('kaizen.saving') : t('kaizen.save')}</Button>
        </div>
      </form>
      {closing && original && (
        <CloseCardDialog
          card={original}
          onCancel={() => setClosing(false)}
          onClosed={(card) => router.push(`${KAIZEN_BASE}/manage?no=${card.card_no}`)}
        />
      )}
    </Card>
  );
}
