import { authorizeExport } from './exportPermission';

/**
 * Shared "export the rendered chart to a PNG" utility, factored out of what used to be 7 nearly
 * identical `handleExportImage` implementations (one per chart component). All of them clone the
 * chart's rendered <svg>, serialize the clone to a Blob, load it into an off-DOM <img>, then draw
 * that onto a <canvas> to produce the downloadable PNG.
 *
 * Bug this fixes: every stroke/fill in these charts is set via CSS custom properties (e.g.
 * `stroke="var(--ps-color-accent)"`), which only resolve while the element is attached to the
 * live document. Once the clone is serialized and rendered as a standalone image resource (the
 * Blob -> <img> step), it's outside the page's CSS cascade, so every `var(--...)` reference fails
 * to resolve and falls back to its SVG initial value -- `fill`'s initial value is black, which is
 * why exported charts rendered bars/axis-text in solid black regardless of theme, and were
 * unreadable in dark mode (black text on a dark background). Fix: before cloning, walk the LIVE
 * svg (still attached to the document, so getComputedStyle resolves every var()) and copy each
 * element's resolved fill/stroke/color/stop-color onto the matching clone element as a concrete
 * inline style, pairing elements by document order since cloneNode(true) preserves structure
 * exactly.
 */
function inlineComputedColors(source: SVGElement, clone: SVGElement) {
  const sourceEls: Element[] = [source, ...Array.from(source.querySelectorAll('*'))];
  const cloneEls: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];

  sourceEls.forEach((sourceEl, i) => {
    const cloneEl = cloneEls[i] as SVGElement | undefined;
    if (!cloneEl || !(cloneEl instanceof SVGElement)) return;
    const computed = window.getComputedStyle(sourceEl);
    const fill = computed.getPropertyValue('fill');
    const stroke = computed.getPropertyValue('stroke');
    const color = computed.getPropertyValue('color');
    const stopColor = computed.getPropertyValue('stop-color');
    const opacity = computed.getPropertyValue('opacity');
    if (fill) cloneEl.style.fill = fill;
    if (stroke) cloneEl.style.stroke = stroke;
    if (color) cloneEl.style.color = color;
    if (stopColor) cloneEl.style.setProperty('stop-color', stopColor);
    if (opacity) cloneEl.style.opacity = opacity;
  });
}

/**
 * Rasterizes the first <svg> found inside `container` and downloads it as `${fileName}.png`,
 * preserving the chart's actual theme colors (see inlineComputedColors above) and using the
 * page's real computed background so light/dark exports both stay readable.
 */
/** Text drawn on top of the SVG in the exported image (2026-11-15): what a chart shows in HTML around its SVG -- a donut's
 * centre lines and its legend -- so the PNG explains itself. Colours may be CSS variables (`var(--ps-…)`). */
export interface ImageExtras {
  /** Lines centred on the SVG, top to bottom (e.g. "Won / Lost Ratio", "1.16 : 1", "Win rate 53.6%"). */
  centerLines?: { text: string; size: number; bold?: boolean; muted?: boolean }[];
  /** Rows under the chart: a colour dot, the label left, the value right. */
  legend?: { color?: string; label: string; value: string; bold?: boolean }[];
}

function resolveColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  const m = /^var\((--[^,)]+)/.exec(color.trim());
  if (!m) return color;
  return window.getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || fallback;
}

function drawExtras(ctx: CanvasRenderingContext2D, extras: ImageExtras, width: number, chartHeight: number) {
  const text = resolveColor('var(--ps-color-text)', '#e5e7eb');
  const muted = resolveColor('var(--ps-color-muted-text)', '#9ca3af');
  const font = (size: number, bold?: boolean) => `${bold ? 700 : 400} ${size}px system-ui, -apple-system, 'Segoe UI', Arial, sans-serif`;
  const lines = extras.centerLines ?? [];
  if (lines.length) {
    const gap = 4;
    const block = lines.reduce((t, l) => t + l.size, 0) + gap * (lines.length - 1);
    let y = chartHeight / 2 - block / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const l of lines) {
      ctx.font = font(l.size, l.bold);
      ctx.fillStyle = l.muted ? muted : text;
      ctx.fillText(l.text, width / 2, y);
      y += l.size + gap;
    }
  }
  const rows = extras.legend ?? [];
  let y = chartHeight + 12;
  for (const r of rows) {
    ctx.textBaseline = 'middle';
    if (r.color) {
      ctx.fillStyle = resolveColor(r.color, muted);
      ctx.beginPath();
      ctx.arc(24, y + 10, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = font(13, r.bold);
    ctx.fillStyle = text;
    ctx.textAlign = 'left';
    ctx.fillText(r.label, 38, y + 10);
    ctx.textAlign = 'right';
    ctx.fillText(r.value, width - 16, y + 10);
    y += 24;
  }
}

/** Extra height the legend rows need under the chart. */
const extrasHeight = (extras?: ImageExtras) => (extras?.legend?.length ? extras.legend.length * 24 + 20 : 0);

export async function exportSvgAsImage(container: HTMLElement | null, fileName: string, extras?: ImageExtras): Promise<void> {
  if (!container) return;
  if (!(await authorizeExport('image'))) return;
  const svg = container.querySelector('svg');
  if (!svg) return;
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    inlineComputedColors(svg, clone);

    const bg = window.getComputedStyle(document.body).getPropertyValue('background-color') || '#ffffff';
    const serialized = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const width = svg.clientWidth || 800;
      const heightPx = svg.clientHeight || 400;
      const canvas = document.createElement('canvas');
      const totalHeight = heightPx + extrasHeight(extras);
      canvas.width = width * 2;
      canvas.height = totalHeight * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(2, 2);
      ctx.fillStyle = bg || '#ffffff';
      ctx.fillRect(0, 0, width, totalHeight);
      ctx.drawImage(img, 0, 0, width, heightPx);
      if (extras) drawExtras(ctx, extras, width, heightPx);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${fileName}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      });
    };
    img.src = url;
  } catch {
    // Export is a convenience action, not core functionality -- fail silently rather than
    // surfacing a console-only error to the whole dashboard.
  }
}

