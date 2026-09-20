'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** Pixels of movement before a mouse press counts as a drag (below it, it's still a click). */
const DRAG_THRESHOLD_PX = 5;
const EDGE_EPSILON_PX = 2;

/** Physical (left/right) overflow remaining on each side of a scroll container. Browsers report
 * scrollLeft as 0 -> -max in RTL (and 0 -> +max in LTR), so it's normalised here once instead of
 * every caller re-deriving it. Exported for tests. */
export function overflowSides(scrollLeft: number, scrollWidth: number, clientWidth: number, rtl: boolean) {
  const max = Math.max(0, scrollWidth - clientWidth);
  const fromLeft = rtl ? scrollLeft + max : scrollLeft;
  return { left: fromLeft > EDGE_EPSILON_PX, right: max - fromLeft > EDGE_EPSILON_PX };
}

const arrowStyle = (side: 'left' | 'right'): React.CSSProperties => ({
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  [side]: 4,
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: '50%',
  border: '1px solid var(--ps-color-border)',
  background: 'var(--ps-color-surface)',
  color: 'var(--ps-color-text)',
  cursor: 'pointer',
  padding: 0,
});

/**
 * Horizontally scrollable strip for a row of nav tabs: hidden scrollbar, wheel/drag/touch
 * scrolling, edge arrows and fades that only appear when there is more content in that direction,
 * and the tab marked `aria-current="page"` scrolled into view on mount and whenever `activeKey`
 * changes. Children are laid out `flex-shrink: 0; white-space: nowrap` via the
 * `.ps-scroll-nav-track > *` rule in globals.css. Works in LTR and RTL.
 */
export function ScrollableNav({ children, activeKey, label }: { children: React.ReactNode; activeKey?: string; label: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const drag = useRef({ down: false, moved: false, startX: 0, startScroll: 0 });

  const update = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    const next = overflowSides(el.scrollLeft, el.scrollWidth, el.clientWidth, rtl);
    setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    el.addEventListener('scroll', update, { passive: true });

    // Non-passive wheel listener (React's onWheel is passive): vertical wheel -> horizontal scroll,
    // but only while the strip can still move that way, so page scrolling isn't trapped.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const rtl = getComputedStyle(el).direction === 'rtl';
      const sides = overflowSides(el.scrollLeft, el.scrollWidth, el.clientWidth, rtl);
      if ((e.deltaY > 0 && !sides.right) || (e.deltaY < 0 && !sides.left)) return;
      e.preventDefault();
      el.scrollBy({ left: e.deltaY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro?.disconnect();
      el.removeEventListener('scroll', update);
      el.removeEventListener('wheel', onWheel);
    };
  }, [update]);

  // Runs after children re-render for a new `activeKey`, so the new current tab is in the DOM.
  useEffect(() => {
    const el = trackRef.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [activeKey]);

  const scrollByPage = (dir: -1 | 1) => {
    const el = trackRef.current;
    el?.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.6), behavior: 'smooth' });
  };

  // Mouse drag (touch already scrolls natively). A drag that ends on a link must not navigate.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag.current = { down: true, moved: false, startX: e.clientX, startScroll: trackRef.current?.scrollLeft ?? 0 };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d.down || !trackRef.current) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    trackRef.current.scrollLeft = d.startScroll - dx;
  };
  const endDrag = () => {
    drag.current.down = false;
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      drag.current.moved = false;
    }
  };

  const mask =
    `linear-gradient(to right, ${edges.left ? 'transparent 0, #000 28px' : '#000 0'}, ` +
    `${edges.right ? '#000 calc(100% - 28px), transparent 100%' : '#000 100%'})`;

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      {edges.left && (
        <button type="button" aria-label={`Scroll ${label} left`} onClick={() => scrollByPage(-1)} style={arrowStyle('left')}>
          <ChevronLeft size={16} />
        </button>
      )}
      <div
        ref={trackRef}
        role="presentation"
        className="ps-scroll-nav-track ps-hide-scrollbar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onClickCapture={onClickCapture}
        style={{ WebkitMaskImage: mask, maskImage: mask }}
      >
        {children}
      </div>
      {edges.right && (
        <button type="button" aria-label={`Scroll ${label} right`} onClick={() => scrollByPage(1)} style={arrowStyle('right')}>
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  );
}
