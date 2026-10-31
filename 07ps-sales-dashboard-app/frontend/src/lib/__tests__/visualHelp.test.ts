import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { VISUAL_HELP } from '../visualHelp';
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
describe('visual help registry', () => {
  it('contains a nonempty definition for every entry', () => {
    for (const entry of Object.values(VISUAL_HELP)) expect(entry.help.definition.trim().length).toBeGreaterThan(10);
  });
  it('contains every literal visual id used by pages and components', () => {
    for (const file of walk(path.resolve('src')).filter(f => f.endsWith('.tsx'))) {
      const text = readFileSync(file,'utf8');
      for (const match of text.matchAll(/\bvh\(['"]([^'"]+)['"]\)/g)) expect(VISUAL_HELP, `${file}: ${match[1]}`).toHaveProperty(match[1]);
    }
  });
});
