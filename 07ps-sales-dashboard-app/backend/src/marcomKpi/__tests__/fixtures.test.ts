import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildFrontendFixtures } from './frontendFixtures';

const dir = path.resolve(__dirname, '..', '..', '..', '..', 'frontend', 'src', 'components', 'marcom', '__fixtures__');

/** The frontend page tests read committed JSON fixtures; this keeps them identical to what the real builders produce. */
describe('frontend fixtures are in sync with the KPI builders', () => {
  const fixtures = buildFrontendFixtures();
  it('has a committed file for every fixture and no stray files', () => {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
    expect(files).toEqual(Object.keys(fixtures).map((k) => `${k}.json`).sort());
  });
  it.each(Object.keys(fixtures))('%s', (name) => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(fixtures[name])));
  });
});
