/**
 * "Latest request wins": every request takes a ticket; only the newest ticket may publish its
 * result. A slow response to an earlier filter change can therefore never overwrite a newer one.
 */
export function createLatestGate() {
  let seq = 0;
  return {
    next(): number { return ++seq; },
    isLatest(ticket: number): boolean { return ticket === seq; },
    /** Invalidate everything in flight (e.g. on unmount). */
    cancelAll(): void { seq++; },
  };
}

/** Trailing debounce with cancel. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; fn(...a); }, ms);
  };
  d.cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
  return d;
}
