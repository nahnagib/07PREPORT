'use client';
import React, { useState } from 'react';
import { Button, Card, DateField, EmptyState, ErrorState, LoadingSkeleton, VisualInfoIcons, type VisualHelpContent } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { download, ENTRY, PLAN, type Row } from '../../lib/pdp/api';
import { apiFieldError, errorText, type PdpState } from '../../lib/pdp/hooks';
import { copy as t, enumLabel, label } from '../../lib/pdp/text';

/**
 * Building blocks shared by every Product Development Plan screen, all on @07ps/ui and the app theme:
 * loading / error / empty states, section cards, status chips, the Excel/PDF bar and a form in the Kaizen card-form
 * style (ps-kaizen-field / ps-kaizen-input, red * on required fields, the API's message under the field it names).
 */

/** LoadingSkeleton while loading, ErrorState (with the API's message and Retry) on failure, else the content. */
export function Loaded<T>({
  state,
  skeleton = 'table',
  children,
}: {
  state: PdpState<T>;
  skeleton?: 'kpi' | 'chart' | 'table';
  children: (data: T) => React.ReactNode;
}) {
  if (state.error) return <ErrorState message={state.error} onRetry={state.retry} />;
  if (state.loading && !state.data) return <LoadingSkeleton variant={skeleton} />;
  if (!state.data) return <ErrorState message="No data was returned." onRetry={state.retry} />;
  return <>{children(state.data)}</>;
}

/** An empty list always says why it is empty. */
export function Empty({ message }: { message: string }) {
  return <EmptyState message={message} />;
}

/** One card per visual: title, "?"/"i" help icons, optional actions on the right. */
export function Section({
  title,
  help,
  actions,
  children,
  testId,
}: {
  title: string;
  help?: VisualHelpContent;
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card data-testid={testId} style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {title}
          {help && <VisualInfoIcons title={title} help={help} />}
        </span>
        {actions && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{actions}</div>}
      </div>
      {children}
    </Card>
  );
}

