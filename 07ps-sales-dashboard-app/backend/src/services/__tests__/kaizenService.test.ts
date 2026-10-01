import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pool', () => ({ pool: { query: vi.fn() } }));

import { KaizenValidationError, buildCardWhere, validateCardValues, type CardInput } from '../kaizenService';
import { getRegistryEntry, normalizePageActions } from '../../config/permissionRegistry';

const valid: CardInput = {
  creatorName: '  Employee A ',
  cardDate: '2026-09-10',
  departmentId: 1,
  cardName: 'Printer offline',
  cardTypeId: 5,
  issue: 'The printer is offline.',
  priorityId: 8,
  status: 'OPEN',
};

function codeOf(input: CardInput): string | null {
  try {
    validateCardValues(input);
    return null;
  } catch (err) {
    if (err instanceof KaizenValidationError) return err.code;
    throw err;
  }
}

describe('validateCardValues', () => {
  it('accepts a minimal Open card, trims text and nulls empty optionals', () => {
    const v = validateCardValues({ ...valid, rootCause: '   ', responsibleParty: '' });
    expect(v.creator_name).toBe('Employee A');
    expect(v.root_cause).toBeNull();
    expect(v.responsible_party).toBeNull();
    expect(v.status).toBe('OPEN');
    expect(v.closer_date).toBeNull();
  });

  it('defaults Status to Open', () => {
    expect(validateCardValues({ ...valid, status: undefined }).status).toBe('OPEN');
  });

  it.each([
    ['creatorName', 'card.creatorRequired'],
    ['cardDate', 'card.dateRequired'],
    ['cardName', 'card.nameRequired'],
    ['departmentId', 'card.departmentRequired'],
    ['cardTypeId', 'card.typeRequired'],
    ['priorityId', 'card.priorityRequired'],
    ['issue', 'card.issueRequired'],
  ])('requires %s', (field, code) => {
    expect(codeOf({ ...valid, [field]: '' })).toBe(code);
  });

  it('rejects a Closed card without a Closer Date', () => {
    expect(codeOf({ ...valid, status: 'CLOSED' })).toBe('card.closerRequired');
  });

  it('rejects a Closer Date before the card Date', () => {
    expect(codeOf({ ...valid, status: 'CLOSED', closerDate: '2026-09-09' })).toBe('card.closerBeforeDate');
  });

  it('accepts a Closer Date on the card Date', () => {
    expect(codeOf({ ...valid, status: 'CLOSED', closerDate: '2026-09-10' })).toBeNull();
  });

  it('rejects a Closer Date on an Open card', () => {
    expect(codeOf({ ...valid, closerDate: '2026-09-12' })).toBe('card.closerOnlyWhenClosed');
  });

  it('rejects an Expected Date before the card Date', () => {
    expect(codeOf({ ...valid, expectedDate: '2026-09-01' })).toBe('card.expectedBeforeDate');
  });

  it('rejects impossible dates and unknown statuses', () => {
    expect(codeOf({ ...valid, cardDate: '2026-02-30' })).toBe('card.dateInvalid');
    expect(codeOf({ ...valid, status: 'PENDING' })).toBe('card.statusInvalid');
  });
});

describe('buildCardWhere', () => {
  it('always excludes soft-deleted cards', () => {
    expect(buildCardWhere({}).where).toBe('WHERE c.deleted_at IS NULL');
  });

  it('treats an empty Responsible Party filter as "(Not assigned)"', () => {
    expect(buildCardWhere({ responsibleParty: '' }).where).toContain('c.responsible_party IS NULL');
  });

  it('escapes LIKE wildcards in search and also matches a #number', () => {
    const { where, params } = buildCardWhere({ search: '#7' });
    expect(where).toContain('c.card_no = ?');
    expect(params).toContain(7);
    expect(buildCardWhere({ search: '50%' }).params[0]).toBe('%50\\%%');
  });
});

describe('Kaizen permission registry', () => {
  it('registers the board as a report and the cards page with every entry action', () => {
    expect(getRegistryEntry('kaizen_board')?.actions).toEqual(['view', 'export']);
    expect(getRegistryEntry('kaizen_cards')?.actions).toEqual(['view', 'create', 'edit', 'delete', 'export']);
  });

  it('adds View to any other Kaizen Cards action', () => {
    expect(normalizePageActions('kaizen_cards', ['edit'])).toEqual(['view', 'edit']);
  });
});
