import type { Preview } from '../marcomApi';

export function makePreview(over: Partial<Preview> = {}): Preview {
  return {
    stagedUploadId: '11111111-1111-4111-8111-111111111111', expiresAt: '2026-09-20T12:00:00.000Z', filename: 'feb.xlsx',
    fileHash: 'abc', templateVersion: '1.0', period: { from: '2026-02', to: '2026-02', label: 'February 2026' }, tables: [],
    totals: { insert: 5, update: 0, unchanged: 0, examplesSkipped: 7 }, newBrands: [], issues: [], errorCount: 0, warningCount: 0,
    duplicateOf: null, requiresNewBrandConfirmation: false, nothingToImport: false, canCommit: true, ...over,
  };
}