/** A share bar (a thin bar split into parts, with a legend) drawn straight onto a PNG (2026-11-15): the bar is HTML, not
 * an SVG, so it is redrawn here -- title, bar, then the legend wrapping onto as many lines as it needs. Arabic names are
 * laid out right-to-left; the numbers stay left-to-right after them. */
export async function exportShareBarAsImage(opts: {
  title: string;
  subtitle?: string;
  items: { label: string; detail: string; share: number; color: string }[];
  fileName: string;
  width?: number;
}): Promise<void> {
  if (!(await authorizeExport('image'))) return;
  try {
    const width = opts.width ?? 1000;
    const pad = 24;
    const font = (size: number, weight = 400) => `${weight} ${size}px system-ui, -apple-system, 'Segoe UI', Tahoma, Arial, sans-serif`;
    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) return;
    const rtl = (t: string) => /^[^A-Za-z0-9]*[\u0590-\u08FF]/.test(t);
    // legend layout: entries flow left to right and wrap
    type Entry = { x: number; y: number; labelW: number; item: (typeof opts.items)[number] };
    const entries: Entry[] = [];
    let x = pad;
    let y = 0;
    for (const item of opts.items) {
      measure.font = font(13, 700);
      const labelW = measure.measureText(item.label).width;
      measure.font = font(13);
      const w = 14 + labelW + 6 + measure.measureText(item.detail).width;
      if (x > pad && x + w > width - pad) { x = pad; y += 24; }
      entries.push({ x, y, labelW, item });
      x += w + 22;
    }
    const titleH = 24 + (opts.subtitle ? 20 : 0);
    const barY = pad + titleH + 8;
    const legendY = barY + 14 + 18;
    const height = legendY + y + 24 + pad;

    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(2, 2);
    ctx.fillStyle = window.getComputedStyle(document.body).getPropertyValue('background-color') || '#ffffff';
    ctx.fillRect(0, 0, width, height);
    const text = resolveColor('var(--ps-color-text)', '#e5e7eb');
    const muted = resolveColor('var(--ps-color-muted-text)', '#9ca3af');
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = text;
    ctx.font = font(16, 700);
    ctx.fillText(opts.title, pad, pad);
    if (opts.subtitle) { ctx.fillStyle = muted; ctx.font = font(12.5); ctx.fillText(opts.subtitle, pad, pad + 24); }

    // the bar: 2 px gaps, every part at least 4 px, rounded ends
    const barW = width - pad * 2;
    const gaps = 2 * (opts.items.length - 1);
    const total = opts.items.reduce((t, i) => t + i.share, 0) || 1;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(pad, barY, barW, 10, 5);
    ctx.clip();
    let bx = pad;
    for (const item of opts.items) {
      const w = Math.max(4, ((barW - gaps) * item.share) / total);
      ctx.fillStyle = resolveColor(item.color, muted);
      ctx.fillRect(bx, barY, w, 10);
      bx += w + 2;
    }
    ctx.restore();

    ctx.textBaseline = 'middle';
    for (const e of entries) {
      const cy = legendY + e.y + 8;
      ctx.fillStyle = resolveColor(e.item.color, muted);
      ctx.fillRect(e.x, cy - 4, 8, 8);
      ctx.font = font(13, 700);
      ctx.fillStyle = text;
      ctx.direction = rtl(e.item.label) ? 'rtl' : 'ltr';
      ctx.textAlign = rtl(e.item.label) ? 'right' : 'left';
      ctx.fillText(e.item.label, rtl(e.item.label) ? e.x + 14 + e.labelW : e.x + 14, cy);
      ctx.direction = 'ltr';
      ctx.textAlign = 'left';
      ctx.font = font(13);
      ctx.fillStyle = muted;
      ctx.fillText(e.item.detail, e.x + 14 + e.labelW + 6, cy);
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${opts.fileName}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
  } catch {
    // a convenience action: never break the page
  }
}
