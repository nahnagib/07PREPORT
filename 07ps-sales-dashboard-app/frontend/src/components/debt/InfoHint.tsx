import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { placeTooltip } from '../../lib/debt/creditPolicy';

/** Compact help with the same details available on hover, keyboard focus, and tap. */
export function InfoHint({ label, detail }: { label: string; detail: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <span style={{ display: 'inline-flex', verticalAlign: 'middle' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button ref={anchor} type="button" aria-label={`${label} details`} aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        style={{ display: 'inline-flex', padding: 2, border: 0, background: 'none', color: 'var(--ps-color-muted-text)', cursor: 'help' }}>
        <Info size={14} aria-hidden />
      </button>
      {open && <HelpPopover id={id} anchor={anchor} detail={detail} />}
    </span>
  );
}

function HelpPopover({ id, anchor, detail }: { id: string; anchor: React.RefObject<HTMLButtonElement>; detail: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!ref.current || !anchor.current) return;
    setPosition(placeTooltip(anchor.current.getBoundingClientRect(), { width: ref.current.offsetWidth, height: ref.current.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor, detail]);
  return createPortal(
    <div ref={ref} id={id} role="tooltip" style={{ position: 'fixed', zIndex: 1100, left: position?.left ?? 0, top: position?.top ?? 0,
      visibility: position ? 'visible' : 'hidden', pointerEvents: 'none', width: 'min(400px, calc(100vw - 24px))', boxSizing: 'border-box',
      background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', border: '1px solid var(--ps-color-border)', borderRadius: 10,
      boxShadow: 'var(--ps-card-shadow)', padding: 12, fontSize: 12, fontWeight: 400, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{detail}</div>, document.body,
  );
}