/** Coloured pill: a status, a state, a gate (same look as the Kaizen status pill). */
export function Chip({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return (
    <span className="ps-kaizen-pill" title={title} style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
      <span className="ps-kaizen-dot" style={{ background: color }} />
      {children}
    </span>
  );
}

/** A banner line: alert (red), watch (gold) or info (accent). */
export function Notice({ tone = 'info', children }: { tone?: 'alert' | 'watch' | 'info' | 'success'; children: React.ReactNode }) {
  const color = { alert: 'var(--ps-color-alert)', watch: 'var(--ps-color-gold)', info: 'var(--ps-color-accent)', success: 'var(--ps-color-success)' }[tone];
  return (
    <div
      role={tone === 'alert' ? 'alert' : 'status'}
      style={{
        borderInlineStart: `4px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, var(--ps-card-bg, var(--ps-color-surface)))`,
        color: 'var(--ps-color-text)',
        padding: '8px 12px',
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

/** Excel download of a list + browser print (PDF), shown only with an Export permission. */
export function ExportBar({ area, fileName }: { area: 'tree' | 'projects' | 'feedback'; fileName: string }) {
  const { token, canExport } = useAuth();
  const [error, setError] = useState<string | null>(null);
  if (!canExport(PLAN) && !canExport(ENTRY)) return null;
  return (
    <>
      <Button
        variant="secondary"
        style={{ padding: '6px 12px', fontSize: 12.5 }}
        onClick={() => download(`/${area}/export`, token, fileName).catch((e) => setError(errorText(e)))}
      >
        {t.excel}
      </Button>
      <Button variant="secondary" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => window.print()}>
        {t.print}
      </Button>
      {error && <span role="alert" style={{ color: 'var(--ps-color-alert)', fontSize: 12 }}>{error}</span>}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ form

export interface Option {
  value: string | number;
  label: string;
}
export interface FieldSpec {
  key: string;
  type?: 'text' | 'textarea' | 'date' | 'number' | 'select' | 'checkbox';
  required?: boolean;
  /** Spans both columns (long text). */
  full?: boolean;
  hint?: string;
  label?: string;
  options?: Option[];
  min?: number;
  max?: number;
}

/** "title! status:select date:date" -> field specs (! = required). */
export function fields(spec: string, extra: Record<string, Partial<FieldSpec>> = {}): FieldSpec[] {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const [key, type] = raw.replace('!', '').split(':');
      return { key, type: (type as FieldSpec['type']) ?? 'text', required: raw.includes('!'), full: type === 'textarea', ...extra[key] };
    });
}

const ENUMS: Record<string, string[]> = {
  status: ['in_market', 'planned', 'under_development', 'discontinued'],
  classification: ['planned', 'unplanned', 'innovation', 'reformulation'],
  innovationCategory: ['quick_win', 'commercial_driven', 'technical_enhancement', 'strategic_long_term'],
  decision: ['approve', 'reject', 'revise'],
  severity: ['critical', 'minor'],
  followupStatus: ['open', 'in_progress', 'resolved', 'closed'],
  category: ['MANPOWER', 'MACHINE', 'MATERIALS', 'METHODS', 'MEASUREMENTS'],
  gapStatus: ['open', 'in_progress', 'done'],
  listKey: ['project_type', 'request_source', 'competitor', 'lab_property', 'feedback_channel', 'feedback_category'],
};
const DROPDOWN_LIST: Record<string, string> = {
  projectTypeId: 'project_type',
  requestSourceId: 'request_source',
  competitorId: 'competitor',
  propertyId: 'lab_property',
  channelId: 'feedback_channel',
  categoryId: 'feedback_category',
};

/** Choices for a select field, from the module's /options payload. */
export function optionsFor(key: string, o: Row | null | undefined): Option[] | undefined {
  const opts = o ?? {};
  if (ENUMS[key]) return ENUMS[key].map((v) => ({ value: v, label: key === 'listKey' ? label(v) : enumLabel(v) }));
  if (key === 'productId') return (opts.products ?? []).map((p: Row) => ({ value: p.product_id, label: `${p.name} · ${p.family}` }));
  if (key === 'familyId') return (opts.families ?? []).map((f: Row) => ({ value: f.family_id, label: f.name }));
  if (key === 'brandId') return (opts.brands ?? []).map((b: Row) => ({ value: b.brand_id, label: b.name }));
  if (key === 'subfamilyId' || key === 'proposedSubfamilyId') {
    return (opts.families ?? []).flatMap((f: Row) => f.subfamilies.map((s: Row) => ({ value: s.subfamily_id, label: `${f.name} › ${s.name}` })));
  }
  if (['ownerUserId', 'userId', 'tsLeadUserId', 'followupOwnerUserId'].includes(key)) {
    return (opts.users ?? []).map((u: Row) => ({ value: u.user_id, label: u.display_name }));
  }
  if (key === 'roleCode') return (opts.governance ?? []).map((g: Row) => ({ value: g.code, label: g.label }));
  if (DROPDOWN_LIST[key]) {
    return (opts.dropdowns ?? []).filter((d: Row) => d.list_key === DROPDOWN_LIST[key] && d.is_active).map((d: Row) => ({ value: d.value_id, label: d.label }));
  }
  return undefined;
}

const toInput = (v: unknown) => (v === null || v === undefined ? '' : v);

/**
 * A form in the Kaizen card-form style. Required fields are checked here first; then the API is the authority: its
 * `{ error, code, field }` lands under the field it names (or above the buttons when it names none).
 */
export function PdpForm({
  spec,
  initial = {},
  options,
  onSubmit,
  submitLabel = t.save,
  onCancel,
  onSaved,
  extraActions,
}: {
  spec: FieldSpec[];
  initial?: Row;
  options?: Row | null;
  onSubmit: (values: Row) => Promise<unknown>;
  submitLabel?: string;
  onCancel?: () => void;
  onSaved?: () => void;
  extraActions?: React.ReactNode;
}) {
  const [values, setValues] = useState<Row>(() => Object.fromEntries(spec.map((f) => [f.key, f.type === 'checkbox' ? Boolean(initial[f.key]) : toInput(initial[f.key])])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (key: string, v: unknown) => {
    setValues((s) => ({ ...s, [key]: v }));
    setErrors((e) => ({ ...e, [key]: '' }));
    setSaved(false);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    for (const f of spec) {
      if (f.required && f.type !== 'checkbox' && (values[f.key] === '' || values[f.key] === null || values[f.key] === undefined)) {
        found[f.key] = `${f.label ?? label(f.key)} is required.`;
      }
    }
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) return;
    const body: Row = {};
    for (const f of spec) {
      const v = values[f.key];
      if (f.type === 'checkbox') body[f.key] = Boolean(v);
      else if (v === '') body[f.key] = null;
      else if (f.type === 'number') body[f.key] = Number(v);
      else if (f.type === 'select') {
        const opt = (f.options ?? optionsFor(f.key, options))?.find((o) => String(o.value) === String(v));
        body[f.key] = opt ? opt.value : v;
      } else body[f.key] = v;
    }
    setSaving(true);
    try {
      await onSubmit(body);
      setSaved(true);
      onSaved?.();
    } catch (err) {
      const fe = apiFieldError(err);
      const target = fe.field ? spec.find((f) => f.key === fe.field || fe.field?.startsWith(`${f.key}.`)) : undefined;
      if (target) setErrors({ [target.key]: fe.message });
      else setFormError(fe.message);
    } finally {
      setSaving(false);
    }
  }

  const control = (f: FieldSpec) => {
    const invalid = Boolean(errors[f.key]);
    const common = { 'aria-invalid': invalid, 'aria-label': f.label ?? label(f.key) };
    const choices = f.options ?? optionsFor(f.key, options);
    if (f.type === 'select' || (choices && f.type !== 'checkbox')) {
      return (
        <select className="ps-kaizen-input" value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} {...common}>
          <option value="">{t.choose}</option>
          {(choices ?? []).map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (f.type === 'textarea') return <textarea className="ps-kaizen-input" dir="auto" value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} {...common} />;
    if (f.type === 'date') {
      return <DateField className="ps-kaizen-input" value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} clearable={!f.required} aria-invalid={invalid} aria-label={common['aria-label']} />;
    }
    if (f.type === 'checkbox') {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 36 }}>
          <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => set(f.key, e.target.checked)} aria-label={common['aria-label']} />
        </span>
      );
    }
    return (
      <input
        className="ps-kaizen-input"
        dir="auto"
        type={f.type === 'number' ? 'number' : 'text'}
        min={f.min}
        max={f.max}
        value={values[f.key]}
        onChange={(e) => set(f.key, e.target.value)}
        {...common}
      />
    );
  };

  return (
    <form onSubmit={submit} noValidate className="ps-kaizen-form">
      {spec.map((f) => (
        <label key={f.key} className={`ps-kaizen-field${f.full ? ' ps-kaizen-full' : ''}`}>
          <span>
            {f.label ?? label(f.key)}{' '}
            {f.required ? (
              <span style={{ color: 'var(--ps-color-alert)' }} aria-hidden>
                *
              </span>
            ) : f.type === 'checkbox' ? null : (
              <em style={{ fontStyle: 'normal', opacity: 0.7 }}>({t.optional})</em>
            )}
          </span>
          {control(f)}
          {errors[f.key] ? (
            <em role="alert" style={{ fontStyle: 'normal', fontSize: 12, color: 'var(--ps-color-alert)' }}>
              {errors[f.key]}
            </em>
          ) : f.hint ? (
            <em style={{ fontStyle: 'normal', fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{f.hint}</em>
          ) : null}
        </label>
      ))}
      {formError && (
        <p role="alert" className="ps-kaizen-full" style={{ margin: 0, color: 'var(--ps-color-alert)' }}>
          {formError}
        </p>
      )}
      <div className="ps-kaizen-full" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
        {saved && !formError && (
          <span role="status" style={{ color: 'var(--ps-color-success)', fontSize: 13, marginInlineEnd: 'auto' }}>
            {t.saved}
          </span>
        )}
        {extraActions}
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
            {t.cancel}
          </Button>
        )}
        <Button type="submit" disabled={saving}>
          {saving ? t.saving : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A collapsed "Add …" / "Edit …" form inside a card (opens on click, closes after a save). */
export function FormToggle({ label: buttonLabel, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="secondary" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setOpen(true)}>
        {buttonLabel}
      </Button>
    );
  }
  return (
    <div style={{ flexBasis: '100%', border: '1px solid var(--ps-color-border)', borderRadius: 10, padding: 14, marginTop: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{buttonLabel}</div>
      {children(() => setOpen(false))}
    </div>
  );
}

/** A small action button that calls the API and reports its error inline (hold, confirm, delete, …). */
export function ActionButton({
  children,
  onClick,
  variant = 'secondary',
  confirmText,
}: {
  children: React.ReactNode;
  onClick: () => Promise<unknown>;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  confirmText?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <Button
        variant={variant}
        disabled={busy}
        style={{ padding: '6px 12px', fontSize: 12.5 }}
        onClick={async () => {
          if (confirmText && !window.confirm(confirmText)) return;
          setBusy(true);
          setError(null);
          try {
            await onClick();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </Button>
      {error && (
        <span role="alert" style={{ color: 'var(--ps-color-alert)', fontSize: 12, maxWidth: 320 }}>
          {error}
        </span>
      )}
    </span>
  );
}

/** Label / value pairs (read-only details), two columns like the Kaizen card details. */
export function Details({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <div className="ps-kaizen-form">
      {items.map(([k, v]) => (
        <div key={k} style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 3 }}>{k}</div>
          <div dir="auto" style={{ fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {v === null || v === undefined || v === '' ? '—' : v}
          </div>
        </div>
      ))}
    </div>
  );
}

/** "14 Nov 2026" from YYYY-MM-DD or an ISO instant. */
export function fmtDate(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v).length === 10 ? `${v}T00:00:00Z` : String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: String(v).length === 10 ? 'UTC' : undefined });
}
