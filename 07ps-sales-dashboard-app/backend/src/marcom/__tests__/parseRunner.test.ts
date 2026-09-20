import { describe, expect, it } from 'vitest';
import { ParseTimeoutError, withTimeout } from '../parseRunner';

describe('withTimeout', () => {
  it('rejects with ParseTimeoutError when the work never settles, and calls the cancel hook', async () => {
    let cancelled = false;
    await expect(withTimeout(new Promise(() => undefined), 20, () => { cancelled = true; })).rejects.toBeInstanceOf(ParseTimeoutError);
    expect(cancelled).toBe(true);
  });
  it('passes through results and errors that arrive in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('x')), 1000)).rejects.toThrow('x');
  });
});
