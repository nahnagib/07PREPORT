/**
 * Regression check for the Gauge center text-overlap bug (design-quality pass, this session).
 *
 * No headless browser (Puppeteer/Playwright/Chromium) is available in this environment, so this
 * isn't a pixel-level screenshot diff -- it's the DOM-structural equivalent: it renders the actual
 * Gauge component via ReactDOMServer, parses the resulting SVG, and asserts the specific
 * conditions that produced the bug can't reappear silently:
 *
 *   1. Exactly ONE <text> node exists inside the gauge SVG (the old bug was two separate
 *      "number" renderers - one inside Gauge, one in GaugeCard - occupying the same space).
 *   2. That text node's y-coordinate is safely inside the SVG's own viewBox bounds, with a margin
 *      (the old bug's y=128 exceeded a 124-tall viewBox entirely).
 *   3. The text node's content is exactly the formatted `valueLabel` passed in, not the raw
 *      unformatted `actual` number (confirms Gauge is rendering the caller's label, not silently
 *      falling back and creating a second, differently-formatted string next to it).
 *
 * Run with: node --experimental-strip-types Gauge.regression.test.tsx  (or via ts-node/tsx)
 * A real headless-browser pixel diff (Percy/Chromatic/Playwright) would be a strictly better
 * follow-up and is flagged as such in this session's status note -- not silently substituted here.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Gauge } from '../Gauge';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`REGRESSION CHECK FAILED: ${message}`);
  }
  console.log(`OK: ${message}`);
}

function extractViewBoxHeight(svgMarkup: string): number {
  const match = svgMarkup.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!match) throw new Error('Could not find viewBox in rendered SVG');
  return parseFloat(match[2]);
}

function extractTextNodes(svgMarkup: string): { y: number; content: string }[] {
  const results: { y: number; content: string }[] = [];
  const re = /<text[^>]*\by="([\d.]+)"[^>]*>([^<]*)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svgMarkup)) !== null) {
    results.push({ y: parseFloat(m[1]), content: m[2] });
  }
  return results;
}

function runCase(name: string, props: Parameters<typeof Gauge>[0]) {
  console.log(`\n--- ${name} ---`);
  const markup = renderToStaticMarkup(<Gauge {...props} />);
  const viewBoxHeight = extractViewBoxHeight(markup);
  const textNodes = extractTextNodes(markup);

  assert(textNodes.length === 1, `exactly one <text> node rendered (found ${textNodes.length})`);

  const [text] = textNodes;
  const margin = 4;
  assert(
    text.y <= viewBoxHeight - margin,
    `value label y=${text.y} is within the viewBox height (${viewBoxHeight}), with >= ${margin}px margin`,
  );
  assert(text.y > 0, `value label y=${text.y} is a positive coordinate`);

  if (props.valueLabel) {
    assert(
      text.content === props.valueLabel,
      `rendered text ("${text.content}") matches the passed-in formatted valueLabel ("${props.valueLabel}")`,
    );
  }
}

// Case 1: the exact shape of data that produced the original bug report (a real gauge card with
// both an actual value and a formatted reference label).
runCase('with target + formatted valueLabel (the reported bug scenario)', {
  actual: 531584,
  targetToDate: 620000,
  status: 'alert',
  label: 'MTD Value',
  valueLabel: 'LYD 531,584',
});

// Case 2: no target set (NO_TARGET path) - different code branch, same single-label guarantee.
runCase('no target set', {
  actual: 12000,
  targetToDate: null,
  status: 'neutral',
  label: 'YTD Volume',
  valueLabel: '12,000',
});

// Case 3: no valueLabel passed at all - falls back to the raw actual, but must still be the ONLY
// text node (a future consumer that forgets to pass valueLabel must not silently reintroduce a
// second label somewhere else).
runCase('no valueLabel provided (fallback path)', {
  actual: 42.5,
  targetToDate: 50,
  status: 'watch',
  label: 'ASP',
});

console.log('\nAll Gauge regression checks passed.');
