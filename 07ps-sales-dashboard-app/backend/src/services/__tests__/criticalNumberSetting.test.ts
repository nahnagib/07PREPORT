import { describe, expect, it } from 'vitest';
import { readCriticalNumber, validateCriticalNumber } from '../criticalNumberSetting';
import type { Pool } from 'mysql2/promise';
describe('daily critical number setting', () => {
  it('reads the saved base and falls back only for a missing migration', async () => {
    expect(await readCriticalNumber({ query: async () => [[{numeric_value: '620000.50'}]] } as unknown as Pool)).toBe(620000.5);
    expect(await readCriticalNumber({ query: async () => { throw {code:'ER_NO_SUCH_TABLE'}; } } as unknown as Pool)).toBe(560000);
    await expect(readCriticalNumber({ query: async () => { throw {code:'ECONNREFUSED'}; } } as unknown as Pool)).rejects.toEqual({code:'ECONNREFUSED'});
  });
  it('rejects invalid amounts', () => { for (const value of [null,'500',0,-1,Infinity,1.001]) expect(() => validateCriticalNumber(value)).toThrow(); expect(validateCriticalNumber(560000)).toBe(560000); });
});
