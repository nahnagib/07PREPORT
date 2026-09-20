import type { CommitResult, Preview, TableId } from './marcomApi';

/**
 * Pure state machine for the MARCOM upload screen. The page component only dispatches events into
 * this reducer and renders its state, so every transition (including the awkward ones -- a commit
 * that fails because the staged upload expired) is unit-tested without a DOM.
 *
 *   idle -> validating -> preview -> committing -> success
 *                 \-> failed          \-> failed (keeps the preview, can go back)
 *                                      \-> expired (staged upload gone: re-upload)
 */
export type UploadState =
  | { status: 'idle'; notice?: string }
  | { status: 'validating'; filename: string; progress: number }
  | { status: 'preview'; preview: Preview; confirmedBrands: boolean; tab: TableId | 'all' }
  | { status: 'committing'; preview: Preview; confirmedBrands: boolean; tab: TableId | 'all' }
  | { status: 'success'; result: CommitResult; filename: string }
  | { status: 'failed'; message: string; code?: string; preview?: Preview }
  | { status: 'expired'; message: string };

export type UploadEvent =
  | { type: 'FILE_REJECTED'; message: string }
  | { type: 'FILE_SELECTED'; filename: string }
  | { type: 'PROGRESS'; progress: number }
  | { type: 'VALIDATED'; preview: Preview }
  | { type: 'VALIDATE_FAILED'; message: string; code?: string }
  | { type: 'TOGGLE_BRANDS'; value: boolean }
  | { type: 'SELECT_TAB'; tab: TableId | 'all' }
  | { type: 'COMMIT_STARTED' }
  | { type: 'COMMITTED'; result: CommitResult }
  | { type: 'COMMIT_FAILED'; message: string; code?: string }
  | { type: 'BACK_TO_PREVIEW' }
  | { type: 'RESET' };

export const initialUploadState: UploadState = { status: 'idle' };

/** Server codes meaning "this staged upload can no longer be committed -- upload again". */
const EXPIRED_CODES = new Set(['STAGED_EXPIRED', 'STAGED_NOT_FOUND', 'STAGED_CONSUMED', 'FILE_CHANGED']);

/** Confirm is enabled only with 0 errors, something to import, and the new-brands box ticked (when shown). */
export function canConfirm(state: UploadState): boolean {
  if (state.status !== 'preview') return false;
  const p = state.preview;
  return p.errorCount === 0 && !p.nothingToImport && p.canCommit && (!p.requiresNewBrandConfirmation || state.confirmedBrands);
}

export function uploadReducer(state: UploadState, ev: UploadEvent): UploadState {
  switch (ev.type) {
    case 'RESET':
      return initialUploadState;
    case 'FILE_REJECTED':
      return state.status === 'validating' || state.status === 'committing' ? state : { status: 'idle', notice: ev.message };
    case 'FILE_SELECTED':
      // A second file while one is being validated/committed is ignored.
      if (state.status === 'validating' || state.status === 'committing') return state;
      return { status: 'validating', filename: ev.filename, progress: 0 };
    case 'PROGRESS':
      return state.status === 'validating' ? { ...state, progress: Math.max(0, Math.min(100, ev.progress)) } : state;
    case 'VALIDATED':
      if (state.status !== 'validating') return state;
      return { status: 'preview', preview: ev.preview, confirmedBrands: false, tab: 'all' };
    case 'VALIDATE_FAILED':
      return state.status === 'validating' ? { status: 'failed', message: ev.message, code: ev.code } : state;
    case 'TOGGLE_BRANDS':
      return state.status === 'preview' ? { ...state, confirmedBrands: ev.value } : state;
    case 'SELECT_TAB':
      return state.status === 'preview' ? { ...state, tab: ev.tab } : state;
    case 'COMMIT_STARTED':
      return state.status === 'preview' && canConfirm(state) ? { ...state, status: 'committing' } : state;
    case 'COMMITTED':
      return state.status === 'committing' ? { status: 'success', result: ev.result, filename: state.preview.filename } : state;
    case 'COMMIT_FAILED':
      if (state.status !== 'committing') return state;
      if (ev.code && EXPIRED_CODES.has(ev.code)) return { status: 'expired', message: ev.message };
      return { status: 'failed', message: ev.message, code: ev.code, preview: state.preview };
    case 'BACK_TO_PREVIEW':
      return state.status === 'failed' && state.preview
        ? { status: 'preview', preview: state.preview, confirmedBrands: false, tab: 'all' }
        : state;
  }
}
