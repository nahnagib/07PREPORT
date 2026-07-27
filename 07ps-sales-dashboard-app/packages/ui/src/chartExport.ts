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
export function exportSvgAsImage(container: HTMLElement | null, fileName: string): void {
  if (!container) return;
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
      canvas.width = width * 2;
      canvas.height = heightPx * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(2, 2);
      ctx.fillStyle = bg || '#ffffff';
      ctx.fillRect(0, 0, width, heightPx);
      ctx.drawImage(img, 0, 0, width, heightPx);
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
