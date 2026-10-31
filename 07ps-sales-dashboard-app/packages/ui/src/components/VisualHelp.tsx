'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, Info } from 'lucide-react';

/** "?" — what a visual shows: a plain definition, the formula(s) behind it and optional caveats. */
export interface VisualHelpContent {
  /** 1–2 plain sentences: what this visual shows. */
  definition: string;
  /** e.g. "Variance to Target = (Actual − Target) ÷ Target"; one line per formula. */
  formula?: string | string[];
  /** Period / filter / data-source caveats. */
  notes?: string;
}

/** What a component knows it can do, turned into standard "i" lines (merged with the page's own list). */
export interface VisualCapabilities {
  drill?: boolean;
  expandTable?: boolean;
  exportPdf?: boolean;
  exportCsv?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  search?: boolean;
  clickableRows?: boolean;
  odooLinks?: boolean;
  pageSize?: boolean;
}

export const CAPABILITY_LINES: Record<keyof VisualCapabilities, string> = {
  drill: 'Click the card or a bar / segment to drill into the details',
  expandTable: 'Expand ⤢ to see the data as a table',
  exportPdf: 'Export the visual as PDF',
  exportCsv: 'Export the rows to CSV / Excel',
  sortable: 'Sort by clicking a column header',
  filterable: 'Filter any column using the boxes under the headers',
  search: 'Search all columns with the search box',
  clickableRows: 'Click a row to open its details',
  odooLinks: 'Click a name / number to open it in Odoo (new tab)',
  pageSize: 'Move between pages with Previous / Next',
};

/** Only explain clicks that reveal data or change the view. Toolbar controls explain themselves. */
export function isDetailInteraction(line: string): boolean {
  return /\b(click|tap|drill|open|switch|toggle|select|pick|turn on)\b/i.test(line)
    && !/\b(export|download|copy|sort|header|search|column|rows per page|previous|next page)\b/i.test(line)
    && !/expand|view as table|table view|\bfilter any\b/i.test(line);
}

/** Merge real detail actions without duplicates. Hover and routine toolbar actions never create an icon. */
export function mergeInteractions(lines: readonly string[] | undefined, capabilities?: VisualCapabilities): string[] {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => { const k = key(s); if (s.trim() && !seen.has(k)) { seen.add(k); out.push(s.trim()); } };
  (lines ?? []).filter(isDetailInteraction).forEach(add);
  for (const [cap, on] of Object.entries(capabilities ?? {}) as [keyof VisualCapabilities, boolean | undefined][]) {
    if (on && ['drill', 'clickableRows', 'odooLinks'].includes(cap) && !(cap === 'drill' && out.length > 0)) add(CAPABILITY_LINES[cap]);
  }
  return out;
}

const POPOVER_MAX = 320;
const GAP = 6;
const MARGIN = 8;

/**
 * A small icon button with a themed popover: opens on hover, keyboard focus and tap; closes on Esc, click outside and
 * when the pointer / focus leaves. Rendered in a portal (never clipped by a card) and flipped / clamped to stay inside
 * the viewport. Clicks never reach a clickable card underneath.
 */
export function HintPopover({ label, icon, testId, children }: { label: string; icon: React.ReactNode; testId?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const show = useCallback(() => { cancelClose(); setOpen(true); }, []);
  const hideSoon = useCallback(() => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 120); }, []);
  useEffect(() => () => cancelClose(), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [open]);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(POPOVER_MAX, vw - 2 * MARGIN);
      const h = popRef.current?.offsetHeight ?? 0;
      const below = t.bottom + GAP;
      const candidateTop = below + h > vh - MARGIN && t.top - GAP - h >= MARGIN ? t.top - GAP - h : below;
      const left = Math.max(MARGIN, Math.min(t.left, vw - MARGIN - w));
      const top = Math.max(MARGIN, Math.min(candidateTop, vh - MARGIN - h));
      setPos({ top, left });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        data-testid={testId}
        data-html2canvas-ignore="true"
        className="ps-visual-hint"
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        onClick={(e) => { stop(e); show(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0, margin: 0,
          background: 'none', border: 'none', borderRadius: 999, cursor: 'help',
          color: open ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)',
        }}
      >
        {icon}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          id={id}
          role="tooltip"
          data-testid={testId ? `${testId}-popover` : undefined}
          data-html2canvas-ignore="true"
          onMouseEnter={cancelClose}
          onMouseLeave={hideSoon}
          onClick={stop}
          style={{
            position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, zIndex: 2000,
            width: 'max-content', maxWidth: `min(${POPOVER_MAX}px, calc(100vw - ${2 * MARGIN}px))`,
            padding: '10px 12px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.45, textAlign: 'start',
            maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', whiteSpace: 'normal', overflowWrap: 'anywhere', fontWeight: 400,
            background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)',
            border: '1px solid var(--ps-color-border)', boxShadow: 'var(--ps-card-shadow, 0 8px 24px rgba(0,0,0,0.25))',
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

export interface VisualInfoIconsProps {
  /** The visual's name, the "?" popover's heading. */
  title: string;
  help?: VisualHelpContent;
  interactions?: readonly string[];
  capabilities?: VisualCapabilities;
  size?: number;
}



/**
 * The two icons after a visual's title: "?" (what it shows: definition, formula, notes) then "i" (what you can do with
 * it). Routine controls and hover do not create interaction icons. Intentionally quiet visuals render nothing.
 */
export function VisualInfoIcons({ title, help, interactions, capabilities, size = 14 }: VisualInfoIconsProps) {
  const resolved = help?.definition?.trim() ? help : undefined;
  const lines = mergeInteractions(interactions, capabilities);
  if (!resolved && lines.length === 0) return null;
  const formulas = resolved?.formula === undefined ? [] : Array.isArray(resolved.formula) ? resolved.formula : [resolved.formula];
  return (
    <span data-html2canvas-ignore="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      {resolved && (
        <HintPopover label="About this visual" testId="visual-help" icon={<CircleHelp size={size} aria-hidden />}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
          <div>{resolved.definition}</div>
          {formulas.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 2 }}>Formula</div>
              <div data-testid="visual-help-formula" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, background: 'var(--ps-color-muted-bg)', borderRadius: 6, padding: '6px 8px' }}>
                {formulas.map((f) => <div key={f}>{f}</div>)}
              </div>
            </div>
          )}
          {resolved.notes && <div style={{ marginTop: 8, color: 'var(--ps-color-muted-text)', fontSize: 12 }}>{resolved.notes}</div>}
        </HintPopover>
      )}
      {lines.length > 0 && (
        <HintPopover label="How to interact" testId="visual-interactions" icon={<Info size={size} aria-hidden />}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>What you can do</div>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </HintPopover>
      )}
    </span>
  );
}
