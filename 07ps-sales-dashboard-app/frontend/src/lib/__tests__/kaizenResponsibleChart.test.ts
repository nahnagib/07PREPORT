import { describe, expect, it } from 'vitest';
import { responsiblePoints } from '../kaizen/responsibleChart';

const labels = { others: 'Others', notAssigned: '(Not assigned)' };
const row = (name: string | null, open: number, closed: number) => ({ name, open, closed, count: open + closed });

describe('responsiblePoints', () => {
  it('keeps the API order, puts "(Not assigned)" last even when it has the most cards', () => {
    const points = responsiblePoints([row(null, 5, 4), row('Employee E', 1, 2), row('Employee F', 0, 2)], labels);
    expect(points.map((p) => p.label)).toEqual(['Employee E', 'Employee F', '(Not assigned)']);
    expect(points[2]).toMatchObject({ kind: 'unassigned', name: '', open: 5, closed: 4 });
  });

  it('shows the top 10 and folds the rest into one "Others" bar before "(Not assigned)"', () => {
    const people = Array.from({ length: 13 }, (_, i) => row(`Person ${i + 1}`, 13 - i, 1));
    const points = responsiblePoints([...people, row(null, 1, 0)], labels);
    expect(points).toHaveLength(12);
    expect(points.slice(0, 10).map((p) => p.label)).toEqual(people.slice(0, 10).map((p) => p.name));
    expect(points[10]).toMatchObject({ label: 'Others', kind: 'others', parties: 3, open: 3 + 2 + 1, closed: 3 });
    expect(points[11].label).toBe('(Not assigned)');
  });

  it('adds no "Others" bar with 10 or fewer parties, and no "(Not assigned)" bar when every card has one', () => {
    const points = responsiblePoints(Array.from({ length: 10 }, (_, i) => row(`P${i}`, 1, 0)), labels);
    expect(points.every((p) => p.kind === 'person')).toBe(true);
  });
});
