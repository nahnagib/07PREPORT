import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CITY_COORDS, MAP_H, MAP_W, project } from '../libyaMap';

/** Every city the template offers (backend CITIES) must be placeable on the map, inside Libya's frame. */
describe('Libya city map', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..', 'backend', 'src', 'marcom', 'templateConfig.ts'), 'utf8');
  const block = /export const CITIES = \[([\s\S]*?)\] as const/.exec(src)![1];
  const cities = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  it('has coordinates for every template city, and no extras', () => {
    expect(cities.length).toBeGreaterThan(10);
    expect(Object.keys(CITY_COORDS).sort()).toEqual([...cities].sort());
  });
  it('projects every city inside the map frame', () => {
    for (const [lat, lon] of Object.values(CITY_COORDS)) {
      const [x, y] = project(lon, lat);
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(MAP_W);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(MAP_H);
    }
  });
  it('Tripoli is west of Benghazi, Sabha south of both', () => {
    const [tx, ty] = project(CITY_COORDS.Tripoli[1], CITY_COORDS.Tripoli[0]);
    const [bx] = project(CITY_COORDS.Benghazi[1], CITY_COORDS.Benghazi[0]);
    const [, sy] = project(CITY_COORDS.Sabha[1], CITY_COORDS.Sabha[0]);
    expect(tx).toBeLessThan(bx);
    expect(sy).toBeGreaterThan(ty);
  });
});
