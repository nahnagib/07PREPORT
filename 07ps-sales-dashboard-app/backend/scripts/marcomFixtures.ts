/**
 * Writes the frontend test fixtures (API-shaped payloads built by the real KPI builders):
 *   npm run marcom:fixtures --workspace backend
 * Pure -- no database needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildFrontendFixtures } from '../src/marcomKpi/__tests__/frontendFixtures';

const dir = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'marcom', '__fixtures__');
fs.mkdirSync(dir, { recursive: true });
const fixtures = buildFrontendFixtures();
for (const [name, payload] of Object.entries(fixtures)) {
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(payload, null, 1)}\n`);
}
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${dir}`);
