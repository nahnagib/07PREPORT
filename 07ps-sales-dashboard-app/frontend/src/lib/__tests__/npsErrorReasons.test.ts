import { expect, it } from 'vitest';
import { errorPieItems } from '../nps/errorReasons';

it('maps warehouse categories to the requested short labels without losing extra errors or counts', () => {
  const keys = ['meta_temporary', 'phone_format', 'undeliverable_131026', 'ecosystem_131049', 'template_quality', 'opted_out_131050', 'other', 'new_reason'];
  const errors = keys.map((key, i) => ({ key, label: `Source ${key}`, count: i + 1, fixable: key === 'phone_format', hint: `Source cause ${key}` }));
  const result = errorPieItems(errors);
  expect(result.map((r) => r.label)).toEqual([
    'Unexpected error', 'Phone wrong', 'Message Undeliverable', 'Ecosystem Engagement', 'Quality Low',
    'Source opted_out_131050', 'Source other', 'Source new_reason',
  ]);
  expect(result.reduce((sum, item) => sum + item.count, 0)).toBe(36);
  expect(result[4].hint).toContain('Template paused by Meta');
  expect(result.every((r) => r.hint.includes(`Source cause ${r.key}`))).toBe(true);
  expect(new Set(result.slice(0, 5).map((r) => r.color)).size).toBe(5);
});
