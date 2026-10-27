'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Lock } from 'lucide-react';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface MonthInputProps {
  label: string;
  year: number;
  month: number;
  onChange: (year: number, month: number) => void;
  /**
   * Which day of the picked month the field stands for -- the day is LOCKED, never editable:
   * 'start' always shows the 1st ("01 Jan 2026"), 'end' the month's last day ("31 Aug 2026").
   * For data that only exists per month (MARCOM), so a range can't pretend to cut a month in half.
   */
  edge: 'start' | 'end';
  /** Years the calendar can page through (inclusive). */
  minYear: number;
  maxYear: number;
  /** Greys out and refuses a month (e.g. after the latest uploaded month, or before the From month). */
  isMonthDisabled?: (year: number, month: number) => boolean;
  /** Keeps the calendar on `year` (no year paging) -- e.g. a To field that must stay in the From field's year. */
  lockYear?: boolean;
  disabled?: boolean;
  helperText?: string;
}

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/** "01 Jan 2026" / "31 Aug 2026" -- same en-GB format as DateInput. */
export function formatMonthEdge(year: number, month: number, edge: 'start' | 'end'): string {
  return `${pad(edge === 'start' ? 1 : lastDay(year, month))} ${MONTHS_SHORT[month - 1]} ${year}`;
}

/**
 * A From/To date field whose calendar picks a MONTH: same chrome as DateInput (label, calendar icon,
 * 38px field, accent focus ring) but the popover is a 12-month grid with year paging, and the day
 * part is fixed by `edge`. Keyboard: Enter/Space/ArrowDown opens, arrows move, Enter picks, Escape
 * closes; outside click closes.
 */
export function MonthInput({ label, year, month, onChange, edge, minYear, maxYear, isMonthDisabled, lockYear = false, disabled = false, helperText }: MonthInputProps) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(year);
  const [focusMonth, setFocusMonth] = useState(month);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setViewYear(year);
      setFocusMonth(month);
    }
  }, [open, year, month]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (open) gridRef.current?.querySelector<HTMLButtonElement>(`[data-month="${focusMonth}"]`)?.focus();
  }, [open, focusMonth, viewYear]);

  const off = (y: number, m: number) => !!isMonthDisabled?.(y, m);
  const canPrev = !lockYear && viewYear > minYear;
  const canNext = !lockYear && viewYear < maxYear;

  const pick = (m: number) => {
    if (off(viewYear, m)) return;
    onChange(viewYear, m);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
    if (e.key in step) {
      e.preventDefault();
      const next = focusMonth + step[e.key];
      if (next >= 1 && next <= 12) setFocusMonth(next);
      else if (next < 1 && canPrev) { setViewYear((y) => y - 1); setFocusMonth(next + 12); }
      else if (next > 12 && canNext) { setViewYear((y) => y + 1); setFocusMonth(next - 12); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'PageUp' && canPrev) {
      e.preventDefault();
      setViewYear((y) => y - 1);
    } else if (e.key === 'PageDown' && canNext) {
      e.preventDefault();
      setViewYear((y) => y + 1);
    }
  };

  const navBtn = (enabled: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6,
    border: '1px solid var(--ps-color-border)', background: 'transparent', color: 'var(--ps-color-text)',
    cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.35,
  });

  return (
    <div ref={rootRef} style={{ position: 'relative', opacity: disabled ? 0.5 : 1, marginBottom: 16 }}>
      <label
        style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}
        onClick={() => triggerRef.current?.focus()}
      >
        {label}
      </label>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${formatMonthEdge(year, month, edge)}`}
        data-testid={`month-input-${edge}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 38, width: '100%', boxSizing: 'border-box', padding: '0 10px',
          borderRadius: 8, border: `1px solid ${open ? 'var(--ps-color-accent)' : 'var(--ps-color-border)'}`,
          background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14, fontFamily: 'inherit',
          boxShadow: open ? '0 0 0 3px color-mix(in srgb, var(--ps-color-accent) 20%, transparent)' : 'none',
          cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'start',
        }}
      >
        <Calendar size={16} style={{ color: 'var(--ps-color-muted-text)', flexShrink: 0 }} aria-hidden />
        <span style={{ flex: 1, fontVariantNumeric: 'tabular-nums' }}>
          {/* The day is fixed by the month edge: shown muted so it reads as locked. */}
          <span style={{ color: 'var(--ps-color-muted-text)' }}>{pad(edge === 'start' ? 1 : lastDay(year, month))}</span>{' '}
          {MONTHS_SHORT[month - 1]} {year}
        </span>
      </button>
      {helperText && <div style={{ fontSize: 10, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{helperText}</div>}

      {open && (
        <div
          role="dialog"
          aria-label={`${label} — choose a month`}
          style={{
            position: 'absolute', zIndex: 40, top: '100%', insetInlineStart: 0, marginTop: 4, width: 252, padding: 10,
            background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderRadius: 10,
            boxShadow: 'var(--ps-card-shadow, 0 8px 24px rgba(0,0,0,.18))', color: 'var(--ps-color-text)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button type="button" aria-label="Previous year" disabled={!canPrev} onClick={() => canPrev && setViewYear((y) => y - 1)} style={navBtn(canPrev)}>
              <ChevronLeft size={14} aria-hidden />
            </button>
            <strong style={{ fontSize: 14, fontVariantNumeric: 'tabular-nums' }} aria-live="polite">{viewYear}</strong>
            <button type="button" aria-label="Next year" disabled={!canNext} onClick={() => canNext && setViewYear((y) => y + 1)} style={navBtn(canNext)}>
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
          <div ref={gridRef} role="grid" aria-label={String(viewYear)} onKeyDown={onGridKey} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {MONTHS_SHORT.map((name, i) => {
              const m = i + 1;
              const isOff = off(viewYear, m);
              const selected = viewYear === year && m === month;
              return (
                <button
                  key={name}
                  type="button"
                  role="gridcell"
                  data-month={m}
                  aria-selected={selected}
                  aria-disabled={isOff}
                  tabIndex={m === focusMonth ? 0 : -1}
                  onClick={() => pick(m)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(m); } }}
                  title={isOff ? 'No data for this month' : `${formatMonthEdge(viewYear, m, edge)}`}
                  style={{
                    height: 34, borderRadius: 7, fontSize: 13, fontFamily: 'inherit', fontWeight: selected ? 700 : 500,
                    border: `1px solid ${selected ? 'var(--ps-color-accent)' : 'transparent'}`,
                    background: selected ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-bg)',
                    color: selected ? 'var(--ps-color-on-accent)' : 'var(--ps-color-text)',
                    opacity: isOff ? 0.35 : 1, cursor: isOff ? 'not-allowed' : 'pointer',
                    textDecoration: isOff ? 'line-through' : 'none',
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
            <Lock size={11} aria-hidden />
            {edge === 'start' ? 'Starts on the 1st of the month' : 'Ends on the last day of the month'}
            {lockYear ? ' · same year as From' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
