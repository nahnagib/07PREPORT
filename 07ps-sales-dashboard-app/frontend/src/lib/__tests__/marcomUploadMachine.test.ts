import { describe, expect, it } from 'vitest';
import { canConfirm, initialUploadState, uploadReducer, type UploadEvent, type UploadState } from '../marcomUploadMachine';
import type { CommitResult } from '../marcomApi';
import { makePreview } from './fixtures';

const RESULT: CommitResult = {
  batchId: 3, period: null, totals: { inserted: 5, updated: 0, unchanged: 0, examplesSkipped: 7 }, tables: [], newBrandsCreated: [],
};

const run = (events: UploadEvent[], from: UploadState = initialUploadState) => events.reduce(uploadReducer, from);
const toPreview = (p = makePreview()) => run([{ type: 'FILE_SELECTED', filename: 'feb.xlsx' }, { type: 'VALIDATED', preview: p }]);

describe('upload state machine', () => {
  it('idle -> validating -> preview, tracking progress', () => {
    let s = run([{ type: 'FILE_SELECTED', filename: 'feb.xlsx' }]);
    expect(s).toEqual({ status: 'validating', filename: 'feb.xlsx', progress: 0 });
    s = run([{ type: 'PROGRESS', progress: 55 }], s);
    expect(s).toMatchObject({ status: 'validating', progress: 55 });
    s = run([{ type: 'PROGRESS', progress: 900 }], s);
    expect(s).toMatchObject({ progress: 100 });
    s = run([{ type: 'VALIDATED', preview: makePreview() }], s);
    expect(s).toMatchObject({ status: 'preview', confirmedBrands: false, tab: 'all' });
  });

  it('a rejected file stays idle and carries the notice; the next valid file clears it', () => {
    const s = run([{ type: 'FILE_REJECTED', message: 'Only .xlsx' }]);
    expect(s).toEqual({ status: 'idle', notice: 'Only .xlsx' });
    expect(run([{ type: 'FILE_SELECTED', filename: 'a.xlsx' }], s).status).toBe('validating');
  });

  it('validation failure -> failed (with the server code), then reset', () => {
    const s = run([{ type: 'FILE_SELECTED', filename: 'x.xlsx' }, { type: 'VALIDATE_FAILED', message: 'bad zip', code: 'INVALID_FILE' }]);
    expect(s).toEqual({ status: 'failed', message: 'bad zip', code: 'INVALID_FILE', preview: undefined });
    expect(run([{ type: 'RESET' }], s)).toEqual(initialUploadState);
  });

  it('ignores a second file while validating or committing', () => {
    const validating = run([{ type: 'FILE_SELECTED', filename: 'a.xlsx' }]);
    expect(run([{ type: 'FILE_SELECTED', filename: 'b.xlsx' }], validating)).toBe(validating);
    const committing = run([{ type: 'COMMIT_STARTED' }], toPreview());
    expect(committing.status).toBe('committing');
    expect(run([{ type: 'FILE_SELECTED', filename: 'b.xlsx' }], committing)).toBe(committing);
  });

  describe('preview with errors', () => {
    const s = toPreview(makePreview({ errorCount: 2, canCommit: false }));
    it('cannot be confirmed and COMMIT_STARTED is a no-op', () => {
      expect(canConfirm(s)).toBe(false);
      expect(run([{ type: 'COMMIT_STARTED' }], s)).toBe(s);
    });
  });

  describe('clean preview', () => {
    it('can be confirmed -> committing -> success', () => {
      const s = toPreview();
      expect(canConfirm(s)).toBe(true);
      const committing = run([{ type: 'COMMIT_STARTED' }], s);
      expect(committing.status).toBe('committing');
      expect(canConfirm(committing)).toBe(false); // no double-submit
      const done = run([{ type: 'COMMITTED', result: RESULT }], committing);
      expect(done).toEqual({ status: 'success', result: RESULT, filename: 'feb.xlsx' });
    });
  });

  describe('new brands', () => {
    const p = makePreview({ newBrands: ['Brand Z'], requiresNewBrandConfirmation: true });
    it('needs the checkbox before Confirm is enabled', () => {
      let s = toPreview(p);
      expect(canConfirm(s)).toBe(false);
      expect(run([{ type: 'COMMIT_STARTED' }], s)).toBe(s);
      s = run([{ type: 'TOGGLE_BRANDS', value: true }], s);
      expect(canConfirm(s)).toBe(true);
      expect(canConfirm(run([{ type: 'TOGGLE_BRANDS', value: false }], s))).toBe(false);
    });
  });

  it('nothing to import: never confirmable', () => {
    const s = toPreview(makePreview({ nothingToImport: true, canCommit: false, totals: { insert: 0, update: 0, unchanged: 0, examplesSkipped: 7 } }));
    expect(canConfirm(s)).toBe(false);
    expect(run([{ type: 'COMMIT_STARTED' }], s)).toBe(s);
  });

  describe('commit failures', () => {
    const committing = () => run([{ type: 'COMMIT_STARTED' }], toPreview());
    it.each(['STAGED_EXPIRED', 'STAGED_NOT_FOUND', 'STAGED_CONSUMED', 'FILE_CHANGED'])('%s -> expired (re-upload)', (code) => {
      expect(run([{ type: 'COMMIT_FAILED', message: 'gone', code }], committing())).toEqual({ status: 'expired', message: 'gone' });
    });
    it('other failures keep the preview so the user can go back', () => {
      const failed = run([{ type: 'COMMIT_FAILED', message: 'network', code: 'NETWORK' }], committing());
      expect(failed).toMatchObject({ status: 'failed', message: 'network', code: 'NETWORK' });
      const back = run([{ type: 'BACK_TO_PREVIEW' }], failed);
      expect(back).toMatchObject({ status: 'preview', confirmedBrands: false });
      expect(canConfirm(back)).toBe(true);
    });
    it('a commit failure outside committing is ignored', () => {
      const s = toPreview();
      expect(run([{ type: 'COMMIT_FAILED', message: 'x', code: 'STAGED_EXPIRED' }], s)).toBe(s);
    });
  });

  it('tab selection only applies to a preview', () => {
    expect(run([{ type: 'SELECT_TAB', tab: 'spend' }], toPreview())).toMatchObject({ tab: 'spend' });
    expect(run([{ type: 'SELECT_TAB', tab: 'spend' }])).toEqual(initialUploadState);
  });
});
